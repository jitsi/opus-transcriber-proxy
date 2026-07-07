/**
 * Unit tests for the Worker /translate dispatcher forwarder (worker/dispatcherForwarder.ts):
 * lazy connect, queue-and-drain, the bounded queue (oldest dropped), send-failure recovery, and
 * reconnect after the DO socket closes. The Dispatcher DO binding is faked with plain objects.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDispatcherForwarder, DISPATCHER_QUEUE_LIMIT } from '../../worker/dispatcherForwarder';

type Listener = (e: any) => void;

function fakeDoSocket() {
	const listeners: Record<string, Listener[]> = {};
	return {
		accepted: false,
		sent: [] as string[],
		accept() {
			this.accepted = true;
		},
		send(d: string) {
			this.sent.push(d);
		},
		close() {
			this.emit('close', {});
		},
		addEventListener(type: string, l: Listener) {
			(listeners[type] ??= []).push(l);
		},
		emit(type: string, e: any) {
			for (const l of listeners[type] ?? []) l(e);
		},
	};
}

/** A fake Env with a DISPATCHER_DO whose stub resolves each fetch via `next()`. */
function fakeEnv(next: () => Promise<{ webSocket: any; status?: number }>) {
	const fetchMock = vi.fn(async () => next());
	return {
		env: { DISPATCHER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: fetchMock }) } } as any,
		fetchMock,
	};
}

const msg = (n: number) => ({ sessionId: 's1', endpointId: 'ep', text: `t${n}`, timestamp: n });

async function settle() {
	await new Promise((r) => setTimeout(r, 0));
}

describe('createDispatcherForwarder', () => {
	it('lazily connects on the first forward and drains the queue in order', async () => {
		const socket = fakeDoSocket();
		const { env, fetchMock } = fakeEnv(async () => ({ webSocket: socket }));
		const fwd = createDispatcherForwarder(env, 's1');

		expect(fetchMock).not.toHaveBeenCalled(); // nothing until the first forward
		fwd.forward(msg(1));
		fwd.forward(msg(2));
		await settle();

		expect(socket.accepted).toBe(true);
		expect(socket.sent.map((s) => JSON.parse(s).text)).toEqual(['t1', 't2']);

		fwd.forward(msg(3)); // connected now — direct send, no re-fetch
		expect(socket.sent).toHaveLength(3);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('bounds the queue while disconnected, dropping the oldest', async () => {
		// First connect attempts fail (no webSocket in the response), so everything queues.
		let socket: any = null;
		const { env } = fakeEnv(async () => ({ webSocket: socket, status: 502 }));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {}); // failed upgrades are logged
		const fwd = createDispatcherForwarder(env, 's1');

		const total = DISPATCHER_QUEUE_LIMIT + 10;
		for (let i = 0; i < total; i++) fwd.forward(msg(i));
		await settle();
		expect(warn).toHaveBeenCalledTimes(1); // warned once, not per drop

		// Now let a connect succeed and verify only the newest LIMIT messages are drained.
		socket = fakeDoSocket();
		fwd.forward(msg(total));
		await settle();

		const texts = socket.sent.map((s: string) => JSON.parse(s).text);
		expect(texts).toHaveLength(DISPATCHER_QUEUE_LIMIT);
		expect(texts[0]).toBe(`t${total - DISPATCHER_QUEUE_LIMIT + 1}`); // oldest were dropped
		expect(texts[texts.length - 1]).toBe(`t${total}`);
	});

	it('reconnects after the DO socket closes and keeps forwarding', async () => {
		const first = fakeDoSocket();
		const second = fakeDoSocket();
		let call = 0;
		const { env, fetchMock } = fakeEnv(async () => ({ webSocket: call++ === 0 ? first : second }));
		const fwd = createDispatcherForwarder(env, 's1');

		fwd.forward(msg(1));
		await settle();
		expect(first.sent).toHaveLength(1);

		first.close(); // DO side drops the socket
		fwd.forward(msg(2));
		await settle();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(second.sent.map((s: string) => JSON.parse(s).text)).toEqual(['t2']);
	});

	it('logs an upgrade that resolves without a webSocket (non-101) instead of failing silently', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { env } = fakeEnv(async () => ({ webSocket: null, status: 502 }));
		const fwd = createDispatcherForwarder(env, 's1');

		fwd.forward(msg(1));
		await settle();

		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0][0])).toContain('HTTP 502');
	});

	it('survives a connect failure (fetch throws) and logs it', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { env } = fakeEnv(async () => {
			throw new Error('DO unavailable');
		});
		const fwd = createDispatcherForwarder(env, 's1');

		fwd.forward(msg(1));
		await settle();
		expect(error).toHaveBeenCalled();
		fwd.close(); // no throw
	});
});
