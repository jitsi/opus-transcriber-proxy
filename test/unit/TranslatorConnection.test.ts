/**
 * Focused test for TranslatorConnection's incremental usage reporting.
 *
 * A stub runtime supplies a fake Opus decoder whose decodeFrame returns a fixed-size PCM buffer, so
 * each fed media frame grows totalSamplesSent by a known amount. We drive the periodic timer with
 * vi.useFakeTimers() and assert onUsageReport fires the DELTA translated since the previous report
 * (not the cumulative total), that a final delta fires on close(), and that the deltas sum to the
 * direction's total (totalSamplesSent / 24000).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslatorConnection } from '../../src/TranslatorConnection';
import type { TranslationRuntime } from '../../src/translate/runtime';

const SAMPLE_RATE = 24000;
// Each decoded frame yields 1s of 24 kHz 16-bit PCM: 24000 samples * 2 bytes.
const BYTES_PER_FRAME = SAMPLE_RATE * 2;

/** Fake Opus decoder: ready immediately, returns a fixed 1s PCM buffer per frame. */
function makeFakeDecoder() {
	return {
		ready: Promise.resolve(),
		decodeFrame: () => ({
			audioData: new Uint8Array(BYTES_PER_FRAME),
			samplesDecoded: SAMPLE_RATE,
			sampleRate: SAMPLE_RATE,
			channels: 1,
			errors: [],
		}),
		conceal: () => ({ audioData: new Uint8Array(0), samplesDecoded: 0, sampleRate: SAMPLE_RATE, channels: 1, errors: [] }),
		reset: () => {},
		free: () => {},
	};
}

/** Fake outbound WebSocket that never opens, so the connection stays 'pending' and buffers PCM. */
function makeFakeWebSocket() {
	return {
		send: vi.fn(),
		close: vi.fn(),
		addEventListener: vi.fn(),
		readyState: 0,
	};
}

function makeRuntime(usageReportIntervalMs: number): TranslationRuntime {
	return {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		config: {
			openaiApiKey: 'test-key',
			translationModel: 'test-model',
			emitTranscripts: false,
			debug: false,
			translationUsageUrl: 'https://usage.test/report',
			usageReportIntervalMs,
		},
		writeMetric: () => {},
		createMetricBatcher: () => ({ increment: () => {}, flush: () => {} }),
		createOutboundWebSocket: () => makeFakeWebSocket() as any,
		createOpusDecoder: () => makeFakeDecoder() as any,
		createOpusEncoder: () => ({ ready: Promise.resolve(), encodeFrame: () => [], reset: () => {}, free: () => {} }) as any,
		buildServerInfo: () => undefined,
	};
}

/** Flush pending microtasks so the async decoder/encoder init settles (independent of fake timers). */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function mediaEvent(tag: string, chunk: number) {
	return { event: 'media', media: { tag, chunk, timestamp: chunk * 960, payload: 'AAAA' } };
}

describe('TranslatorConnection incremental usage reporting', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('reports periodic deltas (not the cumulative total) plus a final delta on close', async () => {
		const reports: number[] = [];
		const runtime = makeRuntime(100);
		const conn = new TranslatorConnection('spk-1', {
			targetLanguage: 'en',
			onUsageReport: (durationSeconds) => reports.push(durationSeconds),
		}, runtime);

		// Let the async decoder/encoder init resolve so decoderStatus becomes 'ready'.
		await flushMicrotasks();

		// Feed 1s of audio, then advance one interval → first delta ≈ 1.0s.
		conn.handleMediaEvent(mediaEvent('spk-1', 1));
		await vi.advanceTimersByTimeAsync(100);
		expect(reports).toEqual([1]);

		// Feed 2 more seconds (cumulative 3s), advance → delta ≈ 2.0s (NOT the cumulative 3.0s).
		conn.handleMediaEvent(mediaEvent('spk-1', 2));
		conn.handleMediaEvent(mediaEvent('spk-1', 3));
		await vi.advanceTimersByTimeAsync(100);
		expect(reports).toEqual([1, 2]);

		// Feed 1 more second (cumulative 4s) WITHOUT advancing the timer, then close → final delta ≈ 1.0s.
		conn.handleMediaEvent(mediaEvent('spk-1', 4));
		conn.close();

		expect(reports).toEqual([1, 2, 1]);
		// Deltas sum to the direction's total: 4 frames * 1s = 4s = totalSamplesSent / 24000.
		const sum = reports.reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(4, 5);
	});

	it('starts no timer and reports nothing when onUsageReport is absent', async () => {
		const runtime = makeRuntime(100);
		const conn = new TranslatorConnection('spk-1', { targetLanguage: 'en' }, runtime);
		await flushMicrotasks();

		conn.handleMediaEvent(mediaEvent('spk-1', 1));
		await vi.advanceTimersByTimeAsync(500);
		// No callback wired → nothing to assert beyond "close() does not throw".
		expect(() => conn.close()).not.toThrow();
	});

	it('starts no periodic timer when the interval is <= 0 but still flushes a final delta on close', async () => {
		const reports: number[] = [];
		const runtime = makeRuntime(0);
		const conn = new TranslatorConnection('spk-1', {
			targetLanguage: 'en',
			onUsageReport: (durationSeconds) => reports.push(durationSeconds),
		}, runtime);
		await flushMicrotasks();

		conn.handleMediaEvent(mediaEvent('spk-1', 1));
		conn.handleMediaEvent(mediaEvent('spk-1', 2));
		// No timer configured, so advancing time reports nothing.
		await vi.advanceTimersByTimeAsync(1000);
		expect(reports).toEqual([]);

		// close() flushes the whole total as a single final delta.
		conn.close();
		expect(reports).toEqual([2]);
	});
});
