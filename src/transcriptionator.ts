/*
 * DISABLED FOR NODE.JS VERSION
 *
 * This file contains the Transcriptionator Durable Object for Cloudflare Workers.
 * It implements an observer pattern for broadcasting transcription results to multiple WebSocket clients.
 *
 * This functionality is not available in the Node.js version because:
 * - Durable Objects are a Cloudflare-specific feature
 * - The Node.js version focuses on direct sendBack functionality only
 *
 * If you need multi-observer support in Node.js, you would need to implement it differently,
 * such as using Redis pub/sub or a similar message broker.
 */

/*
import { DurableObject, RpcTarget } from 'cloudflare:workers';

export class Transcriptionator extends DurableObject<Env> {
	private observers: Set<WebSocket>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.observers = new Set();
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		// Only handle observer connections now
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		server.accept();

		console.log('New observer WebSocket connection');

		this.observers.add(server);
		server.addEventListener('close', () => {
			this.observers.delete(server);
			server.close();
		});

		server.addEventListener('error', () => {
			this.observers.delete(server);
			server.close();
			console.error(`Observer connection closed with error.`);
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	// RPC method to broadcast messages to all observers
	broadcastMessage(data: string): void {
		this.observers.forEach((observer) => {
			try {
				observer.send(data);
			} catch (error) {
				console.error('Failed to send to observer:', error);
				// Remove failed observers
				this.observers.delete(observer);
			}
		});
	}

	// RPC method to handle session closure
	notifySessionClosed(): void {
		console.log('Transcription session closed');
		// Optionally close all observers or keep them open
		// For now, we'll keep them open to allow reconnection
	}
}
*/
