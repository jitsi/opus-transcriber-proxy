import { createHash, timingSafeEqual } from 'node:crypto';
import { AgentLifecycleState, AgentStatusReporter } from './agent/AgentStatusReporter';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config, getAvailableProviders, getDefaultProvider, isValidProvider, isProviderAvailable, type Provider } from './config';
import { extractSessionParameters, type ISessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { TranslatorProxy } from './translatorproxy';
import { AgentProxy } from './agentproxy';
import { assertPublicEndpointHost } from './agent/endpointGuard';
import { normalizeTargetLanguage } from './TranslatorConnection';
import { createNodeTranslationRuntime } from './translate/nodeRuntime';
import { buildTranslationMediaMessage, buildTranslationTalkStartMessage, buildTranslationTalkStopMessage, buildTranslationTranscriptMessage, type TranslationTalkStartData, type TranslationTalkStopData } from './translate/messages';
import type { IWebSocket } from './translate/runtime';
import type { TextTranslationMessage } from './textTranslate/messages';
import {
	getAvailableTextTranslationProviders,
	getDefaultTextTranslationProvider,
	isTextTranslationProviderAvailable,
	isValidTextTranslationProvider,
	type TextTranslationProvider,
} from './textTranslate/factory';
import { setMetricDebug, writeMetric } from './metrics';
import logger, { addOtlpTransport } from './logger';
import { sessionManager } from './SessionManager';
import { flushTranslationUsage } from './usage-reporter';
import { initTelemetry, initTelemetryLogs, shutdownTelemetry, shutdownTelemetryLogs, isTelemetryEnabled } from './telemetry';
import { getInstruments } from './telemetry/instruments';

// Initialize OpenTelemetry (must be before other initialization)
initTelemetry();
initTelemetryLogs();
addOtlpTransport(isTelemetryEnabled());

// Initialize metric debug logging
setMetricDebug(config.debug);

// Create HTTP server
const server = http.createServer((req, res) => {
	// Log all incoming requests for debugging
	logger.debug(`HTTP ${req.method} ${req.url}`);
	logger.debug('Headers:', JSON.stringify(req.headers, null, 2));

	if (req.url === '/health') {
		res.writeHead(200);
		res.end('OK');
		return;
	}
	// Live session counts, used by the container's Durable Object (onActivityExpired)
	// to decide whether to keep the container alive or let it sleep. WebSocket frames
	// bypass the Container class so its activity timer doesn't see them; this lets the
	// DO renew the timer only while a call is actually in progress.
	if (req.url === '/status') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(sessionManager.getStats()));
		return;
	}
	res.writeHead(426, { 'Content-Type': 'text/plain' });
	res.end('Upgrade Required: Expected WebSocket connection');
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Active /translate proxies. Unlike transcription sessions (tracked by sessionManager), translation
// proxies are created inline, so track them here for graceful shutdown: SIGTERM closes them so each
// direction flushes its final usage delta into the reporter buffer before we drain it.
const activeTranslateSessions = new Set<TranslatorProxy>();

// Active /agent proxies, tracked for graceful shutdown like the translation proxies.
const activeAgentSessions = new Set<AgentProxy>();

/** The customer endpoint an /agent connection should dial, resolved from the connect's header/params. */
interface AgentEndpoint {
	url: string;
	headers: Record<string, string>;
	/** Query params other than the gateway's own (jicofo's urlParams), echoed to the customer as customParameters. */
	customParameters?: Record<string, unknown>;
	/** The room JID and agent id jicofo puts on the dial URL, for lifecycle reports to the provisioning API. */
	conference?: string;
	agentId?: string;
}

/**
 * Resolve and validate the customer endpoint for an /agent connection: the `X-Agent-Endpoint`
 * header (forwarded by the bridge from the jicofo connect config) or, for dev, an `?endpoint=`
 * query param. Returns an error string (for the 400 response) when missing or invalid.
 */
const agentStatusReporter = new AgentStatusReporter({
	url: config.agent.statusUrl,
	token: config.agent.statusToken,
	host: config.agent.statusHost,
	logger,
});
if (config.enableAgent && !agentStatusReporter.enabled) {
	logger.warn('AGENT_STATUS_URL is not set: agent lifecycle (active/failed/ended) is not reported to the provisioning API.');
}

/** Query parameters the gateway consumes itself (see utils.ts), never echoed to the customer. */
const GATEWAY_QUERY_PARAMS = new Set([ 'agentId', 'conference', 'connect', 'deepgram_mip_opt_out', 'encoding', 'endpoint', 'endpointing', 'lang', 'openaiCustomUrl', 'provider', 'sendBack', 'sendBackInterim', 'sessionId', 'smart_turn', 'smart_turn_timeout', 'tag', 'text_translation_provider', 'useDispatcher', 'xai_granular_finals', 'xai_granular_guard_words', 'xai_granular_stability_ms' ]);

/** Constant-time secret comparison; hashing first hides the length difference too. */
function secretsEqual(a: string, b: string): boolean {
	return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function resolveAgentEndpoint(url: URL, headers: http.IncomingHttpHeaders): AgentEndpoint | string {
	const rawHeader = headers['x-agent-endpoint'];

	// The ?endpoint= query param is a dev convenience only: it would let anyone reaching the proxy pick the
	// dial-out target, so it is honored solely when explicitly enabled (AGENT_ALLOW_ENDPOINT_PARAM=true).
	const rawParam = config.agent.allowEndpointParam ? url.searchParams.get('endpoint') : null;
	const raw = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader) ?? rawParam ?? '';
	if (raw === '') {
		return 'Missing agent endpoint (X-Agent-Endpoint header)';
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return 'Invalid agent endpoint URL';
	}
	if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && !config.agent.requireWss)) {
		return 'Agent endpoint must be wss:// (set AGENT_REQUIRE_WSS=false to allow ws:// in dev)';
	}
	const rawAuth = headers['x-agent-authorization'];
	const authorization = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;

	// Only jicofo's urlParams are the customer's; the gateway's own knobs never leave the proxy.
	const customParameters: Record<string, unknown> = {};
	url.searchParams.forEach((value, key) => {
		if (!GATEWAY_QUERY_PARAMS.has(key)) {
			customParameters[key] = value;
		}
	});

	const conference = url.searchParams.get('conference') ?? undefined;
	const agentId = url.searchParams.get('agentId') ?? undefined;

	return {
		url: parsed.toString(),
		headers: authorization !== undefined ? { Authorization: authorization } : {},
		...(Object.keys(customParameters).length > 0 ? { customParameters } : {}),
		...(conference !== undefined ? { conference } : {}),
		...(agentId !== undefined ? { agentId } : {}),
	};
}

/**
 * Handles an /agent WebSocket upgrade: enforces the enable flag, the optional shared secret gating the
 * upgrade, endpoint resolution, and the SSRF guard (which resolves DNS), before accepting the socket.
 * Always closes the socket on rejection.
 */
async function handleAgentUpgrade(
		request: http.IncomingMessage,
		socket: import('stream').Duplex,
		head: Buffer,
		parameters: ISessionParameters): Promise<void> {
	const reject = (status: string, body: string, logMessage: string) => {
		logger.error(`Rejecting /agent connection: ${logMessage}`);
		socket.write(`HTTP/1.1 ${status}\r\n\r\n${body}`);
		socket.destroy();
	};

	if (!config.enableAgent) {
		reject('404 Not Found', 'Agent endpoint disabled', 'agent endpoint disabled');

		return;
	}

	// Shared-secret gate on the upgrade itself, so a network peer that can reach the proxy cannot trigger a
	// dial-out. Enforced only when configured; a warning is logged otherwise (deployments must keep the proxy
	// bridge-only in that case).
	if (config.agent.sharedSecret) {
		const rawToken = request.headers['x-agent-token'];
		const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

		if (token === undefined || !secretsEqual(token, config.agent.sharedSecret)) {
			reject('401 Unauthorized', 'Invalid or missing agent token', 'invalid or missing X-Agent-Token');

			return;
		}
	} else {
		logger.warn('AGENT_SHARED_SECRET is not set: the /agent upgrade is unauthenticated. Keep the proxy '
			+ 'reachable only from the bridge.');
	}

	const endpoint = resolveAgentEndpoint(parameters.url, request.headers);

	if (typeof endpoint === 'string') {
		reject('400 Bad Request', endpoint, endpoint);

		return;
	}

	// SSRF guard: reject endpoints that resolve to private/internal addresses (and enforce the optional host
	// allowlist) before dialing out.
	const ssrfError = await assertPublicEndpointHost(new URL(endpoint.url).hostname, config.agent.allowedHosts, config.agent.allowPrivateEndpoints);

	if (ssrfError) {
		reject('400 Bad Request', ssrfError, `${ssrfError} (host=${new URL(endpoint.url).hostname})`);

		return;
	}

	wss.handleUpgrade(request, socket, head, ws => {
		handleAgentConnection(ws, endpoint);
	});
}

function handleAgentConnection(ws: WebSocket, endpoint: AgentEndpoint) {
	logger.info(`New /agent connection, endpoint host=${new URL(endpoint.url).hostname}`);

	const agentSession = new AgentProxy(
		ws as unknown as IWebSocket,
		{
			endpointUrl: endpoint.url,
			// The `ws` client here (not the runtime's OpenAI-shaped factory) so the forwarded
			// Authorization header reaches the customer endpoint on the handshake.
			createEndpointWebSocket: (url) => new WebSocket(url, { headers: endpoint.headers }) as unknown as IWebSocket,
			customParameters: endpoint.customParameters,
			paceLeadMs: config.agent.paceLeadMs,
		},
		createNodeTranslationRuntime(),
	);
	activeAgentSessions.add(agentSession);

	agentSession.on('closed', () => {
		activeAgentSessions.delete(agentSession);
		if (ws.readyState === ws.OPEN) {
			ws.close();
		}
	});

	agentSession.on('error', (message: string) => {
		logger.error(`Agent session error (endpoint host=${new URL(endpoint.url).hostname}): ${message}`);
	});

	// The gateway is the only component that sees the customer leg, so it reports its lifecycle itself.
	agentSession.on('lifecycle', ({ state, reason }: { state: AgentLifecycleState; reason?: string }) => {
		if (endpoint.conference && endpoint.agentId) {
			void agentStatusReporter.report(endpoint.conference, endpoint.agentId, state, reason);
		} else if (agentStatusReporter.enabled) {
			logger.warn(`Agent lifecycle ${state} not reported: the dial URL carries no conference/agentId`);
		}
	});

	// The agent's audio and talk boundaries reuse the mediajson builders shared with /translate.
	agentSession.on(
		'audioFrame',
		(data: {
			tag: string;
			chunk: number;
			timestamp: number;
			payload: string;
			audioLevel?: number;
			vad?: boolean;
			sequenceNumber: number;
		}) => {
			try {
				ws.send(JSON.stringify(buildTranslationMediaMessage(data)));
			} catch {
				// client disconnected mid-flight; 'closed' will fire and tear down the proxy
			}
		},
	);
	agentSession.on('talkStart', (data: TranslationTalkStartData) => {
		try {
			ws.send(JSON.stringify(buildTranslationTalkStartMessage(data)));
		} catch {
			// client disconnected mid-flight; 'closed' will fire and tear down the proxy
		}
	});
	agentSession.on('talkStop', (data: TranslationTalkStopData) => {
		try {
			ws.send(JSON.stringify(buildTranslationTalkStopMessage(data)));
		} catch {
			// client disconnected mid-flight; 'closed' will fire and tear down the proxy
		}
	});
}

// Handle WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
	logger.debug('UPGRADE EVENT TRIGGERED!');
	logger.debug(`Upgrade ${request.method} ${request.url}`);
	logger.debug('Upgrade Headers:', JSON.stringify(request.headers, null, 2));

	const url = `http://${request.headers.host}${request.url}`;
	let parameters: ISessionParameters;
	try {
		parameters = extractSessionParameters(url);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${msg}`);
		socket.destroy();
		return;
	}

	logger.debug('Session parameters:', JSON.stringify(parameters));

	// Validate path
	if (
		!parameters.url.pathname.endsWith('/transcribe') &&
		!parameters.url.pathname.endsWith('/translate') &&
		!parameters.url.pathname.endsWith('/agent')
	) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\nBad URL');
		socket.destroy();
		return;
	}

	// Handle the /agent endpoint separately (voice-agent media relay).
	if (parameters.url.pathname.endsWith('/agent')) {
		// Async: the SSRF guard resolves DNS. Errors are handled inside; the socket is always closed on failure.
		handleAgentUpgrade(request, socket, head, parameters).catch(error => {
			logger.error('Error handling /agent upgrade:', error);
			socket.destroy();
		});
		return;
	}

	// Translation usage token, forwarded by the JVB as an HTTP header on the connect
	// (originating from prosody room metadata). Used only to attribute reported
	// translation usage; absent on the dev/replay path. Node types headers as
	// string | string[] | undefined; collapse the (unused here) repeated-header case.
	const rawTranslationToken = request.headers['x-translation-token'];
	const translationToken = Array.isArray(rawTranslationToken) ? rawTranslationToken[0] : rawTranslationToken;

	// Handle the /translate endpoint separately (speech-to-speech translation).
	if (parameters.url.pathname.endsWith('/translate')) {
		if (!config.enableTranslate) {
			socket.write('HTTP/1.1 404 Not Found\r\n\r\nTranslation endpoint disabled');
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			handleTranslatorConnection(ws, parameters, translationToken);
		});
		return;
	}

	if (!config.enableTranscribe) {
		socket.write('HTTP/1.1 404 Not Found\r\n\r\nTranscription endpoint disabled');
		socket.destroy();
		return;
	}

	// Validate output method
	if (!parameters.sendBack && !parameters.sendBackInterim && !config.useDispatcher && !parameters.useDispatcher) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\nNo transcription output method specified');
		socket.destroy();
		return;
	}

	// Extract per-request credentials for openai_custom provider
	const openaiCustomApiKey = request.headers['x-custom-openai-api-key'] as string | undefined;

	// Accept the WebSocket upgrade
	wss.handleUpgrade(request, socket, head, (ws) => {
		handleWebSocketConnection(ws, parameters, openaiCustomApiKey);
	});
});

let wsConnectionId = 0;

/**
 * Set up WebSocket-specific event handlers (called for every connection/reconnection)
 */
function setupWebSocketEventListeners(ws: WebSocket, session: TranscriberProxy, connectionId: number, sessionId: string | undefined) {
	// Handle WebSocket close
	ws.addEventListener('close', (event) => {
		logger.info(
			`[WS-${connectionId}] Client WebSocket closed: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
		);
		clearInterval(stateCheckInterval);

		// Metrics: track WebSocket close events by code
		getInstruments().clientWebsocketCloseTotal.add(1, { code: String(event.code) });

		// Detach session instead of closing immediately (if session resumption enabled)
		if (sessionId && config.sessionResumeEnabled) {
			sessionManager.detachSession(sessionId, session, connectionId);
		} else {
			// No sessionId or resumption disabled - close immediately
			sessionManager.unregisterSession(sessionId, session);
			session.close();
		}
	});

	// Handle WebSocket error
	ws.addEventListener('error', (event) => {
		const errorMessage = 'WebSocket error';
		logger.error(`[WS-${connectionId}] Client WebSocket error:`, errorMessage, event);
		sessionManager.unregisterSession(sessionId, session);
		session.close();
		ws.close(1011, errorMessage);
	});

	// Log initial WebSocket state
	logger.debug(`[WS-${connectionId}] Connection established. readyState=${ws.readyState}`);

	// Monitor WebSocket state changes
	let lastReadyState = ws.readyState;
	const stateCheckInterval = setInterval(() => {
		if (ws.readyState !== lastReadyState) {
			logger.debug(`[WS-${connectionId}] readyState changed: ${lastReadyState} -> ${ws.readyState}`);
			lastReadyState = ws.readyState;
		}
	}, 100);
}

/**
 * Set up session event handlers (called only once for new sessions)
 * Uses parameters stored in session.options
 */
function setupSessionEventHandlers(ws: WebSocket, session: TranscriberProxy, connectionId: number, sessionId: string | undefined) {
	// Get the original parameters from the session options
	const options = session.getOptions();
	const sendBack = options.sendBack;
	const sendBackInterim = options.sendBackInterim;

	// Handle session closed event
	session.on('closed', () => {
		logger.info(`[WS-${connectionId}] Session closed event received, closing WebSocket`);
		ws.close();
	});

	// Handle session error event
	session.on('error', (tag, error) => {
		try {
			const message = `Error in session ${tag}: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(`[WS-${connectionId}] ${message}`);
			sessionManager.unregisterSession(sessionId, session);
			session.close();
			ws.close(1011, message);
		} catch (closeError) {
			// Error handlers do not themselves catch errors, so log with logger
			logger.error(
				`[WS-${connectionId}] Failed to close connections after error in session ${tag}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
			);
		}
	});

	// Handle interim transcriptions
	if (sendBackInterim) {
		session.on('interim_transcription', (data: TranscriptionMessage) => {
			logger.debug(`[WS-${connectionId}] Received interim transcription`);
			if (sendBack) {
				// Get current WebSocket (may have been reattached)
				const currentWs = session.getWebSocket();
				if (!currentWs || currentWs.readyState !== 1) {
					logger.warn(`[WS-${connectionId}] Cannot send interim: not open (readyState=${currentWs?.readyState})`);
					return;
				}
				try {
					const message = JSON.stringify(data);
					logger.debug(`[WS-${connectionId}] Sending interim for ${data.participant?.id}:`, message);
					currentWs.send(message);
					// OTel metrics: track transcription delivery
					getInstruments().transcriptionsDeliveredTotal.add(1, {
						provider: options.provider || 'unknown',
						is_interim: 'true',
					});
					logger.debug(`[WS-${connectionId}] Sent interim successfully`);
				} catch (error) {
					logger.error(`[WS-${connectionId}] Failed to send interim:`, error);
				}
			} else {
				logger.warn(`[WS-${connectionId}] Not sending interim: sendBack=${sendBack}`);
			}
		});
	}

	// Handle final transcriptions
	session.on('transcription', (data: TranscriptionMessage) => {
		logger.debug(`[WS-${connectionId}] Received final transcription`);

		// Track successful transcription
		writeMetric(undefined, {
			name: 'transcription_success',
			worker: 'opus-transcriber-proxy',
			sessionId: sessionId ?? undefined,
		});

		if (sendBack) {
			// Get current WebSocket (may have been reattached)
			const currentWs = session.getWebSocket();
			if (!currentWs || currentWs.readyState !== 1) {
				logger.warn(`[WS-${connectionId}] Cannot send final: not open (readyState=${currentWs?.readyState})`);
				return;
			}
			try {
				const message = JSON.stringify(data);
				logger.debug(`[WS-${connectionId}] Sending final for ${data.participant?.id}:`, message);
				currentWs.send(message);
				// OTel metrics: track transcription delivery
				getInstruments().transcriptionsDeliveredTotal.add(1, {
					provider: options.provider || 'unknown',
					is_interim: 'false',
				});
				logger.debug(`[WS-${connectionId}] Sent final successfully`);
			} catch (error) {
				logger.error(`[WS-${connectionId}] Failed to send final:`, error);
			}
		} else {
			logger.warn(`[WS-${connectionId}] Not sending final: sendBack=${sendBack}`);
		}

		// Note: Cross-tag context sharing is handled automatically within TranscriberProxy
		// When one tag generates a transcript, it's broadcast to other tags in the same session
	});

	// Handle text translations of finals (one event per requested target language). Gated on
	// sendBack like transcriptions; not forwarded to the dispatcher, which stores the original
	// transcript only.
	session.on('translation', (data: TextTranslationMessage) => {
		if (!sendBack) {
			return;
		}
		const currentWs = session.getWebSocket();
		if (!currentWs || currentWs.readyState !== 1) {
			logger.warn(`[WS-${connectionId}] Cannot send translation: not open (readyState=${currentWs?.readyState})`);
			return;
		}
		try {
			currentWs.send(JSON.stringify(data));
			logger.debug(`[WS-${connectionId}] Sent ${data.language} translation for ${data.participant?.id}`);
		} catch (error) {
			logger.error(`[WS-${connectionId}] Failed to send translation:`, error);
		}
	});
}

function handleTranslatorConnection(ws: WebSocket, parameters: ISessionParameters, translationToken?: string) {
	const { url } = parameters;
	const sendBack = parameters.sendBack;

	// Translation always uses the OpenAI Realtime endpoint; without a key every TranslatorConnection would fail
	// immediately, so reject the upgrade with a clear signal for operators. (config.translation.apiKey falls
	// back to OPENAI_API_KEY when OPENAI_TRANSLATION_API_KEY is unset.)
	if (!config.translation.apiKey) {
		logger.error('Rejecting /translate connection: OpenAI API key not configured');
		ws.close(1011, 'OpenAI API key not configured');
		return;
	}

	// Seed the initially-active target languages from `?lang=` for the dev/replay path only.
	// The JVB connects without `lang` and drives synthetic sources via `sources` control events.
	let initialLanguages: string[] = [];
	const langParam = url.searchParams.get('lang');
	if (langParam) {
		try {
			initialLanguages = langParam
				.split(',')
				.map((l) => l.trim())
				.filter((l) => l.length > 0)
				.map((l) => normalizeTargetLanguage(l));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`Rejecting /translate connection: ${msg}`);
			// WebSocket close reasons are capped at 123 bytes; a longer reason makes ws.close throw and leaves
			// the socket open. The full detail is already logged above.
			ws.close(1002, msg.slice(0, 123));
			return;
		}
	}

	const translateSession = new TranslatorProxy(
		ws as unknown as IWebSocket,
		{ initialLanguages, provider: parameters.provider, translationToken },
		createNodeTranslationRuntime(),
	);
	activeTranslateSessions.add(translateSession);

	translateSession.on('closed', () => {
		activeTranslateSessions.delete(translateSession);
		if (ws.readyState === ws.OPEN) {
			ws.close();
		}
	});

	translateSession.on('error', (tag: string, error: any) => {
		// A single (source, language) connection failing must not tear down the whole /translate session, which
		// carries every speaker/language. The failed connection self-removes from the proxy and the next
		// `sources` event reconciles it back open, so just log here.
		const message = `Error in translation connection ${tag}: ${error instanceof Error ? error.message : String(error)}`;
		logger.error(message);
	});

	// Monotonic per-connection counter for transcript message ids, so two events for the same tag within
	// the same millisecond can't collide (Date.now() alone would).
	let transcriptSeq = 0;
	translateSession.on('transcription', (data: { transcript: string; targetLanguage: string; tag: string; isInterim: boolean }) => {
		if (!sendBack) {
			return;
		}
		// Interim (delta) transcripts only when interim output is requested; finals always (under sendBack).
		if (data.isInterim && !parameters.sendBackInterim) {
			return;
		}
		const msg = buildTranslationTranscriptMessage(data, transcriptSeq++);
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			// ignore
		}
	});

	translateSession.on(
		'audioFrame',
		(data: {
			tag: string;
			language: string;
			chunk: number;
			timestamp: number;
			payload: string;
			audioLevel?: number;
			vad?: boolean;
			sequenceNumber: number;
		}) => {
			// Translated audio is the whole point of /translate, so it is always returned to the bridge —
			// unlike transcripts, it is NOT gated on `sendBack` (which only controls transcript emission).
			const audioMessage = buildTranslationMediaMessage(data);
			try {
				ws.send(JSON.stringify(audioMessage));
			} catch {
				// ignore
			}
		},
	);

	// Talk boundaries bracketing the translated audio, mirroring the audioFrame handler above.
	translateSession.on('talkStart', (data: TranslationTalkStartData) => {
		try {
			ws.send(JSON.stringify(buildTranslationTalkStartMessage(data)));
		} catch {
			// client disconnected mid-flight; 'closed' will fire and tear down the proxy
		}
	});
	translateSession.on('talkStop', (data: TranslationTalkStopData) => {
		try {
			ws.send(JSON.stringify(buildTranslationTalkStopMessage(data)));
		} catch {
			// client disconnected mid-flight; 'closed' will fire and tear down the proxy
		}
	});
}

export function handleWebSocketConnection(ws: WebSocket, parameters: ISessionParameters, openaiCustomApiKey?: string) {
	const { sessionId, language, provider: requestedProvider, encoding, sendBack, sendBackInterim, tags, openaiCustomUrl, deepgramMipOptOut, xaiEndpointing, xaiSmartTurn, xaiSmartTurnTimeout, xaiGranularFinals, xaiGranularStabilityMs, xaiGranularGuardWords, textTranslationProvider: requestedTextTranslationProvider } = parameters;
	const connectionId = ++wsConnectionId;

	logger.info(
		`[WS-${connectionId}] New WebSocket connection, sessionId=${sessionId}, provider=${requestedProvider || 'default'}, encoding=${encoding}`,
	);

	let session: TranscriberProxy;
	let isResume = false;

	// Check for existing session (detached OR active)
	if (sessionId && sessionManager.hasSession(sessionId)) {
		// Detached session - resume from grace period
		try {
			session = sessionManager.reattachSession(sessionId, ws);
			isResume = true;
			logger.info(`[WS-${connectionId}] Session ${sessionId} resumed from detached state (original params will be used)`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error(`[WS-${connectionId}] Failed to resume session ${sessionId}: ${msg}`);
			ws.close(1011, `Failed to resume session: ${msg}`);
			return;
		}
	} else if (sessionId && sessionManager.hasActiveSession(sessionId)) {
		// Active session - force-close existing connection and attach new one
		session = sessionManager.getActiveSession(sessionId)!;
		session.reattachWebSocket(ws);
		isResume = true;
		logger.warn(`[WS-${connectionId}] Duplicate connection for ${sessionId}, force-closing previous connection (original params will be used)`);
	} else {
		// Create new session
		// Determine which provider to use
		let provider: Provider | undefined;

		if (requestedProvider) {
			// Provider specified in URL
			if (!isValidProvider(requestedProvider)) {
				const errorMessage = `Invalid provider: ${requestedProvider}. Valid providers are: openai, openai_custom, gemini, deepgram, dummy`;
				logger.error(`[WS-${connectionId}] ${errorMessage}`);
				ws.close(1002, errorMessage);
				return;
			}

			if (!isProviderAvailable(requestedProvider)) {
				const errorMessage = `Provider '${requestedProvider}' is not available. Available providers: ${getAvailableProviders().join(', ')}`;
				logger.error(`[WS-${connectionId}] ${errorMessage}`);
				ws.close(1002, errorMessage);
				return;
			}

			provider = requestedProvider;
			logger.info(`[WS-${connectionId}] Using requested provider: ${provider}`);
		} else {
			// No provider specified, use default
			provider = getDefaultProvider() || undefined;
			logger.info(`[WS-${connectionId}] Using default provider: ${provider}`);
		}

		// Validate openai_custom requirements early, before creating the session
		if (provider === 'openai_custom') {
			if (!openaiCustomApiKey) {
				const errorMessage = 'X-Custom-Openai-Api-Key header is required for openai_custom provider';
				logger.error(`[WS-${connectionId}] ${errorMessage}`);
				ws.close(1002, errorMessage);
				return;
			}
			if (!openaiCustomUrl) {
				const errorMessage = 'openaiCustomUrl query parameter is required for openai_custom provider';
				logger.error(`[WS-${connectionId}] ${errorMessage}`);
				ws.close(1002, errorMessage);
				return;
			}
			let parsedCustomUrl: URL;
			try {
				parsedCustomUrl = new URL(openaiCustomUrl);
			} catch {
				const errorMessage = 'openaiCustomUrl is not a valid URL';
				logger.error(`[WS-${connectionId}] ${errorMessage}`);
				ws.close(1002, errorMessage);
				return;
			}
			if (config.openaiCustomRequireWss && parsedCustomUrl.protocol !== 'wss:') {
				const errorMessage = 'openaiCustomUrl must use wss:// scheme (set OPENAI_CUSTOM_REQUIRE_WSS=false to allow ws://)';
				logger.error(`[WS-${connectionId}] ${errorMessage}`);
				ws.close(1002, errorMessage);
				return;
			}
			logger.info(`[WS-${connectionId}] openai_custom WebSocket URL: ${parsedCustomUrl.hostname}`);
		}

		// Resolve the per-connection text-translation provider override, if any.
		//
		// Unlike the transcription `provider`, an unusable value here does NOT close the socket: text
		// translation is an optional addition to the session, so a stale parameter in a deployment's
		// URL template must not take transcription down with it. The error is logged loudly and the
		// configured default is used instead.
		let textTranslationProvider: TextTranslationProvider | undefined;
		if (requestedTextTranslationProvider) {
			if (!isValidTextTranslationProvider(requestedTextTranslationProvider)) {
				logger.error(
					`[WS-${connectionId}] Invalid text_translation_provider: ${requestedTextTranslationProvider}. Valid providers are: openai, xai, gemini, google, stub. Using the configured default instead`,
				);
			} else if (!isTextTranslationProviderAvailable(requestedTextTranslationProvider)) {
				logger.error(
					`[WS-${connectionId}] Text translation provider '${requestedTextTranslationProvider}' is not available. Available providers: ${getAvailableTextTranslationProviders().join(', ') || '(none)'}. Using the configured default instead`,
				);
			} else {
				textTranslationProvider = requestedTextTranslationProvider;
				logger.info(`[WS-${connectionId}] Using requested text translation provider: ${textTranslationProvider}`);
			}
		}

		// Create transcription session
		// Within this session, multiple participants (tags) can send audio
		// Each tag gets its own backend connection, and transcripts are shared between tags
		session = new TranscriberProxy(ws, { language, sessionId, provider, encoding, sendBack, sendBackInterim, tags, openaiCustomUrl, openaiCustomApiKey, deepgramMipOptOut, xaiEndpointing, xaiSmartTurn, xaiSmartTurnTimeout, xaiGranularFinals, xaiGranularStabilityMs, xaiGranularGuardWords, textTranslationProvider });

		// Register the new session
		sessionManager.registerSession(sessionId, session);

		logger.info(`[WS-${connectionId}] Created new session ${sessionId}`);
	}

	// Setup WebSocket event handlers (always for every connection)
	setupWebSocketEventListeners(ws, session, connectionId, sessionId);

	// Setup session event handlers (only for new sessions to avoid accumulation)
	if (!isResume) {
		setupSessionEventHandlers(ws, session, connectionId, sessionId);
	}
}

// Start server
const PORT = config.server.port;
const HOST = config.server.host;

server.listen(PORT, HOST, () => {
	logger.info('='.repeat(60));
	logger.info('opus-transcriber-proxy started');
	logger.info('='.repeat(60));

	// Server info
	logger.info(`Server: ${HOST}:${PORT}`);
	logger.info(`WebSocket endpoint: ws://${HOST}:${PORT}/transcribe`);
	logger.info('');

	// Provider configuration
	const availableProviders = getAvailableProviders();
	const defaultProvider = getDefaultProvider();

	if (availableProviders.length === 0) {
		logger.error('No providers are available! Please configure at least one provider with API keys.');
		logger.error('Set OPENAI_API_KEY, GEMINI_API_KEY, or DEEPGRAM_API_KEY in your environment.');
		process.exit(1);
	}

	logger.info(`Available providers: ${availableProviders.join(', ')}`);
	if (defaultProvider) {
		logger.info(`Default provider: ${defaultProvider}`);
	} else {
		logger.error('No default provider available! Check PROVIDERS_PRIORITY configuration.');
		process.exit(1);
	}
	logger.info('');

	// Text translation configuration (the /transcribe path; target languages come from the bridge)
	logger.info('Text Translation:');
	logger.info(`  Enabled: ${config.textTranslation.enabled}`);
	if (config.textTranslation.enabled) {
		const availableTextProviders = getAvailableTextTranslationProviders();
		const defaultTextProvider = getDefaultTextTranslationProvider();
		logger.info(`  Priority: ${config.textTranslation.providersPriority.join(', ')}`);
		logger.info(`  Available providers: ${availableTextProviders.join(', ') || '(none)'}`);
		if (defaultTextProvider) {
			logger.info(`  Default provider: ${defaultTextProvider}`);
		} else {
			// Not fatal: transcription still works, and the requested languages are dropped with a
			// log message on the first `sources` event that asks for one.
			logger.error('  No text translation provider is available! Requested languages will be dropped.');
		}
		logger.info(`  History: ${config.textTranslation.historyTurns} turns / ${config.textTranslation.historyMaxChars} chars`);
		logger.info(`  Speaker labels: ${config.textTranslation.includeSpeakers}`);
		logger.info(`  Timeout: ${config.textTranslation.timeoutMs}ms`);
	}
	logger.info('');

	// Transcription settings
	logger.info('Transcription Settings:');
	logger.info(`  Force Commit Timeout: ${config.forceCommitTimeout}s`);
	logger.info(`  Broadcast Transcripts: ${config.broadcastTranscripts}`);
	if (config.broadcastTranscripts) {
		logger.info(`  Broadcast Max Size: ${config.broadcastTranscriptsMaxSize} bytes`);
	}
	logger.info('');

	// Session resumption settings
	logger.info('Session Resumption:');
	logger.info(`  Enabled: ${config.sessionResumeEnabled}`);
	if (config.sessionResumeEnabled) {
		logger.info(`  Grace Period: ${config.sessionResumeGracePeriod}s`);
	}
	logger.info('');

	// Debug/Development settings
	logger.info('Debug Settings:');
	logger.info(`  Log Level: ${config.logLevel}`);
	logger.info(`  Debug Mode: ${config.debug}`);
	logger.info(`  Dump WebSocket Messages: ${config.dumpWebSocketMessages}`);
	logger.info(`  Dump Transcripts: ${config.dumpTranscripts}`);
	if (config.dumpWebSocketMessages || config.dumpTranscripts) {
		logger.info(`  Dump Base Path: ${config.dumpBasePath}`);
	}
	logger.info('');

	// Telemetry settings
	logger.info('Telemetry:');
	logger.info(`  Enabled: ${isTelemetryEnabled()}`);
	if (isTelemetryEnabled()) {
		logger.info(`  OTLP Endpoint: ${config.otlp.endpoint}`);
		logger.info(`  Environment: ${config.otlp.env || '(not set)'}`);
		logger.info(`  Export Interval: ${config.otlp.exportIntervalMs}ms`);
	}

	logger.info('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
	logger.info('SIGTERM received, closing server...');

	// Shut down transcription sessions (SessionManager) and close active translation proxies — each
	// TranslatorConnection flushes its final usage delta into the reporter buffer on close — so the
	// buffer is complete before we drain it below.
	sessionManager.shutdown();
	for (const session of activeTranslateSessions) {
		session.close();
	}
	for (const session of activeAgentSessions) {
		session.close();
	}

	// Flush any buffered translation usage, then shutdown telemetry.
	await Promise.all([flushTranslationUsage(), shutdownTelemetry(), shutdownTelemetryLogs()]);

	server.close(() => {
		logger.info('Server closed');
		process.exit(0);
	});
});
