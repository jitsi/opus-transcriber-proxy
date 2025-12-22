import { extractSessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { TranslateProxy } from './translateproxy';
import { Transcriptionator } from './transcriptionator';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { writeMetric, setMetricDebug } from './metrics';
import { TRANSLATION_INSTRUCTIONS } from './translation-instructions';

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
		// Initialize metric debug logging based on environment
		setMetricDebug(!!env.DEBUG);

		const upgradeHeader = request.headers.get('Upgrade');

		if (upgradeHeader !== 'websocket') {
			return new Response('Worker expected Upgrade: websocket', { status: 426 });
		}

		if (request.method !== 'GET') {
			return new Response('Worker expected GET method', { status: 400 });
		}

		const parameters = extractSessionParameters(request.url);
		console.log('Session parameters:', JSON.stringify(parameters));

		const { url, sessionId, transcribe, connect, useTranscriptionator, useDispatcher, sendBack, sendBackInterim, language } = parameters;

		if (!url.pathname.endsWith('/events') && !url.pathname.endsWith('/transcribe') && !url.pathname.endsWith('/translate')) {
			return new Response('Bad URL', { status: 400 });
		}

		if (transcribe) {
			if (!useTranscriptionator && !useDispatcher && !sendBack && !sendBackInterim && !connect) {
				return new Response('No transcription output method specified', { status: 400 });
			}

			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			server.accept();

			const session = new TranscriberProxy(server, env, { language });

			let outbound: WebSocket | undefined;
			let transcriptionator: DurableObjectStub<Transcriptionator> | undefined;
			let dispatcher: Service<TranscriptionDispatcher>;

			if (connect) {
				try {
					outbound = new WebSocket(connect, ['transcription']);
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

			session.on('error', (tag, error) => {
				try {
					const message = `Error in session ${tag}: ${error instanceof Error ? error.message : String(error)}`;
					console.error(message);
					outbound?.close(1001, message);
					transcriptionator?.notifySessionClosed();
					server.close(1011, message);
				} catch (closeError) {
					// Error handlers do not themselves catch errors, so log to console
					console.error(
						`Failed to close connections after error in session ${tag}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
					);
				}
			});

			if (outbound || transcriptionator || sendBackInterim) {
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
		} else if (url.pathname.endsWith('/translate')) {
			// Handle translation endpoint
			const targetLanguage = 'en';
			const instructions = TRANSLATION_INSTRUCTIONS.english;
			const sendBack = url.searchParams.get('sendBack') === 'true';

			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			server.accept();

			const translateSession = new TranslateProxy(server, env, {
				targetLanguage,
				instructions,
				voice: url.searchParams.get('voice') || 'alloy',
			});

			translateSession.on('closed', () => {
				server.close();
			});

			translateSession.on('error', (tag, error) => {
				try {
					const message = `Error in translation session ${tag}: ${error instanceof Error ? error.message : String(error)}`;
					console.error(message);
					server.close(1011, message);
				} catch (closeError) {
					console.error(
						`Failed to close connection after error in translation session ${tag}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
					);
				}
			});

			translateSession.on('transcription', (data: { transcript: string; targetLanguage: string; tag: string }) => {
				console.log("transcription event received, sendBack=" + sendBack, "data:", data);
				if (sendBack) {
					// Match the TranscriptionMessage format
					const translationMessage: TranscriptionMessage = {
						transcript: [{ text: data.transcript }],
						is_interim: false,
						language: data.targetLanguage,
						message_id: `translation-${data.tag}-${Date.now()}`,
						type: 'transcription-result',
						event: 'transcription-result',
						participant: { id: data.tag },
						timestamp: Date.now(),
					};
					const message = JSON.stringify(translationMessage);
					console.log("Sending translation back to client:", message);
					server.send(message);
				}
			});

			translateSession.on('audioFrame', (data: { tag: string; chunk: number; timestamp: number; payload: string; sequenceNumber: number }) => {
				if (sendBack) {
					const audioMessage = {
						event: 'media',
						sequenceNumber: data.sequenceNumber.toString(),
						media: {
							tag: data.tag,
							chunk: data.chunk.toString(),
							timestamp: data.timestamp.toString(),
							payload: data.payload,
						},
					};

					// Log with payload length instead of full payload
					console.log('Sending audio frame:', JSON.stringify({
						...audioMessage,
						media: {
							...audioMessage.media,
							payload: `<${data.payload.length} chars>`,
						},
					}));

					server.send(JSON.stringify(audioMessage));
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
