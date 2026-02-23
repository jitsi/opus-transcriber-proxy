import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config, getAvailableProviders, getDefaultProvider, isValidProvider, isProviderAvailable, type Provider } from './config';
import { extractSessionParameters, type ISessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { setMetricDebug, writeMetric } from './metrics';
import logger, { addOtlpTransport } from './logger';
import { sessionManager } from './SessionManager';
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
	res.writeHead(426, { 'Content-Type': 'text/plain' });
	res.end('Upgrade Required: Expected WebSocket connection');
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

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
	if (!parameters.url.pathname.endsWith('/transcribe')) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\nBad URL');
		socket.destroy();
		return;
	}

	// Validate output method
	if (!parameters.sendBack && !parameters.sendBackInterim && !config.useDispatcher && !parameters.useDispatcher) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\nNo transcription output method specified');
		socket.destroy();
		return;
	}

	// Accept the WebSocket upgrade
	wss.handleUpgrade(request, socket, head, (ws) => {
		handleWebSocketConnection(ws, parameters);
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
			sessionManager.unregisterSession(sessionId);
			session.close();
		}
	});

	// Handle WebSocket error
	ws.addEventListener('error', (event) => {
		const errorMessage = 'WebSocket error';
		logger.error(`[WS-${connectionId}] Client WebSocket error:`, errorMessage, event);
		sessionManager.unregisterSession(sessionId);
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
			sessionManager.unregisterSession(sessionId);
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
}

function handleWebSocketConnection(ws: WebSocket, parameters: any) {
	const { sessionId, language, provider: requestedProvider, encoding, sendBack, sendBackInterim, tags } = parameters;
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
				const errorMessage = `Invalid provider: ${requestedProvider}. Valid providers are: openai, gemini, deepgram, dummy`;
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

		// Create transcription session
		// Within this session, multiple participants (tags) can send audio
		// Each tag gets its own backend connection, and transcripts are shared between tags
		session = new TranscriberProxy(ws, { language, sessionId, provider, encoding, sendBack, sendBackInterim, tags });

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

	// Shutdown SessionManager first (cleanup detached sessions)
	sessionManager.shutdown();

	// Shutdown telemetry (flush pending metrics and logs)
	await Promise.all([shutdownTelemetry(), shutdownTelemetryLogs()]);

	server.close(() => {
		logger.info('Server closed');
		process.exit(0);
	});
});
