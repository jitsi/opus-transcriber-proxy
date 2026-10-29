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
 * Focused test for TranslatorConnection's incremental usage reporting.
 *
 * A stub runtime supplies a fake Opus decoder (fixed 1s PCM per frame) and a fake outbound WebSocket
 * that we open explicitly so the connection reaches 'connected' and actually appends audio to OpenAI.
 * Usage is billed from that appended audio (sentSamples), so the socket must be open for frames to
 * count. We drive the periodic timer with vi.useFakeTimers() and assert onUsageReport fires the DELTA
 * translated since the previous report (not the cumulative total), that a final delta fires on close(),
 * and that the deltas sum to the direction's total (sentSamples / 24000).
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

interface FakeWs {
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	addEventListener: (type: string, cb: (ev?: any) => void) => void;
	readyState: number;
	/** Simulate the socket opening (drives the connection to 'connected'). */
	fireOpen: () => void;
}

/** Fake outbound WebSocket. Captures listeners; `fireOpen()` drives the 'connected' transition. */
function makeFakeWebSocket(): FakeWs {
	const listeners: Record<string, (ev?: any) => void> = {};
	return {
		send: vi.fn(),
		close: vi.fn(),
		addEventListener: (type: string, cb: (ev?: any) => void) => { listeners[type] = cb; },
		readyState: 1,
		fireOpen: () => listeners.open?.(),
	};
}

/** Runtime + a handle to the outbound sockets it creates, so tests can open them. */
function makeHarness(usageReportIntervalMs: number): { runtime: TranslationRuntime; sockets: FakeWs[] } {
	const sockets: FakeWs[] = [];
	const runtime: TranslationRuntime = {
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
		createOutboundWebSocket: () => {
			const ws = makeFakeWebSocket();
			sockets.push(ws);
			return ws as any;
		},
		createOpusDecoder: () => makeFakeDecoder() as any,
		createOpusEncoder: () => ({ ready: Promise.resolve(), encodeFrame: () => [], reset: () => {}, free: () => {} }) as any,
		buildServerInfo: () => undefined,
	};
	return { runtime, sockets };
}

/** Flush pending microtasks so the async decoder/encoder init settles (independent of fake timers). */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
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
		const { runtime, sockets } = makeHarness(100);
		const conn = new TranslatorConnection('spk-1', {
			targetLanguage: 'en',
			onUsageReport: (durationSeconds) => reports.push(durationSeconds),
		}, runtime);

		// Let the async decoder/encoder init resolve (decoderStatus 'ready', outbound socket created),
		// then open the socket so fed audio is actually appended to OpenAI (and therefore billed).
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		sockets[0].fireOpen();

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
		// Deltas sum to the direction's translated total: 4 frames * 1s = 4s.
		const sum = reports.reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(4, 5);
	});

	it('does not bill audio buffered before the socket opens if it is never appended', async () => {
		const reports: number[] = [];
		const { runtime, sockets } = makeHarness(100);
		const conn = new TranslatorConnection('spk-1', {
			targetLanguage: 'en',
			onUsageReport: (durationSeconds) => reports.push(durationSeconds),
		}, runtime);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);

		// Socket never opens → audio stays buffered/dropped, never appended to OpenAI.
		conn.handleMediaEvent(mediaEvent('spk-1', 1));
		await vi.advanceTimersByTimeAsync(500);
		conn.close();
		// Nothing was appended, so nothing is billed.
		expect(reports).toEqual([]);
	});

	it('starts no timer and reports nothing when onUsageReport is absent', async () => {
		const { runtime, sockets } = makeHarness(100);
		const conn = new TranslatorConnection('spk-1', { targetLanguage: 'en' }, runtime);
		await flushMicrotasks();
		sockets[0]?.fireOpen();

		conn.handleMediaEvent(mediaEvent('spk-1', 1));
		await vi.advanceTimersByTimeAsync(500);
		// No callback wired → nothing to assert beyond "close() does not throw".
		expect(() => conn.close()).not.toThrow();
	});

	it('starts no periodic timer when the interval is <= 0 but still flushes a final delta on close', async () => {
		const reports: number[] = [];
		const { runtime, sockets } = makeHarness(0);
		const conn = new TranslatorConnection('spk-1', {
			targetLanguage: 'en',
			onUsageReport: (durationSeconds) => reports.push(durationSeconds),
		}, runtime);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		sockets[0].fireOpen();

		conn.handleMediaEvent(mediaEvent('spk-1', 1));
		conn.handleMediaEvent(mediaEvent('spk-1', 2));
		// No timer configured, so advancing time reports nothing.
		await vi.advanceTimersByTimeAsync(1000);
		expect(reports).toEqual([]);

		// close() flushes the whole appended total as a single final delta.
		conn.close();
		expect(reports).toEqual([2]);
	});

	it('re-reports the delta on the next tick if onUsageReport throws', async () => {
		const reports: number[] = [];
		let throwOnce = true;
		const { runtime, sockets } = makeHarness(100);
		const conn = new TranslatorConnection('spk-1', {
			targetLanguage: 'en',
			onUsageReport: (durationSeconds) => {
				if (throwOnce) {
					throwOnce = false;
					throw new Error('reporter down');
				}
				reports.push(durationSeconds);
			},
		}, runtime);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		sockets[0].fireOpen();

		conn.handleMediaEvent(mediaEvent('spk-1', 1)); // 1s appended
		await vi.advanceTimersByTimeAsync(100); // first fire throws → reportedSamples not advanced
		expect(reports).toEqual([]);
		await vi.advanceTimersByTimeAsync(100); // next tick re-includes the same 1s delta
		expect(reports).toEqual([1]);
		conn.close();
	});

	it('logs (and does not throw) when onUsageReport throws on the final close() delta', async () => {
		const { runtime, sockets } = makeHarness(0); // no timer: the only report is the final close() delta
		const conn = new TranslatorConnection('spk-1', {
			targetLanguage: 'en',
			onUsageReport: () => { throw new Error('reporter down'); },
		}, runtime);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		sockets[0].fireOpen();

		conn.handleMediaEvent(mediaEvent('spk-1', 1)); // 1s appended
		// close() flushes the final delta; the throw is caught + logged, never propagated (the last
		// delta is dropped — acceptable, and made explicit here so the failure mode can't regress silently).
		expect(() => conn.close()).not.toThrow();
		expect(runtime.logger.error).toHaveBeenCalled();
	});
});

describe('translation endpoint override', () => {
	it.each([undefined, 'ws://127.0.0.1:8096/v1/realtime/translations?tenant=test'])('uses endpoint %s', async (endpoint) => {
		const { runtime } = makeHarness(0);
		runtime.config.translationEndpoint = endpoint;
		const dial = vi.spyOn(runtime, 'createOutboundWebSocket');
		const conn = new TranslatorConnection('speaker', { targetLanguage: 'en' }, runtime);
		await flushMicrotasks();
		const url = new URL(dial.mock.calls[0][0]);
		expect(url.host).toBe(endpoint ? '127.0.0.1:8096' : 'api.openai.com');
		expect(url.searchParams.get('model')).toBe('test-model');
		if (endpoint) expect(url.searchParams.get('tenant')).toBe('test');
		conn.close();
	});
	it.each(['https://example.com', 'ws://user:password@localhost', 'ws://localhost/#secret'])('rejects %s before dial', async (endpoint) => {
		const { runtime } = makeHarness(0);
		runtime.config.translationEndpoint = endpoint;
		const dial = vi.spyOn(runtime, 'createOutboundWebSocket');
		const conn = new TranslatorConnection('speaker', { targetLanguage: 'en' }, runtime);
		await flushMicrotasks();
		expect(dial).not.toHaveBeenCalled();
		conn.close();
	});
});
