import { DurableObject } from 'cloudflare:workers';
import { extractSessionParameters } from './utils';
import { TranscriberProxy, type TranscriptionMessage } from './transcriberproxy';
import { writeMetric } from './metrics';

// Session config stored in WebSocket attachment
interface SessionAttachment {
	sessionId: string;
	language: string | null;
	createdAt: number;
	useTranscriptionator: boolean;
	useDispatcher: boolean;
	sendBack: boolean;
	sendBackInterim: boolean;
	connectUrl: string | null;
}

// No-op WebSocket for TranscriberProxy (DO handles WS events directly)
function createNoOpWebSocket(): WebSocket {
	return {
		send: () => {},
		close: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
	} as unknown as WebSocket;
}

export class TranscriptionSession extends DurableObject<Env> {
	private transcriberProxy: TranscriberProxy | null = null;
	private graceTimeout: ReturnType<typeof setTimeout> | null = null;
	private sessionConfig: SessionAttachment | null = null;

	// Grace period before closing OpenAI connections (ms)
	private static GRACE_PERIOD_MS = 30_000; // 30 seconds

	async fetch(request: Request): Promise<Response> {
		const url = request.url;
		const params = extractSessionParameters(url);

		console.log(`TranscriptionSession.fetch: sessionId=${params.sessionId}`);

		// Validate we have an output method
		if (!params.useTranscriptionator && !params.useDispatcher && !params.sendBack && !params.sendBackInterim && !params.connect) {
			return new Response('No transcription output method specified', { status: 400 });
		}

		// Check if this is a reconnection (TranscriberProxy exists from grace period)
		const isReconnection = this.transcriberProxy !== null;

		if (isReconnection) {
			console.log(`Client reconnecting during grace period - reusing TranscriberProxy with existing OpenAI connections`);
			this.cancelGraceTimeout();
		}

		// Close any stale WebSockets from previous connections
		const existingWebSockets = this.ctx.getWebSockets();
		for (const oldWs of existingWebSockets) {
			try {
				oldWs.close(1000, 'Client reconnected');
			} catch (e) {
				// Ignore errors closing old sockets
			}
		}

		// Create WebSocket pair for new client connection
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Build session config for attachment
		const sessionConfig: SessionAttachment = {
			sessionId: params.sessionId || 'unknown',
			language: params.language,
			createdAt: Date.now(),
			useTranscriptionator: params.useTranscriptionator,
			useDispatcher: params.useDispatcher,
			sendBack: params.sendBack,
			sendBackInterim: params.sendBackInterim,
			connectUrl: params.connect,
		};

		// Accept with hibernation support
		this.ctx.acceptWebSocket(server);

		// Store config in attachment (survives hibernation)
		server.serializeAttachment(sessionConfig);

		// Cache config
		this.sessionConfig = sessionConfig;

		// Set up auto ping/pong (doesn't wake DO)
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"event":"ping"}', '{"event":"pong"}'));

		// Ensure TranscriberProxy exists (create if first connection, reuse if reconnection)
		if (!this.transcriberProxy) {
			this.createTranscriberProxy(sessionConfig);
		}

		console.log(`TranscriptionSession: WebSocket accepted for session ${sessionConfig.sessionId}, isReconnection=${isReconnection}`);

		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		if (typeof message !== 'string') {
			console.warn('Received non-string WebSocket message, ignoring');
			return;
		}

		// Cancel any pending grace timeout - client is active
		this.cancelGraceTimeout();

		let event: any;
		try {
			event = JSON.parse(message);
		} catch (e) {
			console.error('Failed to parse WebSocket message as JSON:', e);
			return;
		}

		// Handle media events
		if (event.event === 'media') {
			if (!this.transcriberProxy && !this.sessionConfig) {
				// Restore config from attachment after hibernation wake
				this.sessionConfig = ws.deserializeAttachment() as SessionAttachment;
				this.createTranscriberProxy(this.sessionConfig);
			}
			this.transcriberProxy?.handleMediaEvent(event);
		}
		// Ping/pong is handled automatically by setWebSocketAutoResponse
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
		// Restore config from attachment if lost during hibernation
		if (!this.sessionConfig) {
			this.sessionConfig = ws.deserializeAttachment() as SessionAttachment;
		}

		console.log(`Client WebSocket closed: code=${code} reason=${reason || 'none'} wasClean=${wasClean} sessionId=${this.sessionConfig?.sessionId}`);

		// Don't cleanup immediately - start grace period
		// This allows client to reconnect and reuse OpenAI connections
		this.startGraceTimeout();
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		console.error('Client WebSocket error:', error);
		// Error is typically followed by close, so grace period will start there
	}

	private createTranscriberProxy(config: SessionAttachment): void {
		console.log(`Creating TranscriberProxy for session ${config.sessionId}`);

		// Create TranscriberProxy with no-op WebSocket
		// (DO handles WebSocket events directly, not TranscriberProxy)
		this.transcriberProxy = new TranscriberProxy(createNoOpWebSocket(), this.env, {
			language: config.language,
		});

		this.setupTranscriptionListeners(config);
	}

	private getClientWebSocket(): WebSocket | null {
		const webSockets = this.ctx.getWebSockets();
		return webSockets.length > 0 ? webSockets[0] : null;
	}

	private setupTranscriptionListeners(config: SessionAttachment): void {
		if (!this.transcriberProxy) return;

		// Handle interim transcriptions
		this.transcriberProxy.on('interim_transcription', (data: TranscriptionMessage) => {
			const message = JSON.stringify(data);
			const clientWs = this.getClientWebSocket();

			if ((config.sendBack || config.sendBackInterim) && clientWs) {
				try {
					clientWs.send(message);
				} catch (e) {
					console.error('Failed to send interim transcription to client:', e);
				}
			}

			if (config.useTranscriptionator) {
				try {
					const transcriptionator = this.env.TRANSCRIPTIONATOR.get(
						this.env.TRANSCRIPTIONATOR.idFromName(config.sessionId),
					);
					transcriptionator.broadcastMessage(message);
				} catch (e) {
					console.error('Failed to broadcast interim transcription:', e);
				}
			}
		});

		// Handle final transcriptions
		this.transcriberProxy.on('transcription', (data: TranscriptionMessage) => {
			writeMetric(this.env.METRICS, {
				name: 'transcription_success',
				worker: 'opus-transcriber-proxy',
				sessionId: config.sessionId,
			});

			const message = JSON.stringify(data);
			const clientWs = this.getClientWebSocket();

			// Send back to client
			if (config.sendBack && clientWs) {
				try {
					clientWs.send(message);
				} catch (e) {
					console.error('Failed to send transcription to client:', e);
				}
			}

			// Broadcast to observers via Transcriptionator
			if (config.useTranscriptionator) {
				try {
					const transcriptionator = this.env.TRANSCRIPTIONATOR.get(
						this.env.TRANSCRIPTIONATOR.idFromName(config.sessionId),
					);
					transcriptionator.broadcastMessage(message);
				} catch (e) {
					console.error('Failed to broadcast transcription:', e);
				}
			}

			// Send to dispatcher
			if (config.useDispatcher) {
				const dispatcherMessage = {
					sessionId: config.sessionId,
					endpointId: data.participant.id || 'unknown',
					text: data.transcript.map((t) => t.text).join(' '),
					timestamp: data.timestamp,
				};

				this.env.TRANSCRIPTION_DISPATCHER.fetch('https://dispatcher/dispatch', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(dispatcherMessage),
				}).catch((e) => {
					console.error('Failed to dispatch transcription:', e);
				});
			}
		});

		// Handle errors from TranscriberProxy
		this.transcriberProxy.on('error', (tag: string, error: string) => {
			console.error(`TranscriberProxy error for tag ${tag}: ${error}`);
		});

		// Handle closed from TranscriberProxy (all connections closed)
		this.transcriberProxy.on('closed', () => {
			console.log('TranscriberProxy closed');
		});
	}

	private startGraceTimeout(): void {
		this.cancelGraceTimeout();

		console.log(`Starting ${TranscriptionSession.GRACE_PERIOD_MS}ms grace period for session ${this.sessionConfig?.sessionId}`);

		this.graceTimeout = setTimeout(() => {
			console.log(`Grace period expired for session ${this.sessionConfig?.sessionId}, cleaning up OpenAI connections`);
			this.cleanup();
		}, TranscriptionSession.GRACE_PERIOD_MS);
	}

	private cancelGraceTimeout(): void {
		if (this.graceTimeout) {
			clearTimeout(this.graceTimeout);
			this.graceTimeout = null;
			console.log(`Grace period cancelled for session ${this.sessionConfig?.sessionId}`);
		}
	}

	private cleanup(): void {
		console.log(`Cleaning up TranscriptionSession for ${this.sessionConfig?.sessionId}`);

		if (this.transcriberProxy) {
			// Close all OpenAI connections
			this.transcriberProxy.closeAllConnections();
			this.transcriberProxy = null;
		}

		this.graceTimeout = null;
		this.sessionConfig = null;
	}
}
