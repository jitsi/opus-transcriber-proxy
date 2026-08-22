/**
 * Tests for AgentProxy (the /agent voice-agent relay).
 *
 * Covers:
 * - dials the customer endpoint and queues outbound messages until it opens
 * - forwards participant audio: start announcement + decoded PCM media per source
 * - never feeds the agent's own source back to the customer
 * - return path: customer PCM is encoded, DTX frames dropped, voice frames emitted with talk
 *   boundaries, tagged with the source name from the bridge's `sources` event
 * - clear (barge-in) empties the pacer queue
 * - mark is echoed back after the audio ahead of it is released
 * - endpoint failure closes the bridge socket (session retry via the bridge's reconnect)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentProxy } from '../../src/agentproxy';

class MockWebSocket {
	sent: string[] = [];
	closed = false;
	listeners = new Map<string, Array<(event: any) => void>>();

	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
		this.fire('close', {});
	}
	addEventListener(type: string, listener: (event: any) => void) {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}
	fire(type: string, event: any) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
	receive(message: Record<string, unknown>) {
		this.fire('message', { data: JSON.stringify(message) });
	}
	sentJson(): any[] {
		return this.sent.map((s) => JSON.parse(s));
	}
}

/** A decoder that "decodes" any opus frame to a fixed PCM buffer, ready immediately. */
function mockDecoder() {
	return {
		ready: Promise.resolve(),
		decodeFrame: vi.fn(() => ({ audioData: new Uint8Array([1, 2, 3, 4]), samplesDecoded: 2, errors: [] })),
		conceal: vi.fn(),
		reset: vi.fn(),
		free: vi.fn(),
	};
}

/**
 * An encoder that emits one voice frame per encodeFrame call by default; tests can push
 * `nextInDtx` values to control the DTX flag per emitted frame.
 */
function mockEncoder() {
	const nextInDtx: boolean[] = [];
	return {
		ready: Promise.resolve(),
		nextInDtx,
		encodeFrame: vi.fn(() => [{ data: new Uint8Array([9, 9]), inDtx: nextInDtx.shift() ?? false }]),
		getFrameSize: vi.fn(() => 480),
		getFrameSizeBytes: vi.fn(() => 960),
		free: vi.fn(),
	};
}

function mockRuntime(decoder: any, encoder: any): any {
	return {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		config: { talkSilenceTimeoutMs: 350 },
		writeMetric: vi.fn(),
		createMetricBatcher: () => ({ increment: vi.fn(), flush: vi.fn() }),
		createOutboundWebSocket: vi.fn(),
		createOpusDecoder: vi.fn(() => decoder),
		createOpusEncoder: vi.fn(() => encoder),
		buildServerInfo: () => undefined,
	};
}

const OPUS_B64 = Buffer.from([0, 1, 2]).toString('base64');
const PCM_B64 = Buffer.from(new Uint8Array(960)).toString('base64');

describe('AgentProxy', () => {
	let bridgeWs: MockWebSocket;
	let endpointWs: MockWebSocket;
	let decoder: ReturnType<typeof mockDecoder>;
	let encoder: ReturnType<typeof mockEncoder>;
	let runtime: any;

	beforeEach(() => {
		vi.useRealTimers();
		bridgeWs = new MockWebSocket();
		endpointWs = new MockWebSocket();
		decoder = mockDecoder();
		encoder = mockEncoder();
		runtime = mockRuntime(decoder, encoder);
	});

	function createProxy() {
		const proxy = new AgentProxy(
			bridgeWs as any,
			{
				endpointUrl: 'wss://agents.example.com/session',
				createEndpointWebSocket: () => endpointWs as any,
				customParameters: { session: 's1' },
				paceLeadMs: 10_000, // effectively no pacing delay in tests unless stated otherwise
			},
			runtime,
		);
		return proxy;
	}

	/** Flush microtasks (the endpoint connect and codec-ready continuations). */
	async function settle() {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	it('dials the endpoint and flushes queued messages once it opens', async () => {
		createProxy();
		await settle();
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		bridgeWs.receive({ event: 'media', media: { tag: 'user1-a0', chunk: 0, timestamp: 100, payload: OPUS_B64 } });
		await settle();
		// Nothing sent yet: the endpoint socket has not opened.
		expect(endpointWs.sent.length).toBe(0);

		endpointWs.fire('open', {});
		const events = endpointWs.sentJson().map((m) => m.event);
		// info + per-source start + the media for it, in order.
		expect(events).toEqual(['info', 'start', 'media']);
	});

	it('announces each source with the agent PCM format and forwards decoded media', async () => {
		createProxy();
		await settle();
		endpointWs.fire('open', {});
		await settle();
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		bridgeWs.receive({ event: 'media', media: { tag: 'user1-a0', chunk: 0, timestamp: 100, payload: OPUS_B64 } });
		bridgeWs.receive({ event: 'media', media: { tag: 'user1-a0', chunk: 1, timestamp: 1060, payload: OPUS_B64 } });
		await settle();

		const messages = endpointWs.sentJson();
		const start = messages.find((m) => m.event === 'start');
		expect(start.start.tag).toBe('user1-a0');
		expect(start.start.mediaFormat).toEqual({ encoding: 'audio/l16', sampleRate: 24000, channels: 1 });
		expect(start.start.customParameters).toEqual({ session: 's1' });

		const media = messages.filter((m) => m.event === 'media');
		expect(media.length).toBe(2);
		expect(media[0].media.tag).toBe('user1-a0');
		expect(media[0].media.chunk).toBe(0);
		expect(media[1].media.chunk).toBe(1);
		expect(media[1].media.timestamp).toBe(1060);
		expect(Buffer.from(media[0].media.payload, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
	});

	it('does not forward the agent\'s own source back to the customer', async () => {
		createProxy();
		await settle();
		endpointWs.fire('open', {});
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		bridgeWs.receive({ event: 'media', media: { tag: 'agent1-a0', chunk: 0, timestamp: 100, payload: OPUS_B64 } });
		await settle();
		const events = endpointWs.sentJson().map((m) => m.event);
		// The pipe works (info arrived) but the agent's own audio was not looped back.
		expect(events).toContain('info');
		expect(events).not.toContain('media');
	});

	it('encodes customer audio and emits it with talk boundaries on the agent tag', async () => {
		const proxy = createProxy();
		const frames: any[] = [];
		const talks: string[] = [];
		proxy.on('audioFrame', (data: any) => frames.push(data));
		proxy.on('talkStart', () => talks.push('start'));
		proxy.on('talkStop', () => talks.push('stop'));

		endpointWs.fire('open', {});
		await settle();
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		endpointWs.receive({ event: 'media', media: { payload: PCM_B64 } });
		await settle();

		expect(encoder.encodeFrame).toHaveBeenCalledTimes(1);
		expect(frames.length).toBe(1);
		expect(frames[0].tag).toBe('agent1-a0');
		expect(typeof frames[0].chunk).toBe('number');
		expect(typeof frames[0].timestamp).toBe('number');
		expect(talks).toEqual(['start']);
	});

	it('drops DTX (silence) frames from the return path', async () => {
		const proxy = createProxy();
		const frames: any[] = [];
		proxy.on('audioFrame', (data: any) => frames.push(data));

		endpointWs.fire('open', {});
		await settle();
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		encoder.nextInDtx.push(true);
		endpointWs.receive({ event: 'media', media: { payload: PCM_B64 } });
		endpointWs.receive({ event: 'media', media: { payload: PCM_B64 } });
		await settle();

		expect(encoder.encodeFrame).toHaveBeenCalledTimes(2);
		expect(frames.length).toBe(1);
	});

	it('clear empties the pacer queue (barge-in)', async () => {
		// A tiny lead budget so pushed frames stay queued rather than releasing immediately.
		const proxy = new AgentProxy(
			bridgeWs as any,
			{
				endpointUrl: 'wss://agents.example.com/session',
				createEndpointWebSocket: () => endpointWs as any,
				paceLeadMs: 20,
			},
			runtime,
		);
		const frames: any[] = [];
		proxy.on('audioFrame', (data: any) => frames.push(data));

		endpointWs.fire('open', {});
		await settle();
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		for (let i = 0; i < 5; i++) {
			endpointWs.receive({ event: 'media', media: { payload: PCM_B64 } });
		}
		await settle();
		const releasedBefore = frames.length;
		expect(releasedBefore).toBeLessThan(5);

		endpointWs.receive({ event: 'clear' });
		await new Promise((resolve) => setTimeout(resolve, 80));
		// Nothing further was released after the clear.
		expect(frames.length).toBe(releasedBefore);
	});

	it('echoes marks after the audio queued ahead of them', async () => {
		createProxy();
		await settle();
		endpointWs.fire('open', {});
		await settle();
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		endpointWs.receive({ event: 'media', media: { payload: PCM_B64 } });
		endpointWs.receive({ event: 'mark', mark: { name: 'checkpoint-1' } });
		await settle();

		const marks = endpointWs.sentJson().filter((m) => m.event === 'mark');
		expect(marks.length).toBe(1);
		expect(marks[0].mark.name).toBe('checkpoint-1');
	});

	it('closes the bridge socket when the endpoint leg fails', async () => {
		const proxy = createProxy();
		const events: string[] = [];
		proxy.on('error', () => events.push('error'));
		proxy.on('closed', () => events.push('closed'));

		await settle();
		endpointWs.fire('error', { message: 'connection refused' });

		expect(events).toEqual(['error', 'closed']);
		expect(bridgeWs.closed).toBe(true);
	});

	it('responds to bridge pings', async () => {
		createProxy();
		await settle();
		bridgeWs.receive({ event: 'ping', id: 7 });
		const pongs = bridgeWs.sentJson().filter((m) => m.event === 'pong');
		expect(pongs).toEqual([{ event: 'pong', id: 7 }]);
	});
});
