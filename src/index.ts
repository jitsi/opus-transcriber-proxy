import { extractSessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { Transcriptionator } from './transcriptionator';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');

		if (upgradeHeader !== 'websocket') {
			return new Response('Worker expected Upgrade: websocket', { status: 426 });
		}

		if (request.method !== 'GET') {
			return new Response('Worker expected GET method', { status: 400 });
		}

		const { url, sessionId, transcribe, connect } = extractSessionParameters(request.url);

		if (!url.pathname.endsWith('/events') && !url.pathname.endsWith('/transcribe')) {
			return new Response('Bad URL', { status: 400 });
		}

		if (transcribe) {
			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			server.accept();

			const session = new TranscriberProxy(server, env);

			let outbound: WebSocket | undefined;
			let transcriptionator: DurableObjectStub<Transcriptionator> | undefined;

			if (connect) {
				try {
					const outbound = new WebSocket(connect, ['transcription']);
					// TODO: pass auth info to this websocket

					outbound.addEventListener('close', () => {
						// TODO: reconnect?
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return new Response(`Failed to connect to WebSocket ${connect}: ${message}`, { status: 400 });
				}
			}

			if (sessionId) {
				// Connect to transcriptionator durable object to relay messages
				transcriptionator = env.TRANSCRIPTIONATOR.getByName(sessionId);
			}

			session.on('closed', () => {
				outbound?.close();
				transcriptionator?.notifySessionClosed();
				server.close();
			});

			session.on('interim_transcription', (data: TranscriptionMessage) => {
				const message = JSON.stringify(data);
				outbound?.send(message);
				transcriptionator?.broadcastMessage(message);
				server.send(message);
			});

			session.on('transcription', (data: TranscriptionMessage) => {
				const message = JSON.stringify(data);
				outbound?.send(message);
				transcriptionator?.broadcastMessage(message);
				server.send(message);
			});

			// Accept the connection and return immediately
			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		} else {
			if (!sessionId) {
				return new Response('Missing sessionId or connect param', { status: 400 });
			}

			// Handle observer: connect to the Durable Object
			const stub = env.TRANSCRIPTIONATOR.getByName(sessionId);
			return stub.fetch(request);
		}
	},
} satisfies ExportedHandler<Env>;

export { Transcriptionator } from './transcriptionator';
