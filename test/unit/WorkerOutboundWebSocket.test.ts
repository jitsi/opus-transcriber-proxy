/**
 * Unit tests for the Worker's outbound WebSocket wrapper (worker/outboundWebSocket.ts): the
 * fetch-upgrade connect, the send queue-and-drain, close-before-connect, error handling, and the
 * readyState state machine (CONNECTING → OPEN → CLOSING → CLOSED, no regressions).
 *
 * workerd's fetch-upgrade surface (Response.webSocket + accept()) is faked with plain objects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerOutboundWebSocket } from '../../worker/outboundWebSocket';

type Listener = (e: any) => void;

function fakeUpgradeSocket() {
	const listeners: Record<string, Listener[]> = {};
	return {
		accepted: false,
		sent: [] as string[],
		closed: false,
		accept() {
			this.accepted = true;
		},
		send(d: string) {
			this.sent.push(d);
		},
		close() {
			this.closed = true;
			this.emit('close', { code: 1005, wasClean: true });
		},
		addEventListener(type: string, l: Listener) {
			(listeners[type] ??= []).push(l);
		},
		emit(type: string, e: any) {
			for (const l of listeners[type] ?? []) l(e);
		},
	};
}

/** Flush the microtask-deferred connect and its awaits. */
async function settle() {
	await new Promise((r) => setTimeout(r, 0));
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetchResolving(socket: any) {
	globalThis.fetch = vi.fn(async () => ({ status: 101, webSocket: socket })) as any;
}

describe('WorkerOutboundWebSocket', () => {
	it('connects, dispatches open, and sends directly once connected', async () => {
		const socket = fakeUpgradeSocket();
		mockFetchResolving(socket);

		const ws = new WorkerOutboundWebSocket('wss://example.com/rt');
		const opened = vi.fn();
		ws.addEventListener('open', opened);
		expect(ws.readyState).toBe(0); // CONNECTING

		await settle();
		expect(socket.accepted).toBe(true);
		expect(opened).toHaveBeenCalledTimes(1);
		expect(ws.readyState).toBe(1); // OPEN

		ws.send('hello');
		expect(socket.sent).toEqual(['hello']);
	});

	it('rewrites ws(s):// to http(s):// and applies bearer/protocol headers', async () => {
		const socket = fakeUpgradeSocket();
		mockFetchResolving(socket);

		new WorkerOutboundWebSocket('wss://example.com/rt', { bearerToken: 'tok', protocols: ['realtime'] });
		await settle();

		const [url, init] = (globalThis.fetch as any).mock.calls[0];
		expect(url).toBe('https://example.com/rt');
		const headers = init.headers as Headers;
		expect(headers.get('Upgrade')).toBe('websocket');
		expect(headers.get('Authorization')).toBe('Bearer tok');
		expect(headers.get('Sec-WebSocket-Protocol')).toBe('realtime');
	});

	it('queues sends before connect and flushes them in order on open', async () => {
		const socket = fakeUpgradeSocket();
		mockFetchResolving(socket);

		const ws = new WorkerOutboundWebSocket('wss://example.com/rt');
		ws.send('one');
		ws.send('two');
		expect(socket.sent).toEqual([]); // not connected yet

		await settle();
		expect(socket.sent).toEqual(['one', 'two']);
	});

	it('close before connect: no open event, socket closed, readyState never regresses to OPEN', async () => {
		const socket = fakeUpgradeSocket();
		mockFetchResolving(socket);

		const ws = new WorkerOutboundWebSocket('wss://example.com/rt');
		const opened = vi.fn();
		const closed = vi.fn();
		ws.addEventListener('open', opened);
		ws.addEventListener('close', closed);

		ws.close();
		expect(ws.readyState).toBe(2); // CLOSING

		await settle();
		expect(opened).not.toHaveBeenCalled();
		expect(socket.closed).toBe(true);
		expect(closed).toHaveBeenCalledTimes(1);
		expect(ws.readyState).toBe(3); // CLOSED — and never OPEN in between
	});

	it('drains queued sends before a caller-requested close (drain-then-close)', async () => {
		const socket = fakeUpgradeSocket();
		mockFetchResolving(socket);

		const ws = new WorkerOutboundWebSocket('wss://example.com/rt');
		ws.send('last-words');
		ws.close();

		await settle();
		expect(socket.sent).toEqual(['last-words']);
		expect(socket.closed).toBe(true);
	});

	it('dispatches error+close (readyState CLOSED) when the upgrade returns no webSocket', async () => {
		globalThis.fetch = vi.fn(async () => ({ status: 502, webSocket: null })) as any;

		const ws = new WorkerOutboundWebSocket('wss://example.com/rt');
		const errors: any[] = [];
		const closes: any[] = [];
		ws.addEventListener('error', (e) => errors.push(e));
		ws.addEventListener('close', (e) => closes.push(e));

		await settle();
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain('HTTP 502');
		expect(closes).toHaveLength(1);
		expect(closes[0].code).toBe(1006);
		expect(ws.readyState).toBe(3);
	});

	it('a synchronous fetch throw is still delivered to listeners attached after the constructor', async () => {
		// Without the microtask-deferred connect, a synchronous throw would dispatch error/close
		// before the caller can attach listeners, and the failure would be lost.
		globalThis.fetch = vi.fn(() => {
			throw new Error('sync boom');
		}) as any;

		const ws = new WorkerOutboundWebSocket('wss://example.com/rt');
		const errors: any[] = [];
		ws.addEventListener('error', (e) => errors.push(e));

		await settle();
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe('sync boom');
		expect(ws.readyState).toBe(3);
	});

	it('a throwing listener does not prevent the remaining listeners from running', async () => {
		const socket = fakeUpgradeSocket();
		mockFetchResolving(socket);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		const ws = new WorkerOutboundWebSocket('wss://example.com/rt');
		const second = vi.fn();
		ws.addEventListener('open', () => {
			throw new Error('listener boom');
		});
		ws.addEventListener('open', second);

		await settle();
		expect(second).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalled();
	});
});
