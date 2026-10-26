/*
 * Copyright @ 2025 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Unit tests for worker/sessionProxy.ts (`handleWebSocketWithDispatcher`): the client↔container
 * WebSocket pipe the Worker builds on the dispatcher path, the `info` augmentation, dispatching
 * of final transcripts to the per-session Dispatcher DO (with queueing and reconnect while it is
 * away), the keepalive renewal loop, and close/error propagation between the three sockets.
 *
 * workerd's WebSocketPair / accept() surface and the READY_STATE_* statics are stubbed with plain
 * objects; the container and dispatcher Durable Object stubs are fakes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleWebSocketWithDispatcher } from '../../../worker/sessionProxy';

type Listener = (e: any) => void;

/** The close codes workerd's `close()` accepts; it throws on anything else (web-socket.c++). */
const sendable = (code: number) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

/**
 * A WebSocket fake with workerd's rules, so the proxy's close handling can actually fail here:
 * - `close()` throws on a code it cannot send and on a socket that is already closed, and emits
 *   nothing: a 'close' event only ever follows the *peer's* close frame;
 * - a peer's close (`remoteClose`) leaves the socket CLOSING until we reply with `close()`, since
 *   our compatibility date has no automatic reply;
 * - a peer error (`remoteError`) leaves the socket CLOSED.
 */
class FakeWs {
	readyState = 1;
	accepted = false;
	sent: unknown[] = [];
	closed: { code?: number; reason?: string } | null = null;
	private listeners = new Map<string, Listener[]>();
	accept() {
		this.accepted = true;
	}
	addEventListener(type: string, fn: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	send(data: unknown) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		if (code !== undefined && !sendable(code)) throw new Error(`InvalidAccessError: close code ${code} cannot be sent`);
		if (reason !== undefined && new TextEncoder().encode(reason).length > 123) throw new Error('SyntaxError: close reason longer than 123 bytes');
		if (this.readyState === 3 || this.closed) throw new Error('close() on a WebSocket that is already closed');
		// Replying to the peer's close completes the handshake; initiating one leaves us CLOSING.
		this.readyState = this.readyState === 2 ? 3 : 2;
		this.closed = { code, reason };
	}
	emit(type: string, event: any = {}) {
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** The peer sent a close frame: CLOSING until our handler replies. */
	remoteClose(code: number, reason: string) {
		this.readyState = 2;
		this.emit('close', { code, reason });
	}
	/** The connection failed: the socket is already CLOSED when the 'error' listener runs. */
	remoteError() {
		this.readyState = 3;
		this.emit('error', {});
	}
	sentJson(): any[] {
		return this.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m));
	}
}

const pairs: Array<[FakeWs, FakeWs]> = [];

function stubWorkerdGlobals() {
	pairs.length = 0;
	vi.stubGlobal(
		'WebSocketPair',
		class {
			0 = new FakeWs();
			1 = new FakeWs();
			constructor() {
				pairs.push([this[0], this[1]]);
			}
		},
	);
	vi.stubGlobal('WebSocket', { READY_STATE_CONNECTING: 0, READY_STATE_OPEN: 1, READY_STATE_CLOSING: 2, READY_STATE_CLOSED: 3 });
	// workerd's Response accepts status 101 plus a `webSocket`; Node's rejects any status < 200.
	const NodeResponse = Response;
	vi.stubGlobal(
		'Response',
		class extends NodeResponse {
			readonly webSocket?: unknown;
			constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
				if (init?.status === 101) {
					super(body, { ...init, status: 200 });
					Object.defineProperty(this, 'status', { value: 101 });
					this.webSocket = init.webSocket;
				} else {
					super(body, init);
				}
			}
		},
	);
}

interface SetupOptions {
	/** What the container stub's fetch yields: a 101 with a socket (default), a plain Response, or a rejection. */
	containerFetch?: () => Promise<unknown>;
	/** What the Dispatcher DO's fetch yields; default is an upgrade carrying a fresh socket. */
	dispatcherFetch?: () => Promise<unknown>;
	/** Omit the DISPATCHER_DO binding entirely. */
	noDispatcherBinding?: boolean;
	/** Extra env vars, e.g. OTLP_ENDPOINT to have metrics pushed. */
	env?: Record<string, string>;
}

function prepare(opts: SetupOptions = {}) {
	stubWorkerdGlobals();
	const containerWs = new FakeWs();
	const container = {
		fetch: vi.fn(opts.containerFetch ?? (async () => ({ status: 101, webSocket: containerWs }))),
		renewActivityTimeout: vi.fn(async () => {}),
	};
	const dispatcherWs = new FakeWs();
	const doFetch = vi.fn(opts.dispatcherFetch ?? (async () => ({ webSocket: dispatcherWs })));
	const env = {
		...(opts.noDispatcherBinding ? {} : { DISPATCHER_DO: { idFromName: vi.fn(() => 'do-id'), get: vi.fn(() => ({ fetch: doFetch })) } }),
		...opts.env,
	};
	const ctx = { waitUntil: vi.fn() };
	const request = new Request('https://opus.example/transcribe?sessionId=s1', { headers: { Upgrade: 'websocket' } });
	const run = () => handleWebSocketWithDispatcher(request, container as any, env as any, ctx as any, 's1');
	return { run, containerWs, dispatcherWs, container, doFetch, ctx };
}

async function setup(opts: SetupOptions = {}) {
	const fx = prepare(opts);
	const res = await fx.run();
	const [clientWs, serverWs] = pairs[0];
	return { ...fx, res, clientWs, serverWs };
}

const finalTranscript = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		type: 'transcription-result',
		is_interim: false,
		participant: { id: 'p1' },
		transcript: [{ text: 'hello' }, { text: 'world' }],
		timestamp: 123,
		language: 'en',
		...overrides,
	});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('handleWebSocketWithDispatcher: setup', () => {
	it('returns the client half of a pair and wires up the container and dispatcher sockets', async () => {
		const { res, clientWs, serverWs, containerWs, dispatcherWs, doFetch } = await setup();
		expect(res.status).toBe(101);
		expect((res as any).webSocket).toBe(clientWs);
		expect(serverWs.accepted).toBe(true);
		expect(containerWs.accepted).toBe(true);
		expect(dispatcherWs.accepted).toBe(true);
		expect(doFetch).toHaveBeenCalledTimes(1);
		const upgradeReq = doFetch.mock.calls[0][0] as Request;
		expect(upgradeReq.headers.get('Upgrade')).toBe('websocket');
	});

	it('closes the client with 1011 and returns the container response when the container does not upgrade', async () => {
		const containerResponse = new Response('Failed to start container: x', { status: 500 });
		const { res, serverWs } = await setup({ containerFetch: async () => containerResponse });
		expect(res).toBe(containerResponse);
		expect(serverWs.closed).toEqual({ code: 1011, reason: 'Container failed to upgrade WebSocket' });
	});

	it('answers 503 and closes the client with 1011 when the container stub throws', async () => {
		const { res, serverWs } = await setup({
			containerFetch: async () => {
				throw new Error('boom');
			},
		});
		expect(res.status).toBe(503);
		expect(serverWs.closed).toEqual({ code: 1011, reason: 'Container unreachable: boom' });
	});

	it.each([
		['stub_failed', async () => Promise.reject(new Error('boom'))],
		['disconnected', async () => new Response('x', { status: 500, headers: { 'X-Container-Failure': 'disconnected' } })],
		['start_failed', async () => new Response('x', { status: 503, headers: { 'X-Container-Failure': 'start_failed' } })],
	])('counts a container that is unreachable after starting (%s)', async (reason, containerFetch) => {
		const collector = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, body: null }));
		vi.stubGlobal('fetch', collector);
		const { ctx } = await setup({ containerFetch, env: { OTLP_ENDPOINT: 'https://collector.example' } });
		await Promise.all(ctx.waitUntil.mock.calls.map(([p]) => p));
		const sent = collector.mock.calls.map(([, init]) => JSON.parse(init.body as string));
		const points = sent.flatMap((body) => body.resourceMetrics[0].scopeMetrics[0].metrics.flatMap((m: any) => m.sum.dataPoints));
		const hit = points.find((p: any) => p.asInt === '1');
		expect(Object.fromEntries(hit.attributes.map((a: any) => [a.key, a.value.stringValue]))).toMatchObject({ path: 'dispatcher', reason });
	});

	it("does not count the container server's own refusal of an upgrade as unreachable", async () => {
		const collector = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, body: null }));
		vi.stubGlobal('fetch', collector);
		const { ctx } = await setup({
			containerFetch: async () => new Response('agent not configured', { status: 503 }),
			env: { OTLP_ENDPOINT: 'https://collector.example' },
		});
		expect(ctx.waitUntil).not.toHaveBeenCalled();
		expect(collector).not.toHaveBeenCalled();
	});
});

describe('handleWebSocketWithDispatcher: piping', () => {
	it('forwards client frames to the container only while the container socket is open', async () => {
		const { serverWs, containerWs } = await setup();
		serverWs.emit('message', { data: '{"event":"media"}' });
		expect(containerWs.sent).toEqual(['{"event":"media"}']);
		containerWs.readyState = 3;
		serverWs.emit('message', { data: '{"event":"media"}' });
		expect(containerWs.sent).toHaveLength(1);
	});

	it('forwards container messages to the client, including non-JSON frames', async () => {
		const { serverWs, containerWs, dispatcherWs } = await setup();
		containerWs.emit('message', { data: 'not json' });
		containerWs.emit('message', { data: '{"event":"pong","id":1}' });
		expect(serverWs.sent).toEqual(['not json', '{"event":"pong","id":1}']);
		expect(dispatcherWs.sent).toEqual([]);
	});

	it("merges a `worker` block into the container's info message and does not dispatch it", async () => {
		const { serverWs, containerWs, dispatcherWs } = await setup();
		containerWs.emit('message', { data: JSON.stringify({ event: 'info', gitHash: 'abc1234', runtime: 'cloudflare-container' }) });
		const [info] = serverWs.sentJson();
		expect(info.gitHash).toBe('abc1234');
		expect(info.worker).toEqual({ present: true, routingMode: 'session' });
		expect(dispatcherWs.sent).toEqual([]);
	});
});

describe('handleWebSocketWithDispatcher: dispatching', () => {
	it('dispatches a final transcription in the dispatcher shape and still forwards it to the client', async () => {
		const { serverWs, containerWs, dispatcherWs } = await setup();
		const raw = finalTranscript();
		containerWs.emit('message', { data: raw });
		expect(serverWs.sent).toEqual([raw]);
		expect(dispatcherWs.sentJson()).toEqual([{ sessionId: 's1', endpointId: 'p1', text: 'hello world', timestamp: 123, language: 'en' }]);
	});

	it('does not dispatch interims, and dispatches /translate finals too', async () => {
		const { containerWs, dispatcherWs } = await setup();
		containerWs.emit('message', { data: finalTranscript({ is_interim: true }) });
		expect(dispatcherWs.sent).toEqual([]);
		containerWs.emit('message', { data: finalTranscript({ type: 'realtime-translation-result', participant: {} }) });
		expect(dispatcherWs.sentJson()).toEqual([{ sessionId: 's1', endpointId: 'unknown', text: 'hello world', timestamp: 123, language: 'en' }]);
	});

	it('queues finals while the dispatcher is away and flushes them after the backoff reconnect', async () => {
		vi.useFakeTimers();
		const laterWs = new FakeWs();
		let attempts = 0;
		const { containerWs } = await setup({
			dispatcherFetch: async () => (attempts++ === 0 ? { webSocket: undefined } : { webSocket: laterWs }),
		});
		containerWs.emit('message', { data: finalTranscript() });
		containerWs.emit('message', { data: finalTranscript({ timestamp: 124 }) });
		expect(laterWs.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(999);
		expect(laterWs.sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(laterWs.accepted).toBe(true);
		expect(laterWs.sentJson().map((m) => m.timestamp)).toEqual([123, 124]);
	});

	it('queues a final that arrives before the Dispatcher DO connect resolves, and flushes it once connected', async () => {
		// The container sends its first messages the instant it accepts the upgrade, which is
		// before the Dispatcher DO round trip completes.
		vi.useFakeTimers();
		let resolveConnect!: (v: unknown) => void;
		const { run, containerWs, dispatcherWs, doFetch } = prepare({
			dispatcherFetch: () => new Promise((resolve) => (resolveConnect = resolve)),
		});
		const pending = run();
		await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
		containerWs.emit('message', { data: finalTranscript() });
		expect(dispatcherWs.sent).toEqual([]);
		resolveConnect({ webSocket: dispatcherWs });
		await pending;
		expect(dispatcherWs.sentJson().map((m) => m.text)).toEqual(['hello world']);
		// The queued final must not also have started a backoff reconnect.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(doFetch).toHaveBeenCalledTimes(1);
	});

	it('closes a reconnect socket that resolves after the session has ended, and does not reconnect again', async () => {
		vi.useFakeTimers();
		const first = new FakeWs();
		const late = new FakeWs();
		let resolveSecond!: (v: unknown) => void;
		let attempts = 0;
		const { serverWs, doFetch } = await setup({
			dispatcherFetch: () => (attempts++ === 0 ? Promise.resolve({ webSocket: first }) : new Promise((resolve) => (resolveSecond = resolve))),
		});
		first.remoteClose(1012, 'dispatcher restarting');
		await vi.advanceTimersByTimeAsync(1000);
		expect(doFetch).toHaveBeenCalledTimes(2);
		serverWs.remoteClose(1000, 'bye');
		resolveSecond({ webSocket: late });
		await vi.advanceTimersByTimeAsync(0);
		expect(late.closed).toEqual({ code: 1000, reason: 'Session ended' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(doFetch).toHaveBeenCalledTimes(2);
	});

	it('does not open a second dispatcher socket for a final that arrives while a reconnect is in flight', async () => {
		vi.useFakeTimers();
		const first = new FakeWs();
		const second = new FakeWs();
		let resolveSecond!: (v: unknown) => void;
		let attempts = 0;
		const { containerWs, doFetch } = await setup({
			dispatcherFetch: () => (attempts++ === 0 ? Promise.resolve({ webSocket: first }) : new Promise((resolve) => (resolveSecond = resolve))),
		});
		first.remoteClose(1012, 'dispatcher restarting');
		await vi.advanceTimersByTimeAsync(1000);
		expect(doFetch).toHaveBeenCalledTimes(2);
		containerWs.emit('message', { data: finalTranscript() });
		await vi.advanceTimersByTimeAsync(5000);
		expect(doFetch).toHaveBeenCalledTimes(2);
		resolveSecond({ webSocket: second });
		await vi.advanceTimersByTimeAsync(0);
		expect(second.sentJson()).toHaveLength(1);
	});

	it('waits for an in-flight reconnect dial instead of dialling again when the session ends during it', async () => {
		vi.useFakeTimers();
		const first = new FakeWs();
		const second = new FakeWs();
		let resolveSecond!: (v: unknown) => void;
		let attempts = 0;
		const { serverWs, containerWs, doFetch, ctx } = await setup({
			dispatcherFetch: () => (attempts++ === 0 ? Promise.resolve({ webSocket: first }) : new Promise((resolve) => (resolveSecond = resolve))),
		});
		first.remoteClose(1012, 'dispatcher restarting');
		await vi.advanceTimersByTimeAsync(1000);
		expect(doFetch).toHaveBeenCalledTimes(2);
		containerWs.emit('message', { data: finalTranscript() });
		serverWs.remoteClose(1000, 'bye');
		expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
		resolveSecond({ webSocket: second });
		await vi.advanceTimersByTimeAsync(0);
		await ctx.waitUntil.mock.calls[0][0];
		expect(doFetch).toHaveBeenCalledTimes(2);
		expect(second.sentJson()).toHaveLength(1);
		expect(second.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});

	it('replies to a dispatcher close frame instead of leaving that socket CLOSING', async () => {
		vi.useFakeTimers();
		const { dispatcherWs } = await setup();
		dispatcherWs.remoteClose(1012, 'dispatcher restarting');
		expect(dispatcherWs.closed).toEqual({ code: 1012, reason: 'dispatcher restarting' });
		expect(dispatcherWs.readyState).toBe(3);
	});

	it('ignores a late close from a dispatcher socket that has already been replaced', async () => {
		vi.useFakeTimers();
		const first = new FakeWs();
		const second = new FakeWs();
		const sockets = [first, second, new FakeWs()];
		const { containerWs, doFetch } = await setup({ dispatcherFetch: async () => ({ webSocket: sockets.shift() }) });
		// The first socket errors; the next final reconnects to a second one.
		first.remoteError();
		containerWs.emit('message', { data: finalTranscript() });
		await vi.advanceTimersByTimeAsync(1000);
		expect(doFetch).toHaveBeenCalledTimes(2);
		expect(second.sentJson()).toHaveLength(1);
		// Then the dead first socket's close arrives late: it must not start a third dial.
		first.emit('close', { code: 1006, reason: '' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(doFetch).toHaveBeenCalledTimes(2);
		expect(second.closed).toBeNull();
	});

	it('cancels a pending reconnect backoff when the session ends', async () => {
		vi.useFakeTimers();
		const { serverWs, dispatcherWs, doFetch } = await setup();
		dispatcherWs.remoteClose(1012, 'dispatcher restarting');
		serverWs.remoteClose(1000, 'bye');
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(doFetch).toHaveBeenCalledTimes(1);
	});

	it('bounds the queue while the dispatcher is away, dropping the oldest finals', async () => {
		vi.useFakeTimers();
		const later = new FakeWs();
		let attempts = 0;
		const { containerWs } = await setup({
			dispatcherFetch: async () => (attempts++ === 0 ? { webSocket: undefined } : { webSocket: later }),
		});
		for (let i = 0; i < 105; i++) {
			containerWs.emit('message', { data: finalTranscript({ timestamp: i }) });
		}
		await vi.advanceTimersByTimeAsync(1000);
		const sent = later.sentJson().map((m) => m.timestamp);
		expect(sent).toHaveLength(100);
		expect(sent[0]).toBe(5);
		expect(sent[99]).toBe(104);
	});

	it('still closes the other side and flushes when one close() throws', async () => {
		let attempts = 0;
		const laterWs = new FakeWs();
		const { containerWs, serverWs, ctx } = await setup({
			dispatcherFetch: async () => (attempts++ === 0 ? { webSocket: undefined } : { webSocket: laterWs }),
		});
		containerWs.emit('message', { data: finalTranscript() });
		vi.spyOn(serverWs, 'close').mockImplementation(() => {
			throw new Error('unexpected state');
		});
		serverWs.remoteClose(1000, 'bye');
		expect(containerWs.closed).toEqual({ code: 1000, reason: 'bye' });
		expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
		await ctx.waitUntil.mock.calls[0][0];
		expect(laterWs.sentJson()).toHaveLength(1);
	});

	it('flushes queued finals when the client errors out, via waitUntil', async () => {
		let attempts = 0;
		const laterWs = new FakeWs();
		const { containerWs, serverWs, ctx } = await setup({
			dispatcherFetch: async () => (attempts++ === 0 ? { webSocket: undefined } : { webSocket: laterWs }),
		});
		containerWs.emit('message', { data: finalTranscript() });
		serverWs.remoteError();
		expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
		await ctx.waitUntil.mock.calls[0][0];
		expect(laterWs.sentJson()).toHaveLength(1);
		expect(laterWs.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});

	it('closes a dispatcher socket that resolves after the client has already gone', async () => {
		let resolveConnect!: (v: unknown) => void;
		const { run, dispatcherWs, doFetch } = prepare({
			dispatcherFetch: () => new Promise((resolve) => (resolveConnect = resolve)),
		});
		const pending = run();
		await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
		const [, serverWs] = pairs[0];
		serverWs.remoteClose(1000, 'bye');
		resolveConnect({ webSocket: dispatcherWs });
		await pending;
		expect(dispatcherWs.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});

	it('sends a final queued during the first connect exactly once, on one socket, when the client closes meanwhile', async () => {
		// The flush-on-close waits for the in-flight initial connect instead of dialling a second
		// socket; the initial connect's own completion finds the session closed, flushes and closes.
		let resolveConnect!: (v: unknown) => void;
		const socket = new FakeWs();
		const { run, containerWs, doFetch, ctx } = prepare({
			dispatcherFetch: () => new Promise((resolve) => (resolveConnect = resolve)),
		});
		const pending = run();
		await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
		containerWs.emit('message', { data: finalTranscript() });
		const [, serverWs] = pairs[0];
		serverWs.remoteClose(1000, 'bye');
		expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
		resolveConnect({ webSocket: socket });
		await pending;
		await ctx.waitUntil.mock.calls[0][0];
		expect(doFetch).toHaveBeenCalledTimes(1);
		expect(socket.sentJson().map((m) => m.text)).toEqual(['hello world']);
		expect(socket.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});

	it('dials once from the flush-on-close when the initial connect fails after the session ended', async () => {
		let resolveConnect!: (v: unknown) => void;
		const later = new FakeWs();
		let attempts = 0;
		const { run, containerWs, doFetch, ctx } = prepare({
			dispatcherFetch: () => (attempts++ === 0 ? new Promise((resolve) => (resolveConnect = resolve)) : Promise.resolve({ webSocket: later })),
		});
		const pending = run();
		await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
		containerWs.emit('message', { data: finalTranscript() });
		const [, serverWs] = pairs[0];
		serverWs.remoteClose(1000, 'bye');
		resolveConnect({ webSocket: undefined });
		await pending;
		await ctx.waitUntil.mock.calls[0][0];
		expect(doFetch).toHaveBeenCalledTimes(2);
		expect(later.sentJson()).toHaveLength(1);
		expect(later.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});

	it('caps close reasons at 123 UTF-8 bytes', async () => {
		const long = 'é'.repeat(200);
		const a = await setup({
			containerFetch: async () => {
				throw new Error(long);
			},
		});
		expect(a.serverWs.closed?.code).toBe(1011);
		expect(a.serverWs.closed?.reason?.startsWith('Container unreachable: ')).toBe(true);
		expect(new TextEncoder().encode(a.serverWs.closed?.reason ?? '').length).toBeLessThanOrEqual(123);
		const b = await setup();
		b.containerWs.remoteClose(1001, long);
		expect(new TextEncoder().encode(b.serverWs.closed?.reason ?? '').length).toBeLessThanOrEqual(123);
	});

	it('closes the client when the container drops while the dispatcher connect is still pending', async () => {
		let resolveConnect!: (v: unknown) => void;
		const { run, containerWs, doFetch } = prepare({
			dispatcherFetch: () => new Promise((resolve) => (resolveConnect = resolve)),
		});
		const pending = run();
		await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
		const [, serverWs] = pairs[0];
		containerWs.remoteClose(1006, '');
		expect(serverWs.closed).toEqual({ code: 1011, reason: 'Container connection closed' });
		resolveConnect({ webSocket: undefined });
		await pending;
	});

	it('retries on backoff when the first dispatcher connect fails with finals already queued', async () => {
		vi.useFakeTimers();
		let resolveConnect!: (v: unknown) => void;
		const later = new FakeWs();
		let attempts = 0;
		const { run, containerWs, doFetch } = prepare({
			dispatcherFetch: () => (attempts++ === 0 ? new Promise((resolve) => (resolveConnect = resolve)) : Promise.resolve({ webSocket: later })),
		});
		const pending = run();
		await vi.waitFor(() => expect(doFetch).toHaveBeenCalledTimes(1));
		containerWs.emit('message', { data: finalTranscript() });
		resolveConnect({ webSocket: undefined });
		await pending;
		await vi.advanceTimersByTimeAsync(1000);
		expect(doFetch).toHaveBeenCalledTimes(2);
		expect(later.sentJson()).toHaveLength(1);
	});

	it('reconnects with backoff when the dispatcher drops mid-session, and resets the backoff after a stable connect', async () => {
		vi.useFakeTimers();
		const first = new FakeWs();
		const second = new FakeWs();
		const third = new FakeWs();
		const sockets = [first, second, third];
		const { doFetch } = await setup({ dispatcherFetch: async () => ({ webSocket: sockets.shift() }) });
		expect(first.accepted).toBe(true);
		first.remoteClose(1012, 'dispatcher restarting');
		await vi.advanceTimersByTimeAsync(999);
		expect(doFetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(doFetch).toHaveBeenCalledTimes(2);
		expect(second.accepted).toBe(true);
		second.remoteClose(1012, 'again');
		await vi.advanceTimersByTimeAsync(1000);
		expect(doFetch).toHaveBeenCalledTimes(3);
		expect(third.accepted).toBe(true);
	});

	it('flushes queued finals on close via waitUntil', async () => {
		let attempts = 0;
		const laterWs = new FakeWs();
		const { containerWs, serverWs, ctx } = await setup({
			dispatcherFetch: async () => (attempts++ === 0 ? { webSocket: undefined } : { webSocket: laterWs }),
		});
		containerWs.emit('message', { data: finalTranscript() });
		serverWs.remoteClose(1000, 'done');
		expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
		await ctx.waitUntil.mock.calls[0][0];
		expect(laterWs.sentJson()).toHaveLength(1);
		expect(laterWs.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});

	it('neither dispatches nor queues when there is no dispatcher binding', async () => {
		const { containerWs, serverWs, doFetch } = await setup({ noDispatcherBinding: true });
		containerWs.emit('message', { data: finalTranscript() });
		expect(serverWs.sent).toHaveLength(1);
		expect(doFetch).not.toHaveBeenCalled();
	});
});

describe('handleWebSocketWithDispatcher: keepalive', () => {
	it('renews the container activity timeout every 3 minutes until the client closes', async () => {
		vi.useFakeTimers();
		const { container, serverWs } = await setup();
		await vi.advanceTimersByTimeAsync(180_000);
		expect(container.renewActivityTimeout).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(180_000);
		expect(container.renewActivityTimeout).toHaveBeenCalledTimes(2);
		serverWs.remoteClose(1000, '');
		await vi.advanceTimersByTimeAsync(360_000);
		expect(container.renewActivityTimeout).toHaveBeenCalledTimes(2);
	});

	it('survives a failed renewal and tries again next tick', async () => {
		vi.useFakeTimers();
		const { container } = await setup();
		container.renewActivityTimeout.mockRejectedValueOnce(new Error('rpc blip'));
		await vi.advanceTimersByTimeAsync(360_000);
		expect(container.renewActivityTimeout).toHaveBeenCalledTimes(2);
	});
});

describe('handleWebSocketWithDispatcher: close and error propagation', () => {
	it('propagates a client close code and reason to the container, replies to the client, and ends the dispatcher session', async () => {
		const { serverWs, containerWs, dispatcherWs } = await setup();
		serverWs.remoteClose(1001, 'going away');
		expect(containerWs.closed).toEqual({ code: 1001, reason: 'going away' });
		// The close handshake is completed on the socket that closed (no automatic reply on our
		// compatibility date), so the client is not left waiting out its close timeout.
		expect(serverWs.closed).toEqual({ code: 1001, reason: 'going away' });
		expect(serverWs.readyState).toBe(3);
		expect(dispatcherWs.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});

	it("logs the dispatcher's close reply after the session ended at info, and a mid-session drop at error", async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const dispatcherLines = (spy: typeof error) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('Dispatcher WebSocket closed'));
		try {
			const { serverWs, dispatcherWs } = await setup();
			serverWs.remoteClose(1000, 'bye');
			expect(dispatcherWs.closed).toEqual({ code: 1000, reason: 'Session ended' });
			// The DO replies to our close: the handshake completing, which is healthy.
			dispatcherWs.remoteClose(1000, 'Session ended');
			expect(dispatcherLines(error)).toEqual([]);
			expect(dispatcherLines(log)).toEqual(['Dispatcher WebSocket closed: code=1000, reason=Session ended, sessionId=s1']);
		} finally {
			error.mockRestore();
			log.mockRestore();
		}

		const error2 = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			vi.useFakeTimers();
			const { dispatcherWs } = await setup();
			dispatcherWs.remoteClose(1006, '');
			expect(dispatcherLines(error2)).toEqual(['Dispatcher WebSocket closed: code=1006, reason=none, sessionId=s1']);
		} finally {
			error2.mockRestore();
			vi.useRealTimers();
		}
	});

	it('propagates a container close to the client, replies to the container, with a fallback reason', async () => {
		const { serverWs, containerWs, dispatcherWs } = await setup();
		containerWs.remoteClose(1001, '');
		expect(serverWs.closed).toEqual({ code: 1001, reason: 'Container connection closed' });
		expect(containerWs.closed).toEqual({ code: 1001, reason: '' });
		expect(dispatcherWs.closed).toEqual({ code: 1000, reason: 'Container disconnected' });
	});

	it('replaces codes workerd cannot send: a silent client close becomes 1000, a vanished container becomes 1011', async () => {
		// Seen on dev: a client closing without a status code (1005) made containerWs.close(1005)
		// throw, which fired the error handler and closed the container side with 1011 instead.
		// The fake throws on 1004/1005/1006/1015 exactly as workerd does.
		for (const code of [1005, 1006, 1004, 1015]) {
			const a = await setup();
			a.serverWs.remoteClose(code, '');
			expect(a.containerWs.closed).toEqual({ code: 1000, reason: '' });
			expect(a.serverWs.closed).toEqual({ code: 1000, reason: '' });
			const b = await setup();
			b.containerWs.remoteClose(code, 'gone');
			// A container that vanished must stay visible to the bridge as a failure, not a clean close.
			expect(b.serverWs.closed).toEqual({ code: 1011, reason: 'gone' });
			expect(b.containerWs.closed).toEqual({ code: 1000, reason: 'gone' });
		}
	});

	it('does not reconnect the dispatcher after the container has gone', async () => {
		vi.useFakeTimers();
		const { containerWs, dispatcherWs, doFetch } = await setup();
		containerWs.remoteClose(1006, '');
		expect(dispatcherWs.closed).toEqual({ code: 1000, reason: 'Container disconnected' });
		// The dispatcher completes the close handshake; its close event must not start a reconnect.
		dispatcherWs.remoteClose(1000, 'Container disconnected');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(doFetch).toHaveBeenCalledTimes(1);
	});

	it('does not reconnect the dispatcher after a container socket error', async () => {
		vi.useFakeTimers();
		const { containerWs, dispatcherWs, doFetch } = await setup();
		containerWs.remoteError();
		dispatcherWs.remoteClose(1000, 'Container disconnected');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(doFetch).toHaveBeenCalledTimes(1);
	});

	it('passes application close codes (e.g. the agent protocol) through unchanged', async () => {
		const { serverWs, containerWs } = await setup();
		containerWs.remoteClose(4001, 'agent ended');
		expect(serverWs.closed).toEqual({ code: 4001, reason: 'agent ended' });
	});

	it('closes the client with 1011 on a container socket error, without touching the dead socket', async () => {
		const { serverWs, containerWs, dispatcherWs } = await setup();
		containerWs.remoteError();
		expect(serverWs.closed).toEqual({ code: 1011, reason: 'Container connection error' });
		expect(containerWs.closed).toBeNull();
		expect(dispatcherWs.closed).toEqual({ code: 1000, reason: 'Container disconnected' });
	});

	it('closes the container with 1011 on a client socket error, without touching the dead socket', async () => {
		const { serverWs, containerWs, dispatcherWs } = await setup();
		serverWs.remoteError();
		expect(containerWs.closed).toEqual({ code: 1011, reason: 'Client WebSocket error' });
		expect(serverWs.closed).toBeNull();
		expect(dispatcherWs.closed).toEqual({ code: 1000, reason: 'Session ended' });
	});
});
