/**
 * Dispatcher WebSocket connection for forwarding transcriptions
 *
 * Connects to a dispatcher service via WebSocket and sends final transcriptions.
 * This is platform-agnostic - the dispatcher can be a Cloudflare Durable Object,
 * a regular WebSocket server, or any other WebSocket endpoint.
 */

import { WebSocket } from 'ws';
import logger from './logger';
import { config } from './config';

export interface DispatcherMessage {
	sessionId: string;
	endpointId: string;
	text: string;
	timestamp: number;
	language?: string;
}

export class DispatcherConnection {
	private ws: WebSocket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private sessionId: string;
	private closed = false;
	private messageQueue: DispatcherMessage[] = [];

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	async connect(): Promise<void> {
		if (!config.dispatcher.wsUrl) {
			logger.debug('No DISPATCHER_WS_URL configured, skipping dispatcher connection');
			return;
		}

		return new Promise((resolve, reject) => {
			try {
				const url = new URL(config.dispatcher.wsUrl);
				url.searchParams.set('sessionId', this.sessionId);

				logger.info(`Connecting to dispatcher at ${url.toString()} for session ${this.sessionId}`);
				const wsOptions: { headers?: Record<string, string> } = {};
				if (Object.keys(config.dispatcher.headers).length > 0) {
					wsOptions.headers = config.dispatcher.headers;
				}
				this.ws = new WebSocket(url.toString(), wsOptions);

				this.ws.on('open', () => {
					logger.info(`Connected to dispatcher for session ${this.sessionId}`);
					this.flushMessageQueue();
					resolve();
				});

				this.ws.on('close', (code, reason) => {
					logger.info(`Dispatcher connection closed for session ${this.sessionId}: code=${code} reason=${reason || 'none'}`);
					this.ws = null;
					this.scheduleReconnect();
				});

				this.ws.on('error', (error) => {
					logger.error(`Dispatcher connection error for session ${this.sessionId}:`, error.message);
					// Don't reject on error - the close event will handle reconnection
				});

				this.ws.on('message', (data) => {
					// Log any messages from dispatcher (for debugging)
					logger.debug(`Received message from dispatcher for session ${this.sessionId}:`, data.toString());
				});

				// Set a connection timeout
				const connectionTimeout = setTimeout(() => {
					if (this.ws?.readyState !== WebSocket.OPEN) {
						logger.warn(`Dispatcher connection timeout for session ${this.sessionId}`);
						this.ws?.close();
						reject(new Error('Connection timeout'));
					}
				}, 10000);

				this.ws.on('open', () => {
					clearTimeout(connectionTimeout);
				});
			} catch (error) {
				logger.error(`Failed to create dispatcher connection for session ${this.sessionId}:`, error);
				reject(error);
			}
		});
	}

	send(message: DispatcherMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			try {
				this.ws.send(JSON.stringify(message));
				logger.debug(`Sent transcription to dispatcher for session ${this.sessionId}: ${message.text.substring(0, 50)}...`);
			} catch (error) {
				logger.error(`Failed to send to dispatcher for session ${this.sessionId}:`, error);
				// Queue for retry
				this.messageQueue.push(message);
			}
		} else {
			// Queue message for when connection is restored
			this.messageQueue.push(message);
			logger.debug(`Queued message for dispatcher (not connected) for session ${this.sessionId}`);
		}
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close(1000, 'Session ended');
			this.ws = null;
		}
		logger.info(`Dispatcher connection closed for session ${this.sessionId}`);
	}

	isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	private flushMessageQueue(): void {
		if (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
			logger.info(`Flushing ${this.messageQueue.length} queued messages to dispatcher for session ${this.sessionId}`);
			const queue = this.messageQueue;
			this.messageQueue = [];
			for (const message of queue) {
				this.send(message);
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.closed) {
			logger.debug(`Not reconnecting dispatcher for session ${this.sessionId} - connection closed`);
			return;
		}

		logger.info(`Scheduling dispatcher reconnect for session ${this.sessionId} in ${config.dispatcher.reconnectInterval}ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect().catch((error) => {
				logger.error(`Reconnect failed for session ${this.sessionId}:`, error.message);
			});
		}, config.dispatcher.reconnectInterval);
	}
}
