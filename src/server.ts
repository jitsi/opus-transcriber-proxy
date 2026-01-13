import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { extractSessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { setMetricDebug, writeMetric } from './metrics';

// Initialize metric debug logging
setMetricDebug(config.debug);

// Create HTTP server
const server = http.createServer((req, res) => {
	// Log all incoming requests for debugging
	console.log(`HTTP ${req.method} ${req.url}`);
	console.log('Headers:', JSON.stringify(req.headers, null, 2));

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
	console.log('UPGRADE EVENT TRIGGERED!');
	console.log(`Upgrade ${request.method} ${request.url}`);
	console.log('Upgrade Headers:', JSON.stringify(request.headers, null, 2));

	const url = `http://${request.headers.host}${request.url}`;
	const parameters = extractSessionParameters(url);

	console.log('Session parameters:', JSON.stringify(parameters));

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

	console.log(`[WS-${connectionId}] New WebSocket connection, sessionId=${sessionId}`);

	// Create transcription session
	// Within this session, multiple participants (tags) can send audio
	// Each tag gets its own OpenAI connection, and transcripts are shared between tags
	const session = new TranscriberProxy(ws, { language });

	// Handle WebSocket close
	ws.addEventListener('close', (event) => {
		console.log(`[WS-${connectionId}] Client WebSocket closed: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`);
		clearInterval(stateCheckInterval);
		session.close();
	});

	// Handle WebSocket error
	ws.addEventListener('error', (event) => {
		const errorMessage = 'WebSocket error';
		console.error(`[WS-${connectionId}] Client WebSocket error:`, errorMessage, event);
		session.close();
		ws.close(1011, errorMessage);
	});

	// Log initial WebSocket state
	console.log(`[WS-${connectionId}] Connection established. readyState=${ws.readyState}, sendBack=${sendBack}, sendBackInterim=${sendBackInterim}`);

	// Monitor WebSocket state changes
	let lastReadyState = ws.readyState;
	const stateCheckInterval = setInterval(() => {
		if (ws.readyState !== lastReadyState) {
			console.log(`[WS-${connectionId}] readyState changed: ${lastReadyState} -> ${ws.readyState}`);
			lastReadyState = ws.readyState;
		}
	}, 100);

	// Handle session closed event
	session.on('closed', () => {
		console.log(`[WS-${connectionId}] Session closed event received, closing WebSocket`);
		ws.close();
	});

	// Handle session error event
	session.on('error', (tag, error) => {
		try {
			const message = `Error in session ${tag}: ${error instanceof Error ? error.message : String(error)}`;
			console.error(`[WS-${connectionId}] ${message}`);
			ws.close(1011, message);
		} catch (closeError) {
			// Error handlers do not themselves catch errors, so log to console
			console.error(
				`[WS-${connectionId}] Failed to close connections after error in session ${tag}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
			);
		}
	});

	// Handle interim transcriptions
	if (sendBackInterim) {
		session.on('interim_transcription', (data: TranscriptionMessage) => {
			console.log(`[WS-${connectionId}] Received interim transcription. sendBack=${sendBack}, readyState=${ws.readyState}`);
			if (sendBack) {
				// Only send if WebSocket is OPEN (readyState === 1)
				if (ws.readyState !== 1) {
					console.warn(`[WS-${connectionId}] Cannot send interim: not open (readyState=${ws.readyState})`);
					return;
				}
				try {
					const message = JSON.stringify(data);
					console.log(`[WS-${connectionId}] Sending interim for ${data.participant?.id}:`, message);
					ws.send(message);
					console.log(`[WS-${connectionId}] Sent interim successfully`);
				} catch (error) {
					console.error(`[WS-${connectionId}] Failed to send interim:`, error);
				}
			} else {
				console.warn(`[WS-${connectionId}] Not sending interim: sendBack=${sendBack}`);
			}
		});
	}

	// Handle final transcriptions
	session.on('transcription', (data: TranscriptionMessage) => {
		console.log(`[WS-${connectionId}] Received final transcription. sendBack=${sendBack}, readyState=${ws.readyState}`);

		// Track successful transcription
		writeMetric(undefined, {
			name: 'transcription_success',
			worker: 'opus-transcriber-proxy',
			sessionId: sessionId ?? undefined,
		});

		if (sendBack) {
			// Only send if WebSocket is OPEN (readyState === 1)
			if (ws.readyState !== 1) {
				console.warn(`[WS-${connectionId}] Cannot send final: not open (readyState=${ws.readyState})`);
				return;
			}
			try {
				const message = JSON.stringify(data);
				console.log(`[WS-${connectionId}] Sending final for ${data.participant?.id}:`, message);
				ws.send(message);
				console.log(`[WS-${connectionId}] Sent final successfully`);
			} catch (error) {
				console.error(`[WS-${connectionId}] Failed to send final:`, error);
			}
		} else {
			console.warn(`[WS-${connectionId}] Not sending final: sendBack=${sendBack}`);
		}

		// Note: Cross-tag context sharing is handled automatically within TranscriberProxy
		// When one tag generates a transcript, it's broadcast to other tags in the same session
	});
}

// Start server
const PORT = config.server.port;
const HOST = config.server.host;

server.listen(PORT, HOST, () => {
	console.log(`Transcription server listening on ${HOST}:${PORT}`);
	console.log(`WebSocket endpoint: ws://${HOST}:${PORT}/transcribe`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
	console.log('SIGTERM received, closing server...');
	server.close(() => {
		console.log('Server closed');
		process.exit(0);
	});
});
