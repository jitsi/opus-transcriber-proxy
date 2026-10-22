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
 * - audio/opus: no transcoding in either direction; the agent's 20 ms packets carry a decoded audio level
 * - speakers: the bridge's speaker order is passed on; the dominant fan-in forwards only the first source's audio
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentProxy, CLOSE_CODE_AGENT_ENDED, CLOSE_CODE_ENDPOINT_UNREACHABLE } from '../../src/agentproxy';

class MockWebSocket {
	sent: string[] = [];
	closed = false;
	closeCode?: number;
	closeReason?: string;
	listeners = new Map<string, Array<(event: any) => void>>();

	send(data: string) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.closed = true;
		this.closeCode = code;
		this.closeReason = reason;
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

	function createProxy(extra: Record<string, unknown> = {}) {
		const proxy = new AgentProxy(
			bridgeWs as any,
			{
				endpointUrl: 'wss://agents.example.com/session',
				createEndpointWebSocket: () => endpointWs as any,
				customParameters: { session: 's1' },
				paceLeadMs: 10_000, // effectively no pacing delay in tests unless stated otherwise
				...extra,
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

	it('reports active once the customer socket opens', async () => {
		const proxy = createProxy();
		const lifecycle: any[] = [];
		proxy.on('lifecycle', (e: any) => lifecycle.push(e));
		await settle();
		endpointWs.fire('open', {});

		expect(lifecycle).toEqual([ { state: 'active' } ]);
	});

	it('a refused dial reports failed and closes the bridge leg with the unreachable code', async () => {
		const proxy = createProxy();
		const lifecycle: any[] = [];
		proxy.on('lifecycle', (e: any) => lifecycle.push(e));
		proxy.on('error', () => undefined);
		await settle();

		endpointWs.fire('error', { message: 'Unexpected server response: 401' });
		endpointWs.fire('close', {});

		expect(lifecycle).toEqual([ { state: 'failed', reason: 'endpoint refused: HTTP 401' } ]);
		expect(bridgeWs.closeCode).toBe(CLOSE_CODE_ENDPOINT_UNREACHABLE);
		expect(bridgeWs.closeReason).toBe('endpoint refused: HTTP 401');
	});

	it('an unreachable endpoint reports failed with the error text', async () => {
		const proxy = createProxy();
		const lifecycle: any[] = [];
		proxy.on('lifecycle', (e: any) => lifecycle.push(e));
		proxy.on('error', () => undefined);
		await settle();

		endpointWs.fire('error', { message: 'connect ECONNREFUSED 127.0.0.1:9094' });

		expect(lifecycle).toEqual([ { state: 'failed', reason: 'endpoint unreachable: connect ECONNREFUSED 127.0.0.1:9094' } ]);
		expect(bridgeWs.closeCode).toBe(CLOSE_CODE_ENDPOINT_UNREACHABLE);
	});

	it('a mid-session endpoint loss closes normally so the bridge may redial', async () => {
		const proxy = createProxy();
		const lifecycle: any[] = [];
		proxy.on('lifecycle', (e: any) => lifecycle.push(e));
		proxy.on('error', () => undefined);
		await settle();
		endpointWs.fire('open', {});

		endpointWs.fire('error', { message: 'read ECONNRESET' });

		expect(lifecycle).toEqual([ { state: 'active' } ]);
		expect(bridgeWs.closed).toBe(true);
		expect(bridgeWs.closeCode).toBeUndefined();
	});

	it('end from the agent closes both legs, the bridge leg with the agent-ended code', async () => {
		const proxy = createProxy();
		const lifecycle: any[] = [];
		proxy.on('lifecycle', (e: any) => lifecycle.push(e));
		await settle();
		endpointWs.fire('open', {});
		await settle();
		const closed = vi.fn();
		proxy.on('closed', closed);

		endpointWs.receive({ event: 'end' });

		expect(lifecycle).toEqual([ { state: 'active' }, { state: 'ended', reason: 'agent ended' } ]);

		expect(endpointWs.closed).toBe(true);
		expect(bridgeWs.closed).toBe(true);
		expect(bridgeWs.closeCode).toBe(CLOSE_CODE_AGENT_ENDED);
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it('reports a session over once: an end after a failed dial, or a second end, changes nothing', async () => {
		const proxy = createProxy();
		const lifecycle: any[] = [];
		proxy.on('lifecycle', (e: any) => lifecycle.push(e));
		proxy.on('error', () => undefined);
		await settle();
		endpointWs.fire('error', { message: 'Unexpected server response: 401' });
		// `ws` still delivers messages while closing.
		endpointWs.receive({ event: 'end' });
		endpointWs.receive({ event: 'end' });
		await settle();

		expect(lifecycle).toEqual([ { state: 'failed', reason: 'endpoint refused: HTTP 401' } ]);
	});

	it('reports ended once for repeated ends', async () => {
		const proxy = createProxy();
		const lifecycle: any[] = [];
		proxy.on('lifecycle', (e: any) => lifecycle.push(e));
		await settle();
		endpointWs.fire('open', {});
		endpointWs.receive({ event: 'end' });
		endpointWs.receive({ event: 'end' });
		await settle();

		expect(lifecycle).toEqual([ { state: 'active' }, { state: 'ended', reason: 'agent ended' } ]);
		expect(bridgeWs.closeCode).toBe(CLOSE_CODE_AGENT_ENDED);
	});

	it('a decoder that fails to initialise ends the stream for the customer and drops its media, saying so once', async () => {
		decoder.ready = Promise.reject(new Error('no codec'));
		runtime = mockRuntime(decoder, encoder);
		createProxy();
		await settle();
		endpointWs.fire('open', {});
		bridgeWs.receive({ event: 'sources', exports: ['u1-a0'], requests: ['agent1-a0'] });
		bridgeWs.receive({ event: 'media', media: { tag: 'u1-a0', chunk: 0, timestamp: 100, payload: OPUS_B64 } });
		await settle();
		bridgeWs.receive({ event: 'media', media: { tag: 'u1-a0', chunk: 1, timestamp: 1060, payload: OPUS_B64 } });
		bridgeWs.receive({ event: 'media', media: { tag: 'u1-a0', chunk: 2, timestamp: 2020, payload: OPUS_B64 } });
		await settle();

		const events = endpointWs.sentJson().map((m) => m.event);
		expect(events).toContain('start');
		expect(events).toContain('stop');
		expect(events).not.toContain('media');
		expect(endpointWs.sentJson().find((m) => m.event === 'stop').stop.tag).toBe('u1-a0');
		expect(runtime.writeMetric).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent_decoder_failure' }));
		expect(runtime.logger.warn.mock.calls.filter((c: string[]) => /decoder failed/.test(c[0]))).toHaveLength(1);
	});

	it('keeps control messages while the customer socket is pending, dropping the oldest media instead', async () => {
		createProxy();
		await settle();
		bridgeWs.receive({ event: 'sources', exports: ['u1-a0', 'u2-a0'], requests: ['agent1-a0'] });
		// Fills the shared queue with one source's media (plus info and its start), then a second source arrives.
		for (let chunk = 0; chunk < 1000; chunk++) {
			bridgeWs.receive({ event: 'media', media: { tag: 'u1-a0', chunk, timestamp: 100 + chunk * 960, payload: OPUS_B64 } });
		}
		bridgeWs.receive({ event: 'media', media: { tag: 'u2-a0', chunk: 0, timestamp: 100, payload: OPUS_B64 } });
		bridgeWs.receive({ event: 'speakers', speakers: ['u2-a0', 'u1-a0'], silence: false });
		endpointWs.fire('open', {});
		await settle();

		const messages = endpointWs.sentJson();
		expect(messages.filter((m) => m.event === 'start').map((m) => m.start.tag)).toEqual(['u1-a0', 'u2-a0']);
		expect(messages.some((m) => m.event === 'speakers')).toBe(true);
		expect(messages.filter((m) => m.event === 'media').length).toBeLessThan(1001);
		expect(runtime.writeMetric).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent_media_dropped' }));
	});

	it('queues only the latest speakers while the customer socket is pending', async () => {
		createProxy();
		await settle();
		bridgeWs.receive({ event: 'sources', exports: ['u1-a0', 'u2-a0'], requests: ['agent1-a0'] });
		for (let i = 0; i < 1500; i++) {
			bridgeWs.receive({ event: 'speakers', speakers: i % 2 ? ['u2-a0', 'u1-a0'] : ['u1-a0', 'u2-a0'], silence: false });
		}
		bridgeWs.receive({ event: 'media', media: { tag: 'u1-a0', chunk: 0, timestamp: 100, payload: OPUS_B64 } });
		await settle();
		endpointWs.fire('open', {});

		const messages = endpointWs.sentJson();
		expect(messages.map((m) => m.event)).toEqual(['info', 'speakers', 'start', 'media']);
		expect(messages[1].speakers).toEqual(['u2-a0', 'u1-a0']);
		const sequence = messages.map((m) => m.sequenceNumber);
		expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
	});

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
		// The endpoint URL's path and query may carry the customer's credentials: logged by host only.
		expect(runtime.logger.info).toHaveBeenCalledWith('agent: connected to endpoint agents.example.com');
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

	it('carries the encoder audio level and vad on voice frames', async () => {
		const proxy = createProxy();
		const frames: any[] = [];
		proxy.on('audioFrame', (data: any) => frames.push(data));
		encoder.encodeFrame.mockImplementation(() => [{ data: new Uint8Array([9, 9]), inDtx: false, audioLevel: 42 }]);
		await settle();
		bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
		endpointWs.fire('open', {});
		await settle();

		endpointWs.receive({ event: 'media', media: { payload: PCM_B64 } });
		await settle();

		expect(frames.length).toBe(1);
		expect(frames[0].audioLevel).toBe(42);
		expect(frames[0].vad).toBe(true);
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

	describe('audio/opus', () => {
		// TOC bytes (RFC 6716 §3.1): CELT FB 20 ms (config 31), SILK WB 60 ms (config 11), both one frame (code 0).
		const OPUS_20MS = Buffer.from([0xf8, 1, 2, 3]);
		const OPUS_60MS = Buffer.from([0x58, 1, 2, 3]);

		async function openOpusProxy() {
			const proxy = createProxy({ encoding: 'audio/opus' });
			await settle();
			endpointWs.fire('open', {});
			bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
			await settle();
			return proxy;
		}

		it('announces Opus in info and start and transcodes nothing on the way to the agent', async () => {
			await openOpusProxy();
			bridgeWs.receive({ event: 'media', media: { tag: 'user1-a0', chunk: 7012, timestamp: 336000, payload: OPUS_B64 } });
			await settle();

			const messages = endpointWs.sentJson();
			const opusFormat = { encoding: 'audio/opus', sampleRate: 48000, channels: 1 };
			expect(messages.find((m) => m.event === 'info').mediaFormat).toEqual(opusFormat);
			expect(messages.find((m) => m.event === 'start').start.mediaFormat).toEqual(opusFormat);
			expect(messages.find((m) => m.event === 'media').media).toEqual({ tag: 'user1-a0', chunk: 7012, timestamp: 336000, payload: OPUS_B64 });
			expect(runtime.createOpusEncoder).not.toHaveBeenCalled();
			// Only the agent's level decoder; participant packets are never decoded.
			expect(runtime.createOpusDecoder).toHaveBeenCalledTimes(1);
			expect(decoder.decodeFrame).not.toHaveBeenCalled();
		});

		it('returns the agent\'s 20 ms packets unchanged, with an audio level', async () => {
			const proxy = await openOpusProxy();
			const frames: any[] = [];
			proxy.on('audioFrame', (data: any) => frames.push(data));

			endpointWs.receive({ event: 'media', media: { payload: OPUS_20MS.toString('base64') } });
			await settle();

			expect(frames.length).toBe(1);
			expect(frames[0].tag).toBe('agent1-a0');
			expect(Buffer.from(frames[0].payload, 'base64')).toEqual(OPUS_20MS);
			expect(frames[0].audioLevel).toBeGreaterThanOrEqual(0);
			expect(frames[0].audioLevel).toBeLessThanOrEqual(127);
			expect(frames[0].vad).toBe(true);
		});

		it('drops DTX packets and packets that decode to silence', async () => {
			const proxy = await openOpusProxy();
			const frames: any[] = [];
			proxy.on('audioFrame', (data: any) => frames.push(data));
			decoder.decodeFrame.mockImplementation(() => ({ audioData: new Uint8Array(960), samplesDecoded: 480, errors: [] }));

			endpointWs.receive({ event: 'media', media: { payload: Buffer.from([0xf8]).toString('base64') } });
			endpointWs.receive({ event: 'media', media: { payload: OPUS_20MS.toString('base64') } });
			await settle();

			expect(frames.length).toBe(0);
			expect(bridgeWs.closed).toBe(false);
		});

		it('forwards no participant packet without the bridge\'s chunk and timestamp', async () => {
			await openOpusProxy();
			bridgeWs.receive({ event: 'media', media: { tag: 'user1-a0', payload: OPUS_B64 } });
			await settle();

			expect(endpointWs.sentJson().filter((m) => m.event === 'media')).toEqual([]);
		});

		const violations: Array<[string, () => void, string]> = [
			['a packet that is not 20 ms', () => undefined, OPUS_60MS.toString('base64')],
			['an oversized packet', () => undefined, Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(1300, 7)]).toString('base64')],
			[
				'a packet that does not decode',
				() => decoder.decodeFrame.mockImplementation(() => ({ audioData: new Uint8Array(0), samplesDecoded: 0, errors: ['corrupt'] }) as any),
				OPUS_20MS.toString('base64'),
			],
		];
		for (const [what, arrange, payload] of violations) {
			it(`fails the session on ${what}, telling the agent why`, async () => {
				const proxy = await openOpusProxy();
				const lifecycle: any[] = [];
				proxy.on('lifecycle', (e: any) => lifecycle.push(e));
				arrange();

				endpointWs.receive({ event: 'media', media: { payload } });

				expect(lifecycle).toEqual([{ state: 'failed', reason: expect.stringMatching(/Opus packet/) }]);
				expect(bridgeWs.closeCode).toBe(CLOSE_CODE_ENDPOINT_UNREACHABLE);
				expect(endpointWs.closeCode).toBe(1008);
				expect(endpointWs.closeReason).toBe(lifecycle[0].reason);
			});
		}

		it('frees the level decoder when the session closes before it is ready', async () => {
			let ready!: () => void;
			const slow = { ...mockDecoder(), ready: new Promise<void>((resolve) => (ready = resolve)) };
			runtime.createOpusDecoder.mockImplementation(() => slow);
			const proxy = createProxy({ encoding: 'audio/opus' });
			proxy.close();
			ready();
			await settle();

			expect(slow.free).toHaveBeenCalled();
		});

		it('stops queueing agent audio far ahead of real time', async () => {
			const proxy = new AgentProxy(
				bridgeWs as any,
				{ endpointUrl: 'wss://agents.example.com/session', createEndpointWebSocket: () => endpointWs as any, paceLeadMs: 20, encoding: 'audio/opus' },
				runtime,
			);
			await settle();
			endpointWs.fire('open', {});
			bridgeWs.receive({ event: 'sources', exports: [], requests: ['agent1-a0'] });
			await settle();

			for (let i = 0; i < 3010; i++) {
				endpointWs.receive({ event: 'media', media: { payload: OPUS_20MS.toString('base64') } });
			}

			expect(runtime.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/frames queued/));
			proxy.close();
		});
	});

	describe('speakers and fan-in', () => {
		const media = (tag: string, chunk: number) => ({ event: 'media', media: { tag, chunk, timestamp: 100 + chunk * 960, payload: OPUS_B64 } });
		const forwarded = () => endpointWs.sentJson().filter((m) => m.event === 'media').map((m) => `${m.media.tag}#${m.media.chunk}`);
		const started = () => endpointWs.sentJson().filter((m) => m.event === 'start').map((m) => m.start.tag);

		async function openProxy(extra: Record<string, unknown> = {}) {
			const proxy = createProxy(extra);
			await settle();
			endpointWs.fire('open', {});
			bridgeWs.receive({ event: 'sources', exports: ['u1-a0', 'u2-a0'], requests: ['agent1-a0'] });
			await settle();
			return proxy;
		}

		it('announces the per-source fan-in by default and passes the speaker order on without gating', async () => {
			await openProxy();
			bridgeWs.receive({ event: 'speakers', speakers: ['u2-a0', 'u1-a0'], silence: false });
			bridgeWs.receive(media('u1-a0', 0));
			bridgeWs.receive(media('u2-a0', 0));
			await settle();

			const messages = endpointWs.sentJson();
			expect(messages.find((m) => m.event === 'info').fanIn).toBe('per-source');
			expect(messages.find((m) => m.event === 'info').version).toBe('1.1');
			const speakers = messages.find((m) => m.event === 'speakers');
			expect(speakers.speakers).toEqual(['u2-a0', 'u1-a0']);
			expect(speakers.silence).toBe(false);
			expect(forwarded()).toEqual(['u1-a0#0', 'u2-a0#0']);
		});

		it('dominant: forwards only the first listed source, following each new order', async () => {
			await openProxy({ fanIn: 'dominant' });
			bridgeWs.receive({ event: 'speakers', speakers: ['u1-a0', 'u2-a0'], silence: false });
			bridgeWs.receive(media('u1-a0', 0));
			bridgeWs.receive(media('u2-a0', 0));
			bridgeWs.receive({ event: 'speakers', speakers: ['u2-a0', 'u1-a0'], silence: false });
			bridgeWs.receive(media('u1-a0', 1));
			bridgeWs.receive(media('u2-a0', 1));
			await settle();

			expect(endpointWs.sentJson().find((m) => m.event === 'info').fanIn).toBe('dominant');
			expect(started()).toEqual(['u1-a0', 'u2-a0']);
			expect(forwarded()).toEqual(['u1-a0#0', 'u2-a0#0']);
			expect(runtime.logger.info).toHaveBeenCalledWith(expect.stringContaining('dominant speaker is now u2-a0'));
		});

		it('dominant: forwards nothing while nobody has spoken, and never the agent itself', async () => {
			await openProxy({ fanIn: 'dominant' });
			bridgeWs.receive({ event: 'speakers', speakers: [], silence: true });
			bridgeWs.receive(media('u1-a0', 0));
			bridgeWs.receive({ event: 'speakers', speakers: ['agent1-a0', 'u2-a0'], silence: false });
			bridgeWs.receive(media('u1-a0', 1));
			bridgeWs.receive(media('u2-a0', 0));
			await settle();

			expect(forwarded()).toEqual(['u2-a0#0']);
			const hints = endpointWs.sentJson().filter((m) => m.event === 'speakers').map((m) => m.speakers);
			expect(hints).toEqual([[], ['u2-a0']]);
		});

		it('dominant: forwards every source, warning once, when the bridge sends no speaker order', async () => {
			await openProxy({ fanIn: 'dominant' });
			bridgeWs.receive(media('u1-a0', 0));
			bridgeWs.receive(media('u2-a0', 0));
			await settle();

			expect(forwarded()).toEqual(['u1-a0#0', 'u2-a0#0']);
			const warnings = runtime.logger.warn.mock.calls.filter((c: string[]) => /speaker order/.test(c[0]));
			expect(warnings).toHaveLength(1);
		});

		it('dominant: gates the Opus passthrough the same way', async () => {
			await openProxy({ fanIn: 'dominant', encoding: 'audio/opus' });
			bridgeWs.receive({ event: 'speakers', speakers: ['u2-a0', 'u1-a0'], silence: false });
			bridgeWs.receive(media('u1-a0', 0));
			bridgeWs.receive(media('u2-a0', 7));
			await settle();

			expect(started()).toEqual(['u2-a0']);
			expect(forwarded()).toEqual(['u2-a0#7']);
		});
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
