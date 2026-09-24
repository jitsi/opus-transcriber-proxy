/**
 * Transcript-finalization tests for TranslatorConnection. The /v1/realtime/translations endpoint emits
 * session.output_transcript.delta (incremental fragments, append-only) but NO session.output_transcript.done, so the
 * fragments are accumulated and the final transcript is the concatenation of the whole run, emitted with
 * isInterim=false at the same silence boundary as the audio talk-stop (finalizePendingTranscript, driven by the
 * silence timer). Fake timers make the silence timer deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslatorConnection } from '../../src/TranslatorConnection';
import type { TranslationRuntime } from '../../src/translate/runtime';

const TALK_TIMEOUT_MS = 300;

interface FakeWs {
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	addEventListener: (type: string, cb: (ev?: any) => void) => void;
	readyState: number;
	fireOpen: () => void;
	fireMessage: (data: string) => void;
}

function makeFakeWebSocket(): FakeWs {
	const listeners: Record<string, (ev?: any) => void> = {};
	return {
		send: vi.fn(),
		close: vi.fn(),
		addEventListener: (type, cb) => {
			listeners[type] = cb;
		},
		readyState: 1,
		fireOpen: () => listeners.open?.(),
		fireMessage: (data) => listeners.message?.({ data }),
	};
}

/** Runtime with transcripts enabled and an encoder that emits one Opus frame per audio delta. */
function makeHarness(): { runtime: TranslationRuntime; sockets: FakeWs[] } {
	const sockets: FakeWs[] = [];
	const runtime: TranslationRuntime = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		config: {
			openaiApiKey: 'k',
			translationModel: 'm',
			emitTranscripts: true,
			debug: false,
			translationUsageUrl: '',
			usageReportIntervalMs: 0,
			talkSilenceTimeoutMs: TALK_TIMEOUT_MS,
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
				encodeFrame: () => [{ data: new Uint8Array([1, 2, 3]), inDtx: false, audioLevel: 23 }],
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
const transcriptDelta = (text: string) => JSON.stringify({ type: 'session.output_transcript.delta', delta: text });

describe('TranslatorConnection transcript finalization', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Returns the connection plus a capture of every onTranscription call as [text, isInterim].
	async function connect(): Promise<{ conn: TranslatorConnection; ws: FakeWs; transcripts: Array<[string, boolean]> }> {
		const { runtime, sockets } = makeHarness();
		const conn = new TranslatorConnection('55555555-a0', { targetLanguage: 'hi' }, runtime);
		const transcripts: Array<[string, boolean]> = [];
		conn.onTranscription = (text, _lang, isInterim) => transcripts.push([text, isInterim]);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		sockets[0].fireOpen();
		return { conn, ws: sockets[0], transcripts };
	}

	const advancePastSilence = () => vi.advanceTimersByTimeAsync(TALK_TIMEOUT_MS + 3000);

	it('accumulates fragment deltas and finalizes the whole utterance at the silence boundary', async () => {
		const { ws, transcripts } = await connect();

		ws.fireMessage(audioDelta()); // start a talk (arms the silence timer)
		// Deltas are incremental fragments, not a cumulative hypothesis — each is forwarded verbatim as an interim.
		ws.fireMessage(transcriptDelta('hola'));
		ws.fireMessage(transcriptDelta(' mundo'));
		expect(transcripts).toEqual([
			['hola', true],
			[' mundo', true],
		]);

		await advancePastSilence(); // silence timer fires -> finalize the CONCATENATION of the fragments
		expect(transcripts).toEqual([
			['hola', true],
			[' mundo', true],
			['hola mundo', false], // final = accumulated run, not just the last fragment
		]);
	});

	it('resets the transcript buffer between sequential talks (no contamination)', async () => {
		const { ws, transcripts } = await connect();

		// Talk 1: accumulate + finalize at silence.
		ws.fireMessage(audioDelta());
		ws.fireMessage(transcriptDelta('hola'));
		ws.fireMessage(transcriptDelta(' mundo'));
		await advancePastSilence();

		// Talk 2: a fresh utterance after the first finalized (finalize clears the buffer).
		ws.fireMessage(audioDelta());
		ws.fireMessage(transcriptDelta('buenos'));
		ws.fireMessage(transcriptDelta(' días'));
		await advancePastSilence();

		// Each final holds only its own utterance — no leftover 'hola mundo' bleeding into the second.
		expect(transcripts.filter(([, isInterim]) => !isInterim)).toEqual([
			['hola mundo', false],
			['buenos días', false],
		]);
	});

	it('finalizes a pending transcript when the connection closes', async () => {
		const { conn, ws, transcripts } = await connect();

		ws.fireMessage(audioDelta());
		ws.fireMessage(transcriptDelta('adiós'));
		conn.close();
		expect(transcripts).toContainEqual(['adiós', false]);
	});

	it('emits nothing when no transcript deltas were received', async () => {
		const { ws, transcripts } = await connect();
		ws.fireMessage(audioDelta()); // audio only, no transcript
		await advancePastSilence();
		expect(transcripts).toEqual([]);
	});

	it('holds the transcript final until the audio has played out (both burst in faster than real time)', async () => {
		const { conn, ws, transcripts } = await connect();
		const stops: Array<[string, number]> = [];
		conn.onTalkStop = (tag, ts) => stops.push([tag, ts]);

		// A burst: ~1 s of audio (50 frames × 20 ms) AND the whole transcript arrive at once, faster than real time.
		for (let i = 0; i < 50; i++) ws.fireMessage(audioDelta());
		ws.fireMessage(transcriptDelta('hola'));
		ws.fireMessage(transcriptDelta(' mundo'));

		// The transcript has already stopped, but the audio is still "playing out" (~1 s buffered). Well past the
		// bare silence timeout (300 ms) yet short of the playout — nothing is finalized: the transcript's own short
		// deadline does NOT shorten the audio-playout timer.
		await vi.advanceTimersByTimeAsync(800);
		expect(transcripts.filter(([, isInterim]) => !isInterim)).toEqual([]);
		expect(stops).toEqual([]);

		// Past the audio playout end + the timeout: the audio stop and the transcript final fire together.
		await vi.advanceTimersByTimeAsync(50 * 20 + TALK_TIMEOUT_MS + 100);
		expect(stops).toHaveLength(1);
		expect(transcripts.filter(([, isInterim]) => !isInterim)).toEqual([['hola mundo', false]]);
	});

	it('extends the talk when the transcript trails past the audio (no orphaned trailing final)', async () => {
		const { conn, ws, transcripts } = await connect();
		const stops: Array<[string, number]> = [];
		conn.onTalkStop = (tag, ts) => stops.push([tag, ts]);

		ws.fireMessage(audioDelta()); // one frame: audio alone would end ~320 ms later
		// Transcript deltas keep arriving, each < the timeout apart, past where the audio alone would have ended.
		for (const frag of ['a', 'b', 'c']) {
			await vi.advanceTimersByTimeAsync(250);
			ws.fireMessage(transcriptDelta(frag));
		}
		// Still open — the trailing transcript extended the talk rather than being cut off.
		expect(stops).toEqual([]);
		expect(transcripts.filter(([, isInterim]) => !isInterim)).toEqual([]);

		await vi.advanceTimersByTimeAsync(TALK_TIMEOUT_MS + 100);
		// One stop, and the final holds the whole trailing transcript (nothing orphaned into a later segment).
		expect(stops).toHaveLength(1);
		expect(transcripts.filter(([, isInterim]) => !isInterim)).toEqual([['abc', false]]);
	});
});
