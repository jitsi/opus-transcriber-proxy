import { extractSessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { Transcriptionator } from './transcriptionator';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { writeMetric } from './metrics';

export interface DispatcherTranscriptionMessage {
	sessionId: string;
	endpointId: string;
	text: string;
	timestamp: number;
	language?: string;
}

export interface RPCResponse {
	success: boolean;
	dispatched: number;
	errors?: string[];
	message?: string;
}

export interface TranscriptionDispatcher extends WorkerEntrypoint<Env> {
	dispatch(message: DispatcherTranscriptionMessage): Promise<RPCResponse>;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');

		if (upgradeHeader !== 'websocket') {
			return new Response('Worker expected Upgrade: websocket', { status: 426 });
		}

		if (request.method !== 'GET') {
			return new Response('Worker expected GET method', { status: 400 });
		}

		const parameters = extractSessionParameters(request.url);
		console.log('Session parameters:', JSON.stringify(parameters));

		const { url, sessionId, transcribe, connect, useTranscriptionator, useDispatcher, sendBack } = parameters;

		if (!url.pathname.endsWith('/events') && !url.pathname.endsWith('/transcribe')) {
			return new Response('Bad URL', { status: 400 });
		}

		if (transcribe) {
			if (!useTranscriptionator && !useDispatcher && !sendBack && !connect) {
				return new Response('No transcription output method specified', { status: 400 });
			}

			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			server.accept();

			const session = new TranscriberProxy(server, env);

			let outbound: WebSocket | undefined;
			let transcriptionator: DurableObjectStub<Transcriptionator> | undefined;
			let dispatcher: Service<TranscriptionDispatcher>;

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
				if (useTranscriptionator) {
					transcriptionator = env.TRANSCRIPTIONATOR.getByName(sessionId);
					console.log(`Connected to Transcriptionator for sessionId ${sessionId}`);
				}
				if (useDispatcher) {
					dispatcher = env.TRANSCRIPTION_DISPATCHER as Service<TranscriptionDispatcher>;
					console.log(`Connected to Transcription Dispatcher for sessionId ${sessionId}`);
				}
			} else {
				if (useDispatcher) {
					console.error('Dispatcher requested but no sessionId provided');
				}
				if (useTranscriptionator) {
					console.error('Transcriptionator requested but no sessionId provided');
				}
			}

			session.on('closed', () => {
				outbound?.close();
				transcriptionator?.notifySessionClosed();
				server.close();
			});

			if (outbound || transcriptionator || sendBack) {
				session.on('interim_transcription', (data: TranscriptionMessage) => {
					const message = JSON.stringify(data);
					outbound?.send(message);
					transcriptionator?.broadcastMessage(message);
					if (sendBack) {
						server.send(message);
					}
				});
			}

			session.on('transcription', (data: TranscriptionMessage) => {
				// Track successful transcription
				writeMetric(env.METRICS, {
					name: 'transcription_success',
					worker: 'opus-transcriber-proxy',
					sessionId: sessionId ?? undefined,
				});

				const message = outbound || transcriptionator || sendBack ? JSON.stringify(data) : '';
				outbound?.send(message);
				transcriptionator?.broadcastMessage(message);
				if (sendBack) {
					server.send(message);
				}

				if (useDispatcher) {
					const dispatcherMessage: DispatcherTranscriptionMessage = {
						sessionId: sessionId || 'unknown',
						endpointId: data.participant.id || 'unknown',
						text: data.transcript.map((t) => t.text).join(' '),
						timestamp: data.timestamp,
					};
					// Note: We intentionally don't use ctx.waitUntil() here because the
					// ExecutionContext from the initial WebSocket upgrade request becomes
					// stale after the response is sent. Using it would cause "IoContext
					// timed out due to inactivity" errors when transcription events fire.
					dispatcher
						?.dispatch(dispatcherMessage)
						.then((response) => {
							if (!response.success || response.errors) {
								console.error('Dispatcher error:', {
									message: response.message,
									errors: response.errors,
									dispatcherMessage,
								});
							}
						})
						.catch((error) => {
							const message = error instanceof Error ? error.message : String(error);
							console.error('Dispatcher RPC failed:', message, dispatcherMessage);
						});
				}
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
