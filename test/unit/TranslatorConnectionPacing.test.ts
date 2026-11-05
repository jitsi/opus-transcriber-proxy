/*
 * Copyright @ 2026 - present 8x8, Inc.
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
 * Pacing tests for TranslatorConnection. The providers deliver translated audio faster than real time (xAI hands
 * over a whole phrase, several seconds of audio, in one burst of a few hundred milliseconds), and a burst longer
 * than a WebRTC client's jitter buffer makes the client flush and lose part of it. So the connection queues the
 * encoded voice frames in a MediaPacer and releases one per 20 ms, at most `paceLeadMs` ahead of real time. The
 * harness mirrors the talk-boundary tests': an encoder that emits one frame per delta (3 bytes, the first of which
 * counts the deltas so a test can tell which frames survived), a fake provider socket driven directly, and fake
 * timers so release times and the RTP timeline are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslatorConnection } from '../../src/TranslatorConnection';
import { RTP_CLOCK_RATE, FRAME_DURATION_MS } from '../../src/RtpTimestamper';
import type { TranslationRuntime } from '../../src/translate/runtime';

const SAMPLES_PER_FRAME = (RTP_CLOCK_RATE * FRAME_DURATION_MS) / 1000;
const TALK_TIMEOUT_MS = 300;
// The default lead (200 ms) is ten frames: that many are released at once, the rest one per 20 ms.
const LEAD_MS = 200;
const LEAD_FRAMES = LEAD_MS / FRAME_DURATION_MS;

interface FakeWs {
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	addEventListener: (type: string, cb: (ev?: any) => void) => void;
	readyState: number;
	fireOpen: () => void;
	fireMessage: (data: string) => void;
	fireClose: () => void;
}

function makeFakeWebSocket(): FakeWs {
	const listeners: Record<string, (ev?: any) => void> = {};
	return {
		send: vi.fn(),
		close: vi.fn(),
		addEventListener: (type: string, cb: (ev?: any) => void) => {
			listeners[type] = cb;
		},
		readyState: 1,
		fireOpen: () => listeners.open?.(),
		fireMessage: (data: string) => listeners.message?.({ data }),
		fireClose: () => listeners.close?.({ code: 1000, reason: '', wasClean: true }),
	};
}

let mockInDtx = false;
let encodedFrames = 0;

function makeHarness(
	paceLeadMs: number | undefined,
	configOverrides: Partial<TranslationRuntime['config']> = {},
): { runtime: TranslationRuntime; sockets: FakeWs[] } {
	const sockets: FakeWs[] = [];
	const runtime: TranslationRuntime = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		config: {
			openaiApiKey: 'test-key',
			translationModel: 'test-model',
			emitTranscripts: false,
			debug: false,
			translationUsageUrl: 'https://usage.test/report',
			usageReportIntervalMs: 0,
			talkSilenceTimeoutMs: TALK_TIMEOUT_MS,
			paceLeadMs,
			...configOverrides,
		},
		writeMetric: () => {},
		createMetricBatcher: () => ({ increment: () => {}, flush: () => {} }),
		createOutboundWebSocket: () => {
			const ws = makeFakeWebSocket();
			sockets.push(ws);
			return ws as any;
		},
		createOpusDecoder: () =>
			({
				ready: Promise.resolve(),
				decodeFrame: () => ({ audioData: new Uint8Array(0), samplesDecoded: 0, sampleRate: 24000, channels: 1, errors: [] }),
				conceal: () => ({ audioData: new Uint8Array(0), samplesDecoded: 0, sampleRate: 24000, channels: 1, errors: [] }),
				reset: () => {},
				free: () => {},
			}) as any,
		createOpusEncoder: () =>
			({
				ready: Promise.resolve(),
				encodeFrame: () => [{ data: new Uint8Array([encodedFrames++ & 0xff, 2, 3]), inDtx: mockInDtx, audioLevel: 23 }],
				reset: () => {},
				free: () => {},
			}) as any,
		buildServerInfo: () => undefined,
	};
	return { runtime, sockets };
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const audioDelta = () => JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAA' });

describe('TranslatorConnection pacing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockInDtx = false;
		encodedFrames = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function connect(
		paceLeadMs: number | undefined = undefined,
		configOverrides: Partial<TranslationRuntime['config']> = {},
	): Promise<{
		conn: TranslatorConnection;
		ws: FakeWs;
		media: Array<[number, number, number]>; // [rtpSequenceNumber, timestamp, audioLevel]
		starts: Array<[string, number]>;
		stops: Array<[string, number, { bytesSent: number; duration: number }]>;
	}> {
		const { runtime, sockets } = makeHarness(paceLeadMs, configOverrides);
		const conn = new TranslatorConnection('55555555-a0', { targetLanguage: 'fr' }, runtime);
		const media: Array<[number, number, number]> = [];
		const starts: Array<[string, number]> = [];
		const stops: Array<[string, number, { bytesSent: number; duration: number }]> = [];
		conn.onAudioFrame = (_tag, seq, ts, _payload, audioLevel) => media.push([seq, ts, audioLevel ?? -1]);
		conn.onTalkStart = (tag, ts) => starts.push([tag, ts]);
		conn.onTalkStop = (tag, ts, mediaInfo) => stops.push([tag, ts, mediaInfo]);
		await flushMicrotasks();
		const ws = sockets[0];
		ws.fireOpen();
		await flushMicrotasks();
		return { conn, ws, media, starts, stops };
	}

	it('releases a burst at real time: the lead at once, then one frame per 20 ms, on a contiguous RTP timeline', async () => {
		const { ws, media, starts } = await connect();

		// 50 frames (1 s of media) arrive in one instant, as xAI delivers a translated phrase.
		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());
		expect(media).toHaveLength(LEAD_FRAMES); // only the lead is in flight
		expect(starts).toEqual([['55555555-a0', 0]]); // the talk opens on the first released frame

		await vi.advanceTimersByTimeAsync(FRAME_DURATION_MS * 5);
		expect(media).toHaveLength(LEAD_FRAMES + 5); // one more per frame period

		await vi.advanceTimersByTimeAsync(1000);
		expect(media).toHaveLength(50); // all of it, nothing lost

		// Paced release does not change what goes on the wire: sequence numbers and timestamps are contiguous,
		// and every frame carries the encoder's level.
		media.forEach(([seq, ts, level], i) => {
			expect(seq).toBe(i);
			expect(ts).toBe(i * SAMPLES_PER_FRAME);
			expect(level).toBe(23);
		});
	});

	it('keeps the talk open while frames are still queued and ends it once the burst has played out', async () => {
		const { ws, stops } = await connect();

		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());

		// 800 ms in, 40 frames have been released and 10 are still queued: the releases keep re-arming the
		// silence timer, so no stop yet.
		await vi.advanceTimersByTimeAsync(800);
		expect(stops).toEqual([]);

		// Past the end of the 1 s of media plus the silence timeout: one stop spanning the whole burst — the same
		// boundary the unpaced path reports (see TranslatorConnectionTalk.test.ts), since both measure playout.
		await vi.advanceTimersByTimeAsync(50 * FRAME_DURATION_MS + TALK_TIMEOUT_MS + 100);
		expect(stops).toEqual([['55555555-a0', 50 * SAMPLES_PER_FRAME, { bytesSent: 150, duration: 1000 }]]);
	});

	it('does not pace DTX frames: they are dropped before the queue and take no release slot', async () => {
		const { ws, media } = await connect();

		for (let i = 0; i < LEAD_FRAMES; i++) ws.fireMessage(audioDelta()); // voice: fills the lead
		mockInDtx = true;
		for (let i = 0; i < 10; i++) ws.fireMessage(audioDelta()); // silence: dropped
		mockInDtx = false;
		for (let i = 0; i < 5; i++) ws.fireMessage(audioDelta()); // voice: queued behind the lead
		expect(media).toHaveLength(LEAD_FRAMES);

		await vi.advanceTimersByTimeAsync(5 * FRAME_DURATION_MS);
		expect(media).toHaveLength(LEAD_FRAMES + 5); // the DTX frames neither went out nor delayed these
		await vi.advanceTimersByTimeAsync(1000);
		expect(media).toHaveLength(LEAD_FRAMES + 5);
	});

	it('paces a second burst after a silence gap from real time again, with the gap in the RTP timeline', async () => {
		const { ws, media, starts, stops } = await connect();

		for (let i = 0; i < 20; i++) ws.fireMessage(audioDelta());
		await vi.advanceTimersByTimeAsync(20 * FRAME_DURATION_MS + TALK_TIMEOUT_MS + 3000); // played out, talk ended
		expect(media).toHaveLength(20);
		expect(stops).toHaveLength(1);

		// The next phrase: released from now (not from where the previous burst's clock stopped), so the first
		// lead's worth goes out at once and the timeline jumps by the real silence.
		for (let i = 0; i < 20; i++) ws.fireMessage(audioDelta());
		expect(media).toHaveLength(20 + LEAD_FRAMES);
		expect(starts).toHaveLength(2);
		expect(media[20][1] - media[19][1]).toBeGreaterThan(100 * SAMPLES_PER_FRAME);
		await vi.advanceTimersByTimeAsync(1000);
		expect(media).toHaveLength(40);
	});

	it('releases the frames still queued at close at once, then ends the talk over all of them', async () => {
		const { conn, ws, media, stops } = await connect();

		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());
		expect(media).toHaveLength(LEAD_FRAMES);

		// The direction is closed mid-phrase (the provider dropped it, or the speaker left). The remaining 40
		// frames go out now rather than being lost — the pre-pacer behaviour for this tail — on the contiguous
		// timeline, and the one talk stop spans the whole second of audio.
		conn.close();
		expect(media).toHaveLength(50);
		media.forEach(([seq, ts], i) => {
			expect(seq).toBe(i);
			expect(ts).toBe(i * SAMPLES_PER_FRAME);
		});
		expect(stops).toEqual([['55555555-a0', 50 * SAMPLES_PER_FRAME, { bytesSent: 150, duration: 1000 }]]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(media).toHaveLength(50);
		expect(stops).toHaveLength(1);
	});

	it('caps the queue at 15 s of audio, dropping the oldest 3 s as one block, warning once, counting them and reporting the total at close', async () => {
		const { runtime, sockets } = makeHarness(undefined);
		const increments: Array<Record<string, unknown>> = [];
		runtime.createMetricBatcher = () => ({ increment: (m) => increments.push(m), flush: () => {} });
		const conn = new TranslatorConnection('55555555-a0', { targetLanguage: 'fr' }, runtime);
		const played: number[] = []; // the encoder's frame counter, from the payload's first byte
		conn.onAudioFrame = (_tag, _seq, _ts, payload) => played.push(Buffer.from(payload, 'base64')[0]);
		await flushMicrotasks();
		const ws = sockets[0];
		ws.fireOpen();
		await flushMicrotasks();
		const warnings = () => (runtime.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m as string);

		const cap = (15 * 1000) / FRAME_DURATION_MS; // 750
		const block = (3 * 1000) / FRAME_DURATION_MS; // 150
		// A burst of the lead, a full queue and one frame more: that frame evicts a whole block, not one frame.
		for (let i = 0; i < LEAD_FRAMES + cap + 1; i++) ws.fireMessage(audioDelta());
		expect(played).toHaveLength(LEAD_FRAMES);
		const dropped = () => increments.filter((m) => m.name === 'translation_paced_frames_dropped').reduce((n, m) => n + (m.count as number), 0);
		expect(dropped()).toBe(block);
		expect(warnings().filter((m) => /behind real time/.test(m))).toHaveLength(1);

		// The next block's worth of frames fits without another drop; one more past that evicts the next block.
		for (let i = 0; i < block - 1; i++) ws.fireMessage(audioDelta());
		expect(dropped()).toBe(block);
		ws.fireMessage(audioDelta());
		expect(dropped()).toBe(2 * block);
		expect(warnings().filter((m) => /behind real time/.test(m))).toHaveLength(1); // still once

		await vi.advanceTimersByTimeAsync(30_000);
		// What played: the lead, then the queue with the two oldest blocks cut out as contiguous runs (frame
		// counters wrap at 256, so compare modulo).
		const expected = [...Array(LEAD_FRAMES).keys()];
		for (let i = LEAD_FRAMES + 2 * block; i < LEAD_FRAMES + cap + 1 + block; i++) expected.push(i & 0xff);
		expect(played).toEqual(expected);

		conn.close();
		expect(warnings().filter((m) => /dropped 6 s of translated audio in total/.test(m))).toHaveLength(1);
	});

	it('releases at most 3 s of queued audio at close, drops the rest and warns', async () => {
		const { conn, ws, media, stops } = await connect();
		const warn = (conn as any).runtime.logger.warn as ReturnType<typeof vi.fn>;

		for (let i = 0; i < LEAD_FRAMES + 400; i++) ws.fireMessage(audioDelta()); // 8 s queued behind the lead
		conn.close();
		// The lead plus 3 s: a longer burst would be discarded by the client's jitter buffer anyway.
		expect(media).toHaveLength(LEAD_FRAMES + 150);
		expect(stops).toHaveLength(1);
		expect(stops[0][2].duration).toBe((LEAD_FRAMES + 150) * FRAME_DURATION_MS);
		expect(warn.mock.calls.filter(([m]) => /released 150 frame\(s\) at once, dropped 250/.test(m))).toHaveLength(1);
	});

	it('releases the queued tail before the talk stop and the closed notification on a provider-side close', async () => {
		const { conn, ws, media, stops } = await connect();
		const order: string[] = [];
		conn.onAudioFrame = (_tag, seq) => {
			media.push([seq, 0, 0]);
			order.push('frame');
		};
		conn.onTalkStop = () => order.push('stop');
		conn.onClosed = (_tag, reason) => order.push(`closed:${reason}`);

		for (let i = 0; i < 30; i++) ws.fireMessage(audioDelta());
		expect(media).toHaveLength(LEAD_FRAMES);
		order.length = 0;

		// The provider ends the session mid-phrase (its socket closes, as at xAI's session cap).
		ws.fireClose();
		expect(order.filter((o) => o === 'frame')).toHaveLength(20);
		expect(order.slice(-2)).toEqual(['stop', 'closed:rejected']); // (rejected: the fake session is seconds old)
		expect(order.indexOf('stop')).toBe(20); // every flushed frame went out before the stop
		expect(stops).toHaveLength(0); // (the harness's recorder was replaced above)
	});

	it('a send that throws during the close-time flush is counted once and does not stop the teardown', async () => {
		const { conn, ws, stops } = await connect();
		const runtime = (conn as any).runtime;
		let sent = 0;
		conn.onAudioFrame = () => {
			sent++;
			throw new Error('socket gone');
		};
		const closed: string[] = [];
		conn.onClosed = (_tag, reason) => closed.push(reason);
		for (let i = 0; i < 30; i++) ws.fireMessage(audioDelta());
		ws.fireClose();
		expect(sent).toBe(30); // every frame was attempted
		expect(closed).toEqual(['rejected']);
		expect(stops).toHaveLength(1); // the talk stop still fired
		const errors = runtime.logger.error.mock.calls.map((c: any[]) => String(c[0]));
		expect(errors.filter((m: string) => m.includes('Failed to send a paced frame'))).toHaveLength(1);
		expect(errors.filter((m: string) => /30 paced frame\(s\) failed to send/.test(m))).toHaveLength(1);
	});

	it('counts the frames dropped at close with a listener present, as reason close', async () => {
		const { conn, ws } = await connect();
		const increments: Array<Record<string, unknown>> = [];
		(conn as any).metricBatcher = { increment: (m: Record<string, unknown>) => increments.push(m), flush: () => {} };
		for (let i = 0; i < 400; i++) ws.fireMessage(audioDelta()); // 8 s queued beyond the lead
		ws.fireClose();
		const close = increments.filter((m) => m.name === 'translation_paced_frames_dropped' && m.errorType === 'close');
		expect(close).toHaveLength(1);
		expect(close[0].count).toBe(400 - LEAD_FRAMES - 150);
	});

	it('drops the queued tail without sending when told nobody is listening', async () => {
		const { conn, ws, media, stops } = await connect();
		const info = (conn as any).runtime.logger.info as ReturnType<typeof vi.fn>;

		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());
		expect(media).toHaveLength(LEAD_FRAMES);

		conn.close(/* releaseQueuedAudio */ false);
		expect(media).toHaveLength(LEAD_FRAMES);
		expect(stops).toHaveLength(1); // the talk still ends, over what was sent
		expect(stops[0][2].duration).toBe(LEAD_FRAMES * FRAME_DURATION_MS);
		expect(info.mock.calls.filter(([m]) => /released 0 frame\(s\) at once, dropped 40 \(no listener\)/.test(m))).toHaveLength(1);
	});

	it('does not close an idle direction while audio is still queued, even with the talk timer disabled', async () => {
		// Talk timer off (a talk never ends by silence) and a short idle close, as the pre-pacer guard could not
		// protect this case: the idle check used to look only at the talk.
		const { conn, ws, media } = await connect(undefined, { talkSilenceTimeoutMs: 0, idleCloseMs: 1000 });
		const closed = vi.fn();
		conn.onClosed = closed;
		conn.handleMediaEvent({ event: 'media', media: { tag: '55555555-a0', chunk: 1, timestamp: 0, payload: 'AAAA' } });

		await vi.advanceTimersByTimeAsync(900);
		for (let i = 0; i < 150; i++) ws.fireMessage(audioDelta()); // 3 s of translated audio lands just before the idle mark
		await vi.advanceTimersByTimeAsync(2000); // past the idle close, mid-release
		expect(closed).not.toHaveBeenCalled();
		expect(media.length).toBeGreaterThan(LEAD_FRAMES);
		expect(media.length).toBeLessThan(150);

		await vi.advanceTimersByTimeAsync(3000); // the queue has drained: now it may close
		expect(media).toHaveLength(150);
		expect(closed).toHaveBeenCalledWith('55555555-a0', 'idle');
	});

	it('with paceLeadMs 0 forwards every frame as it arrives (the pre-pacer behaviour)', async () => {
		const { ws, media } = await connect(0);

		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());
		expect(media).toHaveLength(50);
	});

	it('honours a configured lead', async () => {
		const { ws, media } = await connect(100);

		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());
		expect(media).toHaveLength(5); // 100 ms = five frames in flight
		await vi.advanceTimersByTimeAsync(1000);
		expect(media).toHaveLength(50);
	});
});
