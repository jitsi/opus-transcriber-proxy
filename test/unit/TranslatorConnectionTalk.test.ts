/**
 * Talk-boundary tests for TranslatorConnection. The /v1/realtime/translations endpoint streams output-audio deltas
 * with NO per-utterance boundary event, so a "talk" is a contiguous run of output audio bracketed by onTalkStart
 * (first emitted frame) and onTalkStop, where the stop is inferred from a silence gap: no output audio for
 * talkSilenceTimeoutMs ends the talk, and the next delta starts a new one. The harness supplies an encoder that
 * emits one 3-byte Opus frame per audio delta and a fake OpenAI socket whose 'message' listener we drive directly.
 * Fake timers pin Date.now so the RtpTimestamper timeline (0, 960, ...) and the silence timer are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslatorConnection } from '../../src/TranslatorConnection';
import { RTP_CLOCK_RATE, FRAME_DURATION_MS } from '../../src/RtpTimestamper';
import type { TranslationRuntime } from '../../src/translate/runtime';

// RtpTimestamper defaults: 48000 Hz, 20 ms frames -> 960 ticks/frame, first frame at timestamp 0. Derived from the
// same exported constants the production code uses so it can't drift if the frame duration ever changes.
const SAMPLES_PER_FRAME = (RTP_CLOCK_RATE * FRAME_DURATION_MS) / 1000;
// End-of-talk silence timeout used by the harness (> the RtpTimestamper 100 ms gap threshold). Intentionally a round
// 300 rather than the 350 production default: these tests exercise the timer mechanism, not the specific value, and
// drive the fake clock relative to this constant, so any value above the gap threshold works.
const TALK_TIMEOUT_MS = 300;
// RTP ticks per ms (48 at 48 kHz); the stop's duration is the [start, stop) span converted with this.
const TICKS_PER_MS = RTP_CLOCK_RATE / 1000;

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

// Whether the mock encoder reports its next frame as a DTX (silence) frame. Tests toggle it before
// firing an audio delta to simulate libopus flagging voice vs. silence; reset in beforeEach.
let mockInDtx = false;

/** Runtime whose encoder emits exactly one 3-byte Opus frame per encodeFrame call. */
function makeHarness(talkSilenceTimeoutMs = TALK_TIMEOUT_MS): { runtime: TranslationRuntime; sockets: FakeWs[] } {
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
			talkSilenceTimeoutMs,
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
				encodeFrame: () => [{ data: new Uint8Array([1, 2, 3]), inDtx: mockInDtx, audioLevel: 23 }],
				reset: () => {},
				free: () => {},
			}) as any,
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

const audioDelta = () => JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAA' });

describe('TranslatorConnection talk boundaries', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockInDtx = false;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function connect(talkSilenceTimeoutMs = TALK_TIMEOUT_MS): Promise<{
		conn: TranslatorConnection;
		ws: FakeWs;
		starts: Array<[string, number]>;
		stops: Array<[string, number, { bytesSent: number; duration: number }]>;
	}> {
		const { runtime, sockets } = makeHarness(talkSilenceTimeoutMs);
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

	// Advance the fake clock well past any buffered playout + the silence timeout so the end-of-talk timer fires.
	// The timer is scheduled for (bufferAheadMs + TALK_TIMEOUT_MS); tests here buffer at most ~1s of media, so a
	// couple extra seconds of slack unconditionally fires it.
	const advancePastSilence = () => vi.advanceTimersByTimeAsync(TALK_TIMEOUT_MS + 3000);

	it('brackets a talk: start on the first frame, stop after the output goes silent', async () => {
		const { ws, starts, stops } = await connect();

		ws.fireMessage(audioDelta()); // first frame -> talk start at ts 0
		ws.fireMessage(audioDelta()); // second frame at ts 960, still the same talk
		expect(starts).toEqual([['55555555-a0', 0]]);
		expect(stops).toEqual([]); // no boundary event and no silence yet -> talk still open

		await advancePastSilence(); // output silent for the timeout -> stop at last frame end (960 + 960)
		// 2 frames of 3 bytes each -> bytesSent 6, duration 2 * 20 ms.
		expect(stops).toEqual([['55555555-a0', 2 * SAMPLES_PER_FRAME, { bytesSent: 6, duration: 40 }]]);
		expect(starts).toHaveLength(1);
	});

	it("forwards each voice frame's audio level with vad=true for the ssrc-audio-level extension", async () => {
		const { conn, ws } = await connect();
		const media: Array<[number, boolean]> = []; // [audioLevel, vad]
		conn.onAudioFrame = (_tag, _seq, _ts, _payload, audioLevel, vad) => media.push([audioLevel, vad]);

		ws.fireMessage(audioDelta());
		// The mock encoder reports level 23 for every frame; a forwarded frame is by definition non-DTX, i.e. voice.
		expect(media).toEqual([[23, true]]);
	});

	it('drops DTX (silence) frames: not forwarded, do not extend the talk, and end it on sustained DTX', async () => {
		const { conn, ws, starts, stops } = await connect();
		const media: Array<[number, number]> = []; // [rtpSequenceNumber, timestamp]
		conn.onAudioFrame = (_tag, seq, ts) => media.push([seq, ts]);

		// Voice frames: talk starts and each is forwarded.
		ws.fireMessage(audioDelta());
		ws.fireMessage(audioDelta());
		expect(starts).toEqual([['55555555-a0', 0]]);
		expect(media).toHaveLength(2);

		// libopus goes into DTX (silence). These frames must NOT be forwarded and must NOT extend the talk —
		// this is what stops a live mic's continuous ambient output from holding the talk open forever.
		mockInDtx = true;
		ws.fireMessage(audioDelta());
		ws.fireMessage(audioDelta());
		expect(media).toHaveLength(2); // unchanged — silence dropped
		expect(stops).toEqual([]); // silence timer not yet fired

		// Sustained DTX past the timeout ends the talk, at the last VOICE frame's end (the DTX frames didn't
		// advance the RTP timeline), so bytesSent/duration cover only the 2 voice frames.
		await advancePastSilence();
		expect(stops).toEqual([['55555555-a0', 2 * SAMPLES_PER_FRAME, { bytesSent: 6, duration: 40 }]]);

		// Voice resumes -> a fresh talk starts and forwarding resumes.
		mockInDtx = false;
		ws.fireMessage(audioDelta());
		expect(starts).toHaveLength(2);
		expect(media).toHaveLength(3);
	});

	it('preserves the real silence gap in the RTP timeline across dropped DTX frames', async () => {
		const { conn, ws } = await connect();
		const media: Array<[number, number]> = []; // [rtpSequenceNumber, timestamp]
		conn.onAudioFrame = (_tag, seq, ts) => media.push([seq, ts]);

		ws.fireMessage(audioDelta()); // one voice frame at the start of the timeline
		expect(media).toHaveLength(1);
		const firstTs = media[0][1];

		// ~5 s of real time passes while the encoder is in DTX (mic on, but the translated output is
		// comfort noise). The DTX frames are dropped, so nothing is forwarded.
		mockInDtx = true;
		ws.fireMessage(audioDelta()); // DTX -> dropped
		await vi.advanceTimersByTimeAsync(5000);
		expect(media).toHaveLength(1);

		// Voice resumes. The RtpTimestamper is one continuous media-playout clock, so the resumed frame's
		// timestamp jumps forward by ~the elapsed silence — NOT `firstTs + one frame`. That's what makes
		// dropping DTX frames transparent: the client hears real silence for the gap, not a splice.
		mockInDtx = false;
		ws.fireMessage(audioDelta());
		expect(media).toHaveLength(2);
		const resumeTs = media[1][1];
		// Contiguous forwarding would advance by exactly one frame; assert a multi-second jump (5 s of
		// silence is ~250 frames, so > 100 frames' worth is a wide, robust bound).
		expect(resumeTs - firstTs).toBeGreaterThan(100 * SAMPLES_PER_FRAME);
	});

	it('keeps the talk open until a faster-than-real-time burst would finish playing out', async () => {
		const { ws, starts, stops } = await connect();

		// 50 frames delivered in one instant = 1 s of media buffered ahead (the burst arrives far faster than it
		// plays). The talk must stay open for that whole playout, not end a fixed 350 ms after the last frame arrived.
		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());
		expect(starts).toHaveLength(1);

		// 800 ms is well past the bare silence timeout (350) but far short of the ~1 s of buffered playout — a
		// frame-arrival timer would have wrongly stopped here.
		await vi.advanceTimersByTimeAsync(800);
		expect(stops).toEqual([]);

		// Advance past playout end + the timeout -> exactly one stop, spanning the full 1 s of audio.
		await vi.advanceTimersByTimeAsync(50 * FRAME_DURATION_MS + TALK_TIMEOUT_MS + 100);
		expect(stops).toEqual([['55555555-a0', 50 * SAMPLES_PER_FRAME, { bytesSent: 150, duration: 1000 }]]);
	});

	it('does not stop while audio keeps flowing (silence timer is debounced per frame)', async () => {
		const { ws, starts, stops } = await connect();

		// Four frames spaced under both the RTP gap threshold (100 ms) and the silence timeout (300 ms): the talk
		// stays open and contiguous the whole time because each frame re-arms the timer.
		ws.fireMessage(audioDelta());
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(50);
			ws.fireMessage(audioDelta());
		}
		expect(starts).toHaveLength(1);
		expect(stops).toEqual([]);

		await advancePastSilence(); // now silent past the timeout -> one stop for the whole run
		// 4 contiguous frames: bytesSent 12, span 4 * 20 ms.
		expect(stops).toEqual([['55555555-a0', 4 * SAMPLES_PER_FRAME, { bytesSent: 12, duration: 80 }]]);
	});

	it('opens a fresh talk after a silence gap', async () => {
		const { ws, starts, stops } = await connect();

		ws.fireMessage(audioDelta());
		await advancePastSilence(); // ends talk 1
		ws.fireMessage(audioDelta());
		await advancePastSilence(); // ends talk 2

		expect(starts).toHaveLength(2);
		expect(stops).toHaveLength(2);
		// Each talk is one 3-byte frame -> bytesSent 3, duration 20 ms (a single frame's span is always one frame).
		expect(stops[0][2]).toEqual({ bytesSent: 3, duration: 20 });
		expect(stops[1][2]).toEqual({ bytesSent: 3, duration: 20 });
		// The second talk starts after the inserted silence gap, so its start timestamp is past the first's stop.
		expect(starts[0][1]).toBe(0);
		expect(starts[1][1]).toBeGreaterThan(stops[0][1]);
	});

	it('reports the span (incl. a mid-talk gap shorter than the timeout) as duration', async () => {
		const { ws, stops } = await connect();

		ws.fireMessage(audioDelta()); // frame 1 at ts 0
		// A gap longer than the RtpTimestamper threshold (100 ms) but shorter than the silence timeout (300 ms): the
		// RTP timeline jumps, but the talk stays open, so its span exceeds the 2 frames of actual audio.
		await vi.advanceTimersByTimeAsync(150);
		ws.fireMessage(audioDelta()); // frame 2 at a jumped-forward ts
		await advancePastSilence();

		expect(stops).toHaveLength(1);
		const [tag, stopTs, mediaInfo] = stops[0];
		expect(tag).toBe('55555555-a0');
		// bytesSent is the real audio (2 * 3 bytes). duration is the [start, stop) span (start ts 0), so it equals
		// stopTs converted to ms and absorbs the gap — far more than the 2 * 20 ms of actual audio.
		expect(mediaInfo.bytesSent).toBe(6);
		expect(mediaInfo.duration).toBe(Math.round(stopTs / TICKS_PER_MS));
		expect(stopTs).toBeGreaterThan(2 * SAMPLES_PER_FRAME);
		expect(mediaInfo.duration).toBeGreaterThan(40);
	});

	it('does not emit a stop when there is no output audio', async () => {
		const { starts, stops } = await connect();
		await advancePastSilence(); // silence with no prior audio -> no talk was ever started
		expect(starts).toEqual([]);
		expect(stops).toEqual([]);
	});

	it('with the timeout disabled (<= 0) never ends a talk on silence, only at close', async () => {
		const { conn, ws, starts, stops } = await connect(0);

		ws.fireMessage(audioDelta());
		expect(starts).toHaveLength(1);
		// No silence timer is armed, so even a long silence produces no stop.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(stops).toEqual([]);

		// The talk only ends when the connection tears down.
		conn.close();
		expect(stops).toHaveLength(1);
	});

	it('closes an in-progress talk when the connection closes', async () => {
		const { conn, ws, starts, stops } = await connect();
		ws.fireMessage(audioDelta()); // talk started, still open
		expect(starts).toHaveLength(1);
		expect(stops).toEqual([]);

		conn.close();
		// The talk in progress is closed on teardown so a receiver isn't left believing it is still sending.
		expect(stops).toEqual([['55555555-a0', SAMPLES_PER_FRAME, { bytesSent: 3, duration: 20 }]]);
	});
});
