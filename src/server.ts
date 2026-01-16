import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { extractSessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { setMetricDebug, writeMetric } from './metrics';
import logger from './logger';

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
	const parameters = extractSessionParameters(url);

	logger.debug('Session parameters:', JSON.stringify(parameters));

	// Validate path
	if (!parameters.url.pathname.endsWith('/transcribe')) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\nBad URL');
		socket.destroy();
		return;
	}

	// Validate transcribe flag
	if (!parameters.transcribe) {
		socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing transcribe parameter');
		socket.destroy();
		return;
	}

	// Validate output method
	if (!parameters.sendBack && !parameters.sendBackInterim) {
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

function handleWebSocketConnection(ws: WebSocket, parameters: any) {
	const { sessionId, sendBack, sendBackInterim, language } = parameters;
	const connectionId = ++wsConnectionId;

	logger.info(`[WS-${connectionId}] New WebSocket connection, sessionId=${sessionId}`);

	// Create transcription session
	// Within this session, multiple participants (tags) can send audio
	// Each tag gets its own OpenAI connection, and transcripts are shared between tags
	const session = new TranscriberProxy(ws, { language, sessionId });

	// Handle WebSocket close
	ws.addEventListener('close', (event) => {
		logger.info(`[WS-${connectionId}] Client WebSocket closed: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`);
		clearInterval(stateCheckInterval);
		session.close();
	});

	// Handle WebSocket error
	ws.addEventListener('error', (event) => {
		const errorMessage = 'WebSocket error';
		logger.error(`[WS-${connectionId}] Client WebSocket error:`, errorMessage, event);
		session.close();
		ws.close(1011, errorMessage);
	});

	// Log initial WebSocket state
	logger.debug(`[WS-${connectionId}] Connection established. readyState=${ws.readyState}, sendBack=${sendBack}, sendBackInterim=${sendBackInterim}`);

	// Monitor WebSocket state changes
	let lastReadyState = ws.readyState;
	const stateCheckInterval = setInterval(() => {
		if (ws.readyState !== lastReadyState) {
			logger.debug(`[WS-${connectionId}] readyState changed: ${lastReadyState} -> ${ws.readyState}`);
			lastReadyState = ws.readyState;
		}
	}, 100);

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
			logger.debug(`[WS-${connectionId}] Received interim transcription. sendBack=${sendBack}, readyState=${ws.readyState}`);
			if (sendBack) {
				// Only send if WebSocket is OPEN (readyState === 1)
				if (ws.readyState !== 1) {
					logger.warn(`[WS-${connectionId}] Cannot send interim: not open (readyState=${ws.readyState})`);
					return;
				}
				try {
					const message = JSON.stringify(data);
					logger.debug(`[WS-${connectionId}] Sending interim for ${data.participant?.id}:`, message);
					ws.send(message);
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
		logger.debug(`[WS-${connectionId}] Received final transcription. sendBack=${sendBack}, readyState=${ws.readyState}`);

		// Track successful transcription
		writeMetric(undefined, {
			name: 'transcription_success',
			worker: 'opus-transcriber-proxy',
			sessionId: sessionId ?? undefined,
		});

		if (sendBack) {
			// Only send if WebSocket is OPEN (readyState === 1)
			if (ws.readyState !== 1) {
				logger.warn(`[WS-${connectionId}] Cannot send final: not open (readyState=${ws.readyState})`);
				return;
			}
			try {
				const message = JSON.stringify(data);
				logger.debug(`[WS-${connectionId}] Sending final for ${data.participant?.id}:`, message);
				ws.send(message);
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

	// Backend configuration
	logger.info(`Transcription Backend: ${config.transcriptionBackend}`);
	if (config.transcriptionBackend === 'openai') {
		logger.info(`  Model: ${config.openai.model}`);
		logger.info(`  Prompt: ${config.openai.transcriptionPrompt ? config.openai.transcriptionPrompt.substring(0, 60) + '...' : '(none)'}`);
		logger.info(`  Turn Detection: ${JSON.stringify(config.openai.turnDetection)}`);
	} else if (config.transcriptionBackend === 'gemini') {
		logger.info(`  Model: ${config.gemini.model}`);
		logger.info(`  Prompt: ${config.gemini.transcriptionPrompt ? config.gemini.transcriptionPrompt.substring(0, 60) + '...' : '(none)'}`);
	} else if (config.transcriptionBackend === 'deepgram') {
		logger.info(`  Model: ${config.deepgram.model}`);
		logger.info(`  Language: ${config.deepgram.language}`);
		logger.info(`  Include Language: ${config.deepgram.includeLanguage}`);
		logger.info(`  Punctuate: ${config.deepgram.punctuate}`);
		logger.info(`  Diarize: ${config.deepgram.diarize}`);
	} else if (config.transcriptionBackend === 'dummy') {
		logger.info('  (Testing/statistics backend - decodes audio but does not transcribe)');
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

	// Debug/Development settings
	logger.info('Debug Settings:');
	logger.info(`  Log Level: ${config.logLevel}`);
	logger.info(`  Debug Mode: ${config.debug}`);
	logger.info(`  Dump WebSocket Messages: ${config.dumpWebSocketMessages}`);
	logger.info(`  Dump Transcripts: ${config.dumpTranscripts}`);
	if (config.dumpWebSocketMessages || config.dumpTranscripts) {
		logger.info(`  Dump Base Path: ${config.dumpBasePath}`);
	}

	logger.info('='.repeat(60));
});

// Graceful shutdown
process.on('SIGTERM', () => {
	logger.info('SIGTERM received, closing server...');
	server.close(() => {
		logger.info('Server closed');
		process.exit(0);
	});
});
