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

function handleWebSocketConnection(ws: WebSocket, parameters: any) {
	const { sessionId, sendBack, sendBackInterim, language } = parameters;

	// Create transcription session
	const session = new TranscriberProxy(ws, { language });

	// Handle WebSocket close
	ws.addEventListener('close', () => {
		console.log('Client WebSocket closed');
		session.close();
	});

	// Handle WebSocket error
	ws.addEventListener('error', (event) => {
		const errorMessage = 'WebSocket error';
		console.error('Client WebSocket error:', errorMessage);
		session.close();
		ws.close(1011, errorMessage);
	});

	// Handle session closed event
	session.on('closed', () => {
		ws.close();
	});

	// Handle session error event
	session.on('error', (tag, error) => {
		try {
			const message = `Error in session ${tag}: ${error instanceof Error ? error.message : String(error)}`;
			console.error(message);
			ws.close(1011, message);
		} catch (closeError) {
			// Error handlers do not themselves catch errors, so log to console
			console.error(
				`Failed to close connections after error in session ${tag}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
			);
		}
	});

	// Handle interim transcriptions
	if (sendBackInterim) {
		session.on('interim_transcription', (data: TranscriptionMessage) => {
			if (sendBack) {
				ws.send(JSON.stringify(data));
			}
		});
	}

	// Handle final transcriptions
	session.on('transcription', (data: TranscriptionMessage) => {
		// Track successful transcription
		writeMetric(undefined, {
			name: 'transcription_success',
			worker: 'opus-transcriber-proxy',
			sessionId: sessionId ?? undefined,
		});

		if (sendBack) {
			ws.send(JSON.stringify(data));
		}
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
