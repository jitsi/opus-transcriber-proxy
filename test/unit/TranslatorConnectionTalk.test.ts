/**
 * Talk-boundary tests for TranslatorConnection: a "talk" (one OpenAI response window that produced audio) is
 * bracketed by onTalkStart (first emitted frame) and onTalkStop (end-of-utterance). The harness supplies an encoder
 * that emits one Opus frame per audio delta and a fake OpenAI socket whose 'message' listener we drive directly.
 * Fake timers pin Date.now so the RtpTimestamper produces a deterministic, gap-free timeline (0, 960, ...).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslatorConnection } from '../../src/TranslatorConnection';
import { RTP_CLOCK_RATE, FRAME_DURATION_MS } from '../../src/RtpTimestamper';
import type { TranslationRuntime } from '../../src/translate/runtime';

// RtpTimestamper defaults: 48000 Hz, 20 ms frames -> 960 ticks/frame, first frame at timestamp 0. Derived from the
// same exported constants the production code uses so it can't drift if the frame duration ever changes.
const SAMPLES_PER_FRAME = (RTP_CLOCK_RATE * FRAME_DURATION_MS) / 1000;

interface FakeWs {
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	addEventListener: (type: string, cb: (ev?: any) => void) => void;
	readyState: number;
	fireOpen: () => void;
	/** Deliver an OpenAI message (its `data` is what handleOpenAIMessage parses). */
	fireMessage: (data: string) => void;
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
	};
}

/** Runtime whose encoder emits exactly one 3-byte Opus frame per encodeFrame call. */
function makeHarness(): { runtime: TranslationRuntime; sockets: FakeWs[] } {
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
			({ ready: Promise.resolve(), encodeFrame: () => [new Uint8Array([1, 2, 3])], reset: () => {}, free: () => {} }) as any,
		buildServerInfo: () => undefined,
	};
	return { runtime, sockets };
}

async function flushMicrotasks(): Promise<void> {
	// TranslatorConnection defers its OpenAI socket init to a microtask (so onError/onClosed are wired before a
	// synchronous `new WebSocket` failure can fire), and connect() awaits several more before the socket appears.
	// 20 turns of the microtask queue is comfortably enough to drain that chain before we assert.
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const audioDelta = () => JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' });
const outputAudioDone = () => JSON.stringify({ type: 'response.output_audio.done' });
const responseDone = () => JSON.stringify({ type: 'response.done' });

describe('TranslatorConnection talk boundaries', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function connect(): Promise<{
		conn: TranslatorConnection;
		ws: FakeWs;
		starts: Array<[string, number]>;
		stops: Array<[string, number, { bytesSent: number; duration: number }]>;
	}> {
		const { runtime, sockets } = makeHarness();
		const conn = new TranslatorConnection('55555555-a0', { targetLanguage: 'hi' }, runtime);
		const starts: Array<[string, number]> = [];
		const stops: Array<[string, number, { bytesSent: number; duration: number }]> = [];
		conn.onTalkStart = (tag, ts) => starts.push([tag, ts]);
		conn.onTalkStop = (tag, ts, mediaInfo) => stops.push([tag, ts, mediaInfo]);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		sockets[0].fireOpen();
		return { conn, ws: sockets[0], starts, stops };
	}

	it('brackets a talk: start on the first frame, stop at end-of-utterance', async () => {
		const { ws, starts, stops } = await connect();

		ws.fireMessage(audioDelta()); // first frame -> talk start at ts 0
		ws.fireMessage(audioDelta()); // second frame at ts 960, still the same talk
		expect(starts).toEqual([['55555555-a0', 0]]);
		expect(stops).toEqual([]);

		ws.fireMessage(responseDone()); // end of utterance -> stop at last frame end (960 + 960)
		// 2 frames of 3 bytes each -> bytesSent 6, duration 2 * 20 ms.
		expect(stops).toEqual([['55555555-a0', 2 * SAMPLES_PER_FRAME, { bytesSent: 6, duration: 40 }]]);
		// One talk only.
		expect(starts).toHaveLength(1);
	});

	it('stops once on the first end-of-utterance event; a trailing response.done is a no-op', async () => {
		const { ws, starts, stops } = await connect();

		ws.fireMessage(audioDelta()); // talk start at ts 0
		ws.fireMessage(audioDelta()); // second frame at ts 960

		// The real OpenAI sequence closes a response window with response.output_audio.done *and then*
		// response.done — both reach the same end-of-utterance handler. The stop must fire on the first, and
		// endTalk()'s idempotence must make the trailing response.done a no-op (no double-emit).
		ws.fireMessage(outputAudioDone());
		expect(stops).toEqual([['55555555-a0', 2 * SAMPLES_PER_FRAME, { bytesSent: 6, duration: 40 }]]);

		ws.fireMessage(responseDone());
		expect(stops).toHaveLength(1);
		expect(starts).toHaveLength(1);
	});

	it('opens a fresh talk for the next response window', async () => {
		const { ws, starts, stops } = await connect();

		ws.fireMessage(audioDelta());
		ws.fireMessage(responseDone());
		ws.fireMessage(audioDelta());
		ws.fireMessage(responseDone());

		expect(starts).toHaveLength(2);
		expect(stops).toHaveLength(2);
		// First talk: one frame at ts 0 -> stop at 960. Second talk: next frame at ts 960 -> stop at 1920.
		// Each talk is one 3-byte frame -> bytesSent 3, duration 20 ms.
		expect(starts[0]).toEqual(['55555555-a0', 0]);
		expect(stops[0]).toEqual(['55555555-a0', SAMPLES_PER_FRAME, { bytesSent: 3, duration: 20 }]);
		expect(starts[1]).toEqual(['55555555-a0', SAMPLES_PER_FRAME]);
		expect(stops[1]).toEqual(['55555555-a0', 2 * SAMPLES_PER_FRAME, { bytesSent: 3, duration: 20 }]);
	});

	it('duration is the full [start, stop) span, including a mid-run silence gap', async () => {
		const { ws, stops } = await connect();

		ws.fireMessage(audioDelta()); // frame 1 at ts 0 (talk start)
		// Advance the clock past the gap threshold (100 ms) so the RtpTimestamper inserts a silence jump before the
		// next frame — the run's span then far exceeds the 2 frames of actual audio.
		await vi.advanceTimersByTimeAsync(500);
		ws.fireMessage(audioDelta()); // frame 2 at a jumped-forward ts
		ws.fireMessage(responseDone());

		expect(stops).toHaveLength(1);
		const [tag, stopTs, mediaInfo] = stops[0];
		expect(tag).toBe('55555555-a0');
		// bytesSent is the real audio (2 * 3 bytes). duration is the [start, stop) span: the talk started at ts 0,
		// so duration == stopTs converted to ms (48 ticks/ms) — it absorbs the inserted gap and is far more than the
		// 2 * 20 ms of actual audio.
		expect(mediaInfo.bytesSent).toBe(6);
		expect(mediaInfo.duration).toBe(Math.round(stopTs / 48));
		expect(stopTs).toBeGreaterThan(2 * SAMPLES_PER_FRAME);
		expect(mediaInfo.duration).toBeGreaterThan(40);
	});

	it('does not emit a stop for a response window that produced no audio', async () => {
		const { ws, starts, stops } = await connect();
		ws.fireMessage(responseDone()); // no audio delta -> no talk was started
		expect(starts).toEqual([]);
		expect(stops).toEqual([]);
	});

	it('closes an in-progress talk when the connection closes', async () => {
		const { conn, ws, starts, stops } = await connect();
		ws.fireMessage(audioDelta()); // talk started, no end-of-utterance yet
		expect(starts).toHaveLength(1);
		expect(stops).toEqual([]);

		conn.close();
		// The talk in progress is closed on teardown so a receiver isn't left believing it is still sending.
		expect(stops).toEqual([['55555555-a0', SAMPLES_PER_FRAME, { bytesSent: 3, duration: 20 }]]);
	});
});
