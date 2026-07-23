import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config, getAvailableProviders, getDefaultProvider, isValidProvider, isProviderAvailable, type Provider } from './config';
import { extractSessionParameters, type ISessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { TranslatorProxy } from './translatorproxy';
import { normalizeTargetLanguage } from './TranslatorConnection';
import { createNodeTranslationRuntime } from './translate/nodeRuntime';
import { buildTranslationMediaMessage, buildTranslationTranscriptMessage } from './translate/messages';
import type { IWebSocket } from './translate/runtime';
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
	if (!parameters.url.pathname.endsWith('/transcribe') && !parameters.url.pathname.endsWith('/translate')) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\nBad URL');
		socket.destroy();
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

	// Speaker-identity attribution → client. Arrives after the plain transcription-result (identity
	// is resolved async), so it's a follow-up per-speaker transcript carrying the resolved identity
	// in `participant` (name = resolved name, else provisional handle). No client change needed — a
	// client that ignores the extra `name`/duplicate still works; proper in-place reconciliation of
	// the earlier line is a later step.
	session.on(
		'identity_attribution',
		(data: {
			participantId: string;
			messageId: string;
			timestamp: number;
			language?: string;
			segments: Array<{ identity: string | null; name: string | null; handle: string | null; text: string }>;
		}) => {
			if (!sendBack) return;
			const currentWs = session.getWebSocket();
			if (!currentWs || currentWs.readyState !== 1) return;
			data.segments.forEach((s, i) => {
				// Only a RESOLVED (known-enrolled) identity overrides the speaker. An unresolved cluster
				// (provisional handle like "Crimson Otter") is attributed to the mic-owner endpoint — NOT a
				// synthetic "unknown:<handle>" id, which the dispatcher would turn into a phantom virtual
				// participant (mis-attribution + inflated meeting roster). JIT-16065.
				const id = s.identity ?? data.participantId;
				// A resolved speaker ALWAYS carries a name (fall back to the identity itself when the
				// fingerprint has no display name), mirroring the Node dispatcher builder. Otherwise the
				// worker — which detects identity finals by name presence — would miss it and the
				// dispatcher's KV lookup of the email endpoint finds nothing → the utterance is dropped
				// from the store. Unresolved segments stay name-less (mic-owner, normal KV path). JIT-16065.
				const name = s.identity ? (s.name ?? s.identity) : undefined;
				const msg: TranscriptionMessage = {
					type: 'transcription-result',
					event: 'transcription-result',
					is_interim: false,
					transcript: [{ text: s.text }],
					participant: { id, ...(name && { name }) },
					timestamp: data.timestamp,
					...(data.language && { language: data.language }),
					message_id: `${data.messageId}-id-${i}`,
					// Store-only: the Worker dispatches this to the transcript store but does NOT show it in
					// the live CC (the identified speaker isn't in the XMPP room → would render as "Guest" and
					// duplicate the raw line). Keeps the live CC identical to pre-identity behaviour. JIT-16065.
					dispatchOnly: true,
				};
				try {
					currentWs.send(JSON.stringify(msg));
					getInstruments().transcriptionsDeliveredTotal.add(1, {
						provider: options.provider || 'unknown',
						is_interim: 'false',
					});
				} catch (error) {
					logger.error(`[WS-${connectionId}] Failed to send identity attribution:`, error);
				}
			});
		},
	);
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
		(data: { tag: string; language: string; chunk: number; timestamp: number; payload: string; sequenceNumber: number }) => {
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
}

export function handleWebSocketConnection(ws: WebSocket, parameters: ISessionParameters, openaiCustomApiKey?: string) {
	const { sessionId, language, provider: requestedProvider, encoding, sendBack, sendBackInterim, tags, openaiCustomUrl, deepgramMipOptOut, xaiEndpointing, xaiSmartTurn, xaiSmartTurnTimeout, xaiGranularFinals, xaiGranularStabilityMs, xaiGranularGuardWords } = parameters;
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

		// Create transcription session
		// Within this session, multiple participants (tags) can send audio
		// Each tag gets its own backend connection, and transcripts are shared between tags
		session = new TranscriberProxy(ws, { language, sessionId, provider, encoding, sendBack, sendBackInterim, tags, openaiCustomUrl, openaiCustomApiKey, deepgramMipOptOut, xaiEndpointing, xaiSmartTurn, xaiSmartTurnTimeout, xaiGranularFinals, xaiGranularStabilityMs, xaiGranularGuardWords });

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

	// Flush any buffered translation usage, then shutdown telemetry.
	await Promise.all([flushTranslationUsage(), shutdownTelemetry(), shutdownTelemetryLogs()]);

	server.close(() => {
		logger.info('Server closed');
		process.exit(0);
	});
});
