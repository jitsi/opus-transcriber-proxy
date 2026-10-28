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

// The xAI provider path of TranslatorConnection: the session.created -> session.update ->
// session.updated handshake that gates audio, per-segment transcript finals from
// session.output_transcript.updated, the idle close, and the close reasons the proxy paces on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslatorConnection, type TranslatorCloseReason } from '../../src/TranslatorConnection';
import type { TranslationRuntime, OutboundWebSocketOptions } from '../../src/translate/runtime';

const TALK_TIMEOUT_MS = 300;

interface FakeWs {
	url: string;
	options?: OutboundWebSocketOptions;
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	addEventListener: (type: string, cb: (ev?: any) => void) => void;
	readyState: number;
	fireOpen: () => void;
	fireMessage: (data: string) => void;
	fireClose: (code?: number) => void;
	sentTypes: () => string[];
}

function makeFakeWebSocket(url: string, options?: OutboundWebSocketOptions): FakeWs {
	const listeners: Record<string, (ev?: any) => void> = {};
	const send = vi.fn();
	return {
		url,
		options,
		send,
		close: vi.fn(),
		addEventListener: (type, cb) => {
			listeners[type] = cb;
		},
		readyState: 1,
		fireOpen: () => listeners.open?.(),
		fireMessage: (data) => listeners.message?.({ data }),
		fireClose: (code = 1000) => listeners.close?.({ code, reason: '', wasClean: true }),
		sentTypes: () => send.mock.calls.map((c) => JSON.parse(c[0] as string).type),
	};
}

function makeHarness(configOverrides: Record<string, unknown> = {}): { runtime: TranslationRuntime; sockets: FakeWs[] } {
	const sockets: FakeWs[] = [];
	const runtime: TranslationRuntime = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		config: {
			provider: 'xai',
			openaiApiKey: '',
			xaiApiKey: 'x-key',
			translationModel: 'm',
			emitTranscripts: true,
			debug: false,
			translationUsageUrl: '',
			usageReportIntervalMs: 0,
			talkSilenceTimeoutMs: TALK_TIMEOUT_MS,
			...configOverrides,
		},
		writeMetric: () => {},
		createMetricBatcher: () => ({ increment: () => {}, flush: () => {} }),
		createOutboundWebSocket: (url, options) => {
			const ws = makeFakeWebSocket(url, options);
			sockets.push(ws);
			return ws as any;
		},
		createOpusDecoder: () =>
			({
				ready: Promise.resolve(),
				// One 20 ms frame of 24 kHz PCM per Opus frame.
				decodeFrame: () => ({ audioData: new Uint8Array(960), samplesDecoded: 480, sampleRate: 24000, channels: 1, errors: [] }),
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

const mediaEvent = (tag: string, chunk: number) => ({ event: 'media', media: { tag, chunk, timestamp: chunk * 960, payload: 'AAAA' } });
const sessionCreated = () => JSON.stringify({ type: 'session.created', session: { id: 'sess_1', model: 'grok-realtime-translation-fast' } });
const sessionUpdated = () => JSON.stringify({ type: 'session.updated', session: { id: 'sess_1' } });
const audioDelta = () => JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAA' });
const transcriptDelta = (text: string) => JSON.stringify({ type: 'session.output_transcript.delta', delta: text });
const transcriptUpdated = (text: string, segmentId = 'seg_001') =>
	JSON.stringify({ type: 'session.output_transcript.updated', text, segment_id: segmentId });

describe('TranslatorConnection on xAI', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function open(configOverrides: Record<string, unknown> = {}) {
		const { runtime, sockets } = makeHarness(configOverrides);
		const conn = new TranslatorConnection('55555555-a0', { targetLanguage: 'nl', provider: 'xai' }, runtime);
		const transcripts: Array<[string, boolean]> = [];
		const closed: TranslatorCloseReason[] = [];
		const errors: unknown[] = [];
		conn.onTranscription = (text, _lang, isInterim) => transcripts.push([text, isInterim]);
		conn.onClosed = (_tag, reason) => closed.push(reason);
		conn.onError = (_tag, err) => errors.push(err);
		await flushMicrotasks();
		expect(sockets).toHaveLength(1);
		return { conn, ws: sockets[0], transcripts, closed, errors, runtime };
	}

	it('opens the xAI endpoint with no subprotocol and the xAI auth prefix', async () => {
		const { ws } = await open();
		expect(ws.url).toBe('wss://api.x.ai/v1/realtime/translations');
		expect(ws.options?.protocols).toEqual([]);
		expect(ws.options?.bearerToken).toBe('x-key');
		expect(ws.options?.authSubprotocolPrefix).toBe('xai-insecure-api-key.');
	});

	it('sends session.update only after session.created, and audio only after session.updated', async () => {
		const { conn, ws } = await open();
		ws.fireOpen();
		expect(ws.sentTypes()).toEqual([]); // nothing on open: the server speaks first

		// Audio arriving before the session is ready is buffered, not sent.
		conn.handleMediaEvent(mediaEvent('55555555-a0', 1));
		conn.handleMediaEvent(mediaEvent('55555555-a0', 2));
		expect(ws.sentTypes()).toEqual([]);

		ws.fireMessage(sessionCreated());
		expect(ws.sentTypes()).toEqual(['session.update']);
		const update = JSON.parse(ws.send.mock.calls[0][0] as string);
		expect(update.session.audio.output.language).toBe('nl');
		expect(update.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });

		// Still gated: only session.updated releases the buffered audio.
		conn.handleMediaEvent(mediaEvent('55555555-a0', 3));
		expect(ws.sentTypes()).toEqual(['session.update']);

		ws.fireMessage(sessionUpdated());
		expect(ws.sentTypes()).toEqual(['session.update', 'session.input_audio_buffer.append']);
		// The flush carries all three buffered 20 ms frames in one append.
		const append = JSON.parse(ws.send.mock.calls[1][0] as string);
		expect(Buffer.from(append.audio, 'base64').length).toBe(3 * 960);

		// Later audio streams straight through.
		conn.handleMediaEvent(mediaEvent('55555555-a0', 4));
		expect(ws.sentTypes()).toHaveLength(3);
	});

	it('fails the direction when the session handshake does not complete', async () => {
		const { ws, closed, errors } = await open();
		ws.fireOpen();
		ws.fireMessage(sessionCreated()); // update sent, but no session.updated ever comes back
		await vi.advanceTimersByTimeAsync(10_000);
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toMatch(/handshake timed out/);
		expect(closed).toEqual(['error']);
		expect(ws.close).toHaveBeenCalled();
	});

	it('a completed handshake disarms the handshake timer', async () => {
		const { ws, closed, errors } = await open();
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());
		await vi.advanceTimersByTimeAsync(20_000);
		expect(errors).toEqual([]);
		expect(closed).toEqual([]);
	});

	it('emits output_transcript.updated as the final at once and drops the buffered deltas', async () => {
		const { ws, transcripts } = await open();
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());

		ws.fireMessage(transcriptDelta('Dit'));
		ws.fireMessage(transcriptDelta(' is'));
		ws.fireMessage(transcriptUpdated('Dit is', 'seg_001'));
		expect(transcripts).toEqual([
			['Dit', true],
			[' is', true],
			['Dit is', false],
		]);

		// The segment's audio arrives after its final; the talk-stop silence must not re-emit the text.
		ws.fireMessage(audioDelta());
		await vi.advanceTimersByTimeAsync(TALK_TIMEOUT_MS + 3000);
		expect(transcripts).toHaveLength(3);

		// Next segment: fresh buffer, fresh final.
		ws.fireMessage(transcriptDelta(' een'));
		ws.fireMessage(transcriptUpdated('een test,', 'seg_002'));
		expect(transcripts.slice(3)).toEqual([
			[' een', true],
			['een test,', false],
		]);
	});

	it('does not publish buffered deltas as a final at the talk-stop silence: xAI owns finalization', async () => {
		const { ws, transcripts } = await open();
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());
		ws.fireMessage(audioDelta());
		ws.fireMessage(transcriptDelta('Dit'));
		ws.fireMessage(transcriptDelta(' is'));
		// Silence lands between the deltas and xAI's final for the segment.
		await vi.advanceTimersByTimeAsync(TALK_TIMEOUT_MS + 3000);
		expect(transcripts.filter(([, interim]) => !interim)).toEqual([]);
		ws.fireMessage(transcriptUpdated('Dit is', 'seg_001'));
		expect(transcripts.filter(([, interim]) => !interim)).toEqual([['Dit is', false]]);
	});

	it('does not close an idle direction while translated audio is still playing out', async () => {
		const { conn, ws, closed } = await open();
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());
		conn.handleMediaEvent(mediaEvent('55555555-a0', 1));
		await vi.advanceTimersByTimeAsync(119_000);
		// A long translated burst arrives just before the idle mark; the encoder yields one voice frame per delta,
		// so keep the talk open by feeding deltas past the idle mark, then let it end.
		for (let i = 0; i < 50; i++) {
			ws.fireMessage(audioDelta());
			await vi.advanceTimersByTimeAsync(200); // under the talk timeout, so the talk stays active
		}
		expect(closed).toEqual([]); // 129 s idle on input, but the talk is active
		await vi.advanceTimersByTimeAsync(TALK_TIMEOUT_MS + 3000); // talk ends on silence
		await vi.advanceTimersByTimeAsync(30_000); // next idle check
		expect(closed).toEqual(['idle']);
	});

	it('reports a provider close before the session was usable as "rejected", after 2 s of audio as "remote"', async () => {
		// Mid-handshake: no audio could have been sent.
		const a = await open();
		a.ws.fireOpen();
		a.ws.fireMessage(sessionCreated());
		a.ws.fireClose(1000);
		expect(a.closed).toEqual(['rejected']);

		// After only a moment of audio: a provider dropping every session this way must be paced too.
		const b = await open();
		b.ws.fireOpen();
		b.ws.fireMessage(sessionCreated());
		b.ws.fireMessage(sessionUpdated());
		for (let i = 1; i <= 50; i++) b.conn.handleMediaEvent(mediaEvent('55555555-a0', i)); // 1 s
		b.ws.fireClose(1000);
		expect(b.closed).toEqual(['rejected']);

		const c = await open();
		c.ws.fireOpen();
		c.ws.fireMessage(sessionCreated());
		c.ws.fireMessage(sessionUpdated());
		for (let i = 1; i <= 101; i++) c.conn.handleMediaEvent(mediaEvent('55555555-a0', i)); // just over 2 s
		c.ws.fireClose(1000);
		expect(c.closed).toEqual(['remote']);
	});

	it('ignores an empty updated event and emits nothing with transcripts disabled', async () => {
		const { ws, transcripts } = await open({ emitTranscripts: false });
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());
		ws.fireMessage(transcriptDelta('Dit'));
		ws.fireMessage(transcriptUpdated('Dit is'));
		ws.fireMessage(transcriptUpdated('   '));
		expect(transcripts).toEqual([]);
	});

	it('closes an idle direction after the xAI default idle period and reports reason "idle"', async () => {
		const { conn, ws, closed } = await open();
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());
		conn.handleMediaEvent(mediaEvent('55555555-a0', 1));

		await vi.advanceTimersByTimeAsync(100_000);
		expect(closed).toEqual([]); // 100 s idle: still under the 120 s default
		conn.handleMediaEvent(mediaEvent('55555555-a0', 2)); // media resets the idle clock
		await vi.advanceTimersByTimeAsync(100_000);
		expect(closed).toEqual([]);
		// The idle check runs every quarter period, so the close lands within 30 s of the 120 s mark.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(closed).toEqual(['idle']);
		expect(ws.close).toHaveBeenCalled();
	});

	it('closes a direction that never received media once the idle period passes since creation', async () => {
		const { ws, closed } = await open();
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());
		await vi.advanceTimersByTimeAsync(125_000);
		expect(closed).toEqual(['idle']);
		expect(ws.close).toHaveBeenCalled();
	});

	it('with the talk timer disabled a never-ending talk does not hold an idle direction open', async () => {
		const { conn, ws, closed } = await open({ talkSilenceTimeoutMs: 0 });
		ws.fireOpen();
		ws.fireMessage(sessionCreated());
		ws.fireMessage(sessionUpdated());
		conn.handleMediaEvent(mediaEvent('55555555-a0', 1));
		ws.fireMessage(audioDelta()); // starts a talk that, with no timer, never ends
		await vi.advanceTimersByTimeAsync(150_000);
		expect(closed).toEqual(['idle']);
	});

	it('TRANSLATION_IDLE_CLOSE_MS=0 disables the idle close for xAI too', async () => {
		const { closed } = await open({ idleCloseMs: 0 });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(closed).toEqual([]);
	});

	it('reports a provider-side socket close before audio as "rejected" and an error event as "error"', async () => {
		const a = await open();
		a.ws.fireOpen();
		a.ws.fireClose(1000);
		expect(a.closed).toEqual(['rejected']);
		expect(a.errors).toEqual([]);

		const b = await open();
		b.ws.fireOpen();
		b.ws.fireMessage(JSON.stringify({ type: 'error', error: { type: 'invalid_request', code: 'invalid_value', message: 'nope' } }));
		expect(b.errors).toHaveLength(1);
		expect(b.closed).toEqual(['error']);
	});

	it('OpenAI keeps the configure-on-open behaviour and no idle close by default', async () => {
		const { runtime, sockets } = makeHarness({ provider: 'openai', openaiApiKey: 'oa' });
		const closed: TranslatorCloseReason[] = [];
		const conn = new TranslatorConnection('55555555-a0', { targetLanguage: 'es' }, runtime);
		conn.onClosed = (_tag, reason) => closed.push(reason);
		await flushMicrotasks();
		const ws = sockets[0];
		expect(ws.url).toMatch(/^wss:\/\/api\.openai\.com\/v1\/realtime\/translations\?model=m$/);
		expect(ws.options?.protocols).toEqual(['realtime']);
		expect(ws.options?.authSubprotocolPrefix).toBe('openai-insecure-api-key.');
		ws.fireOpen();
		expect(ws.sentTypes()).toEqual(['session.update']);
		conn.handleMediaEvent(mediaEvent('55555555-a0', 1));
		expect(ws.sentTypes()).toEqual(['session.update', 'session.input_audio_buffer.append']);
		// An OpenAI session.updated echo is harmless once connected.
		ws.fireMessage(sessionUpdated());
		await vi.advanceTimersByTimeAsync(600_000);
		expect(closed).toEqual([]);
	});
});
