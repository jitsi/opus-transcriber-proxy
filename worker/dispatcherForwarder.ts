// Dispatcher output for the Worker-hosted /translate (see handleTranslate.ts): final transcripts
// are forwarded to the per-session Dispatcher DO. Kept in its own module (no .wasm imports) so it
// can be unit-tested.

import type { Env } from './env';
import type { DispatcherTranscriptionMessage } from './index';

/** Bound on the dispatcher forward queue: with the DO persistently unreachable, a long-lived
 * session would otherwise accumulate one entry per final transcript indefinitely. */
export const DISPATCHER_QUEUE_LIMIT = 100;

/**
 * Forwards final transcripts to the per-session Dispatcher DO over a lazily-opened WebSocket,
 * mirroring the container path's dispatcher output (worker/index.ts). Deliberately simpler than
 * that path's reconnect machinery: messages are queued (bounded, oldest dropped) while
 * (re)connecting, and a dropped socket is reopened on the next forward.
 */
export function createDispatcherForwarder(env: Env, sessionId: string) {
	let ws: WebSocket | null = null;
	let connecting = false;
	let dropped = 0;
	const queue: DispatcherTranscriptionMessage[] = [];

	async function connect(): Promise<void> {
		if (connecting || !env.DISPATCHER_DO) return;
		connecting = true;
		try {
			const stub = env.DISPATCHER_DO.get(env.DISPATCHER_DO.idFromName(sessionId));
			const resp = await stub.fetch(new Request('http://dispatcher/websocket', { headers: { Upgrade: 'websocket' } }));
			if (resp.webSocket) {
				resp.webSocket.accept();
				resp.webSocket.addEventListener('close', () => {
					ws = null; // reopened on the next forward
				});
				ws = resp.webSocket;
				console.log(
					`Connected to Dispatcher DO via WebSocket for session: ${sessionId}` +
						(queue.length ? `, draining ${queue.length} queued message(s)` : '') +
						(dropped ? ` (${dropped} dropped while disconnected)` : ''),
				);
				dropped = 0;
				for (const msg of queue.splice(0)) ws.send(JSON.stringify(msg));
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`Failed to connect to Dispatcher DO: ${msg}, sessionId=${sessionId}`);
		} finally {
			connecting = false;
		}
	}

	return {
		forward(msg: DispatcherTranscriptionMessage): void {
			if (ws) {
				try {
					ws.send(JSON.stringify(msg));
					return;
				} catch {
					ws = null;
				}
			}
			queue.push(msg);
			if (queue.length > DISPATCHER_QUEUE_LIMIT) {
				queue.shift(); // drop the oldest — recent finals are worth more than stale ones
				if (++dropped === 1) {
					console.warn(`Dispatcher queue full (${DISPATCHER_QUEUE_LIMIT}), dropping oldest, sessionId=${sessionId}`);
				}
			}
			void connect();
		},
		close(): void {
			try {
				ws?.close();
			} catch {
				// already closed
			}
			ws = null;
		},
	};
}
