// Outbound WebSocket for the Worker runtime: workerd has no `new WebSocket(url)` client, so the
// connection is a fetch() with an Upgrade header. Wrapped behind IWebSocket so the translation core
// stays runtime-agnostic. Kept in its own module (no .wasm imports) so it can be unit-tested.

import type { IWebSocket, OutboundWebSocketOptions } from '../src/translate/runtime';

type Listener = (event: any) => void;

export class WorkerOutboundWebSocket implements IWebSocket {
	private ws?: WebSocket;
	private sendQueue: string[] = [];
	private closedByCaller = false;
	private readonly listeners: Record<string, Listener[]> = { open: [], message: [], error: [], close: [] };
	public readyState = 0; // CONNECTING

	constructor(url: string, options?: OutboundWebSocketOptions) {
		// Defer the connection kick-off by a microtask: the async body of connect() runs synchronously
		// up to its first await, so a synchronous throw (e.g. an invalid header value) would otherwise
		// dispatch error/close before the caller has had a chance to attach listeners, and be lost.
		void Promise.resolve().then(() => this.connect(url, options));
	}

	private async connect(url: string, options?: OutboundWebSocketOptions): Promise<void> {
		try {
			const headers = new Headers({ Upgrade: 'websocket' });
			// Worker authenticates via the Authorization header (not the subprotocol) — sending both
			// makes OpenAI reject the connection.
			if (options?.bearerToken) {
				headers.set('Authorization', `Bearer ${options.bearerToken}`);
			}
			if (options?.protocols && options.protocols.length > 0) {
				headers.set('Sec-WebSocket-Protocol', options.protocols.join(', '));
			}
			// workerd's fetch-upgrade requires an http(s) scheme, not ws(s).
			const fetchUrl = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
			const resp = await fetch(fetchUrl, { headers });
			const ws = resp.webSocket;
			if (!ws) {
				throw new Error(`outbound WebSocket upgrade failed (HTTP ${resp.status})`);
			}
			ws.accept();
			this.ws = ws;
			// Don't regress CLOSING (set by a close() that raced the connect) back to OPEN.
			if (!this.closedByCaller) {
				this.readyState = 1; // OPEN
			}
			ws.addEventListener('message', (e) => this.dispatch('message', e));
			ws.addEventListener('close', (e) => {
				this.readyState = 3; // CLOSED
				this.dispatch('close', e);
			});
			ws.addEventListener('error', (e) => this.dispatch('error', e));
			// Drain-then-close by design: sends queued before close() are delivered before the close is
			// issued, so a short-lived session still gets its buffered frames out.
			for (const msg of this.sendQueue) ws.send(msg);
			this.sendQueue = [];
			if (this.closedByCaller) {
				ws.close();
				return;
			}
			this.dispatch('open', {});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.readyState = 3; // CLOSED
			this.dispatch('error', { message });
			this.dispatch('close', { code: 1006, reason: message.slice(0, 123), wasClean: false });
		}
	}

	send(data: string): void {
		if (this.ws) {
			this.ws.send(data);
		} else if (!this.closedByCaller) {
			this.sendQueue.push(data);
		}
	}

	close(code?: number, reason?: string): void {
		this.closedByCaller = true;
		if (this.readyState < 2) this.readyState = 2; // CLOSING (→ CLOSED on the close event)
		this.ws?.close(code, reason);
	}

	addEventListener(type: string, listener: Listener): void {
		(this.listeners[type] ??= []).push(listener);
	}

	private dispatch(type: string, event: any): void {
		for (const l of this.listeners[type] ?? []) {
			try {
				l(event);
			} catch (err) {
				// A throwing listener must not break the others, but log it so the failure is traceable.
				console.error(`WorkerOutboundWebSocket "${type}" listener threw:`, err);
			}
		}
	}
}
