/**
 * Tests for XAIBackend module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XAIBackend } from '../../../src/backends/XAIBackend';
import type { MockWebSocketInstance } from '../../helpers/websocket-mock';
import type { BackendConfig, AudioFormat } from '../../../src/backends/TranscriptionBackend';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';
import { config } from '../../../src/config';

// Track the last WsWebSocket instance created by the ws mock.
// Defined at module scope so the vi.mock factory (hoisted before imports) can reference it.
let lastWsInstance: any = null;

// vi.mock is hoisted to the top of the file by vitest — the factory cannot reference
// symbols imported above. We define a self-contained mock here instead.
vi.mock('ws', () => {
	const { EventEmitter } = require('node:events');

	class MockWs extends EventEmitter {
		public readyState = 1; // OPEN
		public url: string;
		private _sentMessages: any[] = [];
		private _listeners: Map<string, Set<Function>> = new Map();
		static OPEN = 1;
		static CLOSED = 3;

		constructor(url: string, _options?: any) {
			super();
			this.url = url;
			lastWsInstance = this;
		}

		addEventListener(event: string, handler: Function): void {
			if (!this._listeners.has(event)) this._listeners.set(event, new Set());
			this._listeners.get(event)!.add(handler);
		}

		send(data: any): void { this._sentMessages.push(data); }
		close(): void { this.readyState = 3; }
		getSentMessages(): any[] { return [...this._sentMessages]; }
		clearSentMessages(): void { this._sentMessages = []; }

		_trigger(event: string, data: any): void {
			this._listeners.get(event)?.forEach((fn) => fn(data));
		}

		simulateOpen(): void { this.readyState = 1; this._trigger('open', {}); }
		simulateMessage(data: any): void { this._trigger('message', { data }); }
		simulateError(msg: string): void { this._trigger('error', { message: msg }); }
		simulateClose(code = 1000, reason = '', wasClean = true): void {
			this.readyState = 3;
			this._trigger('close', { code, reason, wasClean });
		}
	}

	return { default: MockWs };
});

function getMockWs(): any {
	if (!lastWsInstance) throw new Error('No ws instance created yet');
	return lastWsInstance;
}

vi.mock('../../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../src/metrics', () => ({
	writeMetric: vi.fn(),
}));

vi.mock('../../../src/config', () => ({
	config: {
		xai: {
			apiKey: 'test-xai-key',
			sttUrl: 'wss://api.x.ai/v1/stt',
			language: undefined,
			diarize: false,
			includeLanguage: false,
			endpointing: 850,
			smartTurn: undefined,
			smartTurnTimeout: 500,
			granularFinals: false,
			granularStabilityMs: 1000,
			granularGuardWords: 3,
			granularMinWords: 5,
		},
	},
}));

const DEFAULT_CONFIG: BackendConfig = { model: undefined, language: undefined, prompt: undefined };

describe('XAIBackend', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastWsInstance = null;
	});

	describe('Constructor', () => {
		it('should initialize with pending status', () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			expect(backend.getStatus()).toBe('pending');
		});
	});

	describe('getDesiredAudioFormat', () => {
		it('should always return l16 at 16kHz', () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const inputFormat: AudioFormat = { encoding: 'opus', sampleRate: 48000 };
			expect(backend.getDesiredAudioFormat(inputFormat)).toEqual({ encoding: 'l16', sampleRate: 16000 });
		});
	});

	describe('connect', () => {
		it('should connect and build URL with required params', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('wss://api.x.ai/v1/stt');
			expect(getMockWs().url).toContain('sample_rate=16000');
			expect(getMockWs().url).toContain('encoding=pcm');
			expect(getMockWs().url).toContain('interim_results=true');
			expect(backend.getStatus()).toBe('connected');
		});

		it('should let per-endpoint diarize=true override the global config', async () => {
			// global config mock has diarize:false; the start-event override enables it
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, diarize: true });
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('diarize=true');
		});

		it('should let per-endpoint diarize=false override a globally-enabled diarize', async () => {
			(config.xai as any).diarize = true;
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect({ ...DEFAULT_CONFIG, diarize: false });
				getMockWs().simulateOpen();
				await connectPromise;

				// xAI only emits the diarize param when enabled, so it must be absent here
				expect(getMockWs().url).not.toContain('diarize=true');
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('should include language from backendConfig', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, language: 'fr' });
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('language=fr');
		});

		it('should include language from global config if not in backendConfig', async () => {
			(config.xai as any).language = 'de';
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);
				getMockWs().simulateOpen();
				await connectPromise;

				expect(getMockWs().url).toContain('language=de');
			} finally {
				(config.xai as any).language = undefined;
			}
		});

		it('should include diarize param when enabled', async () => {
			(config.xai as any).diarize = true;
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);
				getMockWs().simulateOpen();
				await connectPromise;

				expect(getMockWs().url).toContain('diarize=true');
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('should send endpointing and NOT smart_turn by default (one stream per participant)', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('endpointing=850');
			expect(getMockWs().url).not.toContain('smart_turn');
		});

		it('should send smart_turn params only when configured', async () => {
			(config.xai as any).smartTurn = 0.7;
			(config.xai as any).smartTurnTimeout = 3000;
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				const connectPromise = backend.connect(DEFAULT_CONFIG);
				getMockWs().simulateOpen();
				await connectPromise;

				expect(getMockWs().url).toContain('smart_turn=0.7');
				expect(getMockWs().url).toContain('smart_turn_timeout=3000');
			} finally {
				(config.xai as any).smartTurn = undefined;
				(config.xai as any).smartTurnTimeout = 500;
			}
		});

		it('should apply per-connection endpointing override over config', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, xaiEndpointing: 300 });
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('endpointing=300');
		});

		it('should enable smart_turn via per-connection override even when config disables it', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, xaiSmartTurn: 0.4, xaiSmartTurnTimeout: 1200 });
			getMockWs().simulateOpen();
			await connectPromise;

			expect(getMockWs().url).toContain('smart_turn=0.4');
			expect(getMockWs().url).toContain('smart_turn_timeout=1200');
		});

		it('should reject when API key is missing', async () => {
			(config.xai as any).apiKey = '';
			try {
				const backend = new XAIBackend('test-tag', { id: 'p1' });
				await expect(backend.connect(DEFAULT_CONFIG)).rejects.toThrow('XAI_API_KEY not configured');
			} finally {
				(config.xai as any).apiKey = 'test-xai-key';
			}
		});

		it('should set status to failed on WebSocket error', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateError('connection refused');
			await expect(connectPromise).rejects.toThrow();
			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('sendAudio', () => {
		it('should send binary frame', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			const audioBase64 = Buffer.from('fake-pcm-data').toString('base64');
			await backend.sendAudio(audioBase64);

			const sent = getMockWs().getSentMessages();
			expect(sent).toHaveLength(1);
			expect(Buffer.isBuffer(sent[0])).toBe(true);
		});

		it('should throw when not connected', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			await expect(backend.sendAudio('dGVzdA==')).rejects.toThrow('connection not ready');
		});
	});

	describe('forceCommit', () => {
		it('should inject a silence tail (not audio.done) to flush the final and keep the WS open', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			backend.forceCommit();

			const sent = getMockWs().getSentMessages();
			expect(sent).toHaveLength(1);
			// Binary silence, NOT an audio.done (which would close the stream).
			expect(Buffer.isBuffer(sent[0])).toBe(true);
			expect(sent.some((m: any) => typeof m === 'string' && m.includes('audio.done'))).toBe(false);
			// (endpointing 850ms + 300ms margin) of 16kHz signed-16-bit mono silence.
			const expectedBytes = Math.round((16000 * (850 + 300)) / 1000) * 2;
			expect(sent[0].length).toBe(expectedBytes);
			expect(sent[0].every((b: number) => b === 0)).toBe(true);
			// Stream stays open — no teardown.
			expect(backend.getStatus()).toBe('connected');
		});

		it('should size the silence tail to a per-connection endpointing override', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect({ ...DEFAULT_CONFIG, xaiEndpointing: 300 });
			getMockWs().simulateOpen();
			await connectPromise;

			backend.forceCommit();

			const sent = getMockWs().getSentMessages();
			expect(sent).toHaveLength(1);
			expect(sent[0].length).toBe(Math.round((16000 * (300 + 300)) / 1000) * 2);
		});
	});

	describe('message handling', () => {
		let backend: XAIBackend;
		let interimResults: TranscriptionMessage[];
		let finalResults: TranscriptionMessage[];

		beforeEach(async () => {
			backend = new XAIBackend('test-tag', { id: 'p1' });
			interimResults = [];
			finalResults = [];
			backend.onInterimTranscription = (msg) => interimResults.push(msg);
			backend.onCompleteTranscription = (msg) => finalResults.push(msg);

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;
		});

		it('should emit interim on transcript.partial with is_final=false', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: false,
				speech_final: false,
				text: 'hello world',
				language: 'English',
				words: [
					{ text: 'hello', confidence: 0.9, start: 0, end: 0.5 },
					{ text: 'world', confidence: 0.8, start: 0.5, end: 1.0 },
				],
			}));

			expect(interimResults).toHaveLength(1);
			expect(interimResults[0].is_interim).toBe(true);
			expect(interimResults[0].transcript[0].text).toBe('hello world');
			expect(interimResults[0].transcript[0].confidence).toBeCloseTo(0.85);
			expect(finalResults).toHaveLength(0);
		});

		it('should emit final on transcript.partial with speech_final=true', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'hello world',
				language: 'English',
				words: [
					{ text: 'hello', confidence: 0.95, start: 0, end: 0.5 },
					{ text: 'world', confidence: 0.85, start: 0.5, end: 1.0 },
				],
			}));

			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].is_interim).toBe(false);
			expect(finalResults[0].transcript[0].text).toBe('hello world');
			expect(finalResults[0].language).toBe('English');
			expect(interimResults).toHaveLength(0);
		});

		it('should emit interim on transcript.partial with is_final=true but speech_final=false', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: false,
				text: 'hello world',
				language: 'English',
			}));

			expect(interimResults).toHaveLength(1);
			expect(interimResults[0].is_interim).toBe(true);
			expect(finalResults).toHaveLength(0);
		});

		it('should emit final on transcript.done when text is non-empty', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.done',
				text: 'hello world',
				language: 'en',
				duration: 2.5,
				words: [],
			}));

			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].is_interim).toBe(false);
			expect(finalResults[0].language).toBe('en');
			expect(interimResults).toHaveLength(0);
		});

		it('should ignore empty transcript.done (stream-end notification)', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.done',
				text: '',
				words: [],
				duration: 28.24,
			}));

			expect(finalResults).toHaveLength(0);
			expect(interimResults).toHaveLength(0);
		});

		it('should set language from transcript.partial', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'bonjour',
				language: 'French',
			}));

			expect(finalResults[0].language).toBe('French');
		});

		it('should append language suffix when XAI_INCLUDE_LANGUAGE is set', () => {
			(config.xai as any).includeLanguage = true;
			try {
				getMockWs().simulateMessage(JSON.stringify({
					type: 'transcript.partial',
					is_final: true,
					speech_final: true,
					text: 'bonjour',
					language: 'French',
				}));
				expect(finalResults[0].transcript[0].text).toBe('bonjour [French]');
			} finally {
				(config.xai as any).includeLanguage = false;
			}
		});

		it('should ignore empty transcripts', () => {
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', text: '', is_final: false }));
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: '   ', language: 'en', duration: 1 }));

			expect(interimResults).toHaveLength(0);
			expect(finalResults).toHaveLength(0);
		});

		it('should call onError (non-recoverable) and close on a generic error message', () => {
			const errorSpy = vi.fn();
			const closedSpy = vi.fn();
			backend.onError = errorSpy;
			backend.onClosed = closedSpy;

			getMockWs().simulateMessage(JSON.stringify({
				type: 'error',
				message: 'invalid api key',
			}));

			expect(errorSpy).toHaveBeenCalledWith('api_error', 'invalid api key', false);
			expect(backend.getStatus()).toBe('closed');
		});

		it('should flag "ASR stream timed out" as recoverable (JIT-15901)', () => {
			const errorSpy = vi.fn();
			backend.onError = errorSpy;

			getMockWs().simulateMessage(JSON.stringify({
				type: 'error',
				message: 'ASR stream timed out',
			}));

			expect(errorSpy).toHaveBeenCalledWith('api_error', 'ASR stream timed out', true);
			// The dead WS is still closed; recovery happens on the OutgoingConnection side.
			expect(backend.getStatus()).toBe('closed');
		});
	});

	describe('diarization', () => {
		let backend: XAIBackend;
		let interimResults: TranscriptionMessage[];
		let finalResults: TranscriptionMessage[];

		beforeEach(async () => {
			(config.xai as any).diarize = true;
			backend = new XAIBackend('test-tag', { id: 'p1' });
			interimResults = [];
			finalResults = [];
			backend.onInterimTranscription = (msg) => interimResults.push(msg);
			backend.onCompleteTranscription = (msg) => finalResults.push(msg);

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;
		});

		afterEach(() => {
			(config.xai as any).diarize = false;
		});

		it('should split interim transcript.partial by speaker', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: false,
				text: 'hello how are you',
				language: 'English',
				words: [
					{ text: 'hello', speaker: 0, confidence: 0.9, start: 0, end: 0.3 },
					{ text: 'how', speaker: 1, confidence: 0.85, start: 0.5, end: 0.7 },
					{ text: 'are', speaker: 1, confidence: 0.88, start: 0.7, end: 0.9 },
					{ text: 'you', speaker: 1, confidence: 0.92, start: 0.9, end: 1.1 },
				],
			}));

			expect(interimResults).toHaveLength(2);
			expect(interimResults[0].speaker).toBe(0);
			expect(interimResults[0].transcript[0].text).toBe('hello');
			expect(interimResults[1].speaker).toBe(1);
			expect(interimResults[1].transcript[0].text).toBe('how are you');
		});

		it('should split final transcript.partial (speech_final=true) by speaker', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'hello how are you',
				language: 'English',
				words: [
					{ text: 'hello', speaker: 0, confidence: 0.9, start: 0, end: 0.3 },
					{ text: 'how', speaker: 1, confidence: 0.85, start: 0.5, end: 0.7 },
					{ text: 'are', speaker: 1, confidence: 0.88, start: 0.7, end: 0.9 },
					{ text: 'you', speaker: 1, confidence: 0.92, start: 0.9, end: 1.1 },
				],
			}));

			expect(finalResults).toHaveLength(2);
			expect(finalResults[0].speaker).toBe(0);
			expect(finalResults[0].language).toBe('English');
			expect(finalResults[1].speaker).toBe(1);
		});

		it('should emit single final message when words have no speaker', () => {
			getMockWs().simulateMessage(JSON.stringify({
				type: 'transcript.partial',
				is_final: true,
				speech_final: true,
				text: 'hello world',
				language: 'English',
				words: [
					{ text: 'hello', confidence: 0.9, start: 0, end: 0.5 },
					{ text: 'world', confidence: 0.8, start: 0.5, end: 1.0 },
				],
			}));

			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].speaker).toBeUndefined();
		});
	});

	describe('granular finalization (roll-own)', () => {
		let backend: XAIBackend;
		let interimResults: TranscriptionMessage[];
		let finalResults: TranscriptionMessage[];

		async function connectGranular(overrides: Partial<BackendConfig> = {}) {
			backend = new XAIBackend('test-tag', { id: 'p1' });
			interimResults = [];
			finalResults = [];
			backend.onInterimTranscription = (msg) => interimResults.push(msg);
			backend.onCompleteTranscription = (msg) => finalResults.push(msg);
			const connectPromise = backend.connect({
				...DEFAULT_CONFIG,
				xaiGranularFinals: true,
				xaiGranularStabilityMs: 600,
				xaiGranularGuardWords: 2,
				...overrides,
			});
			getMockWs().simulateOpen();
			await connectPromise;
		}

		const partial = (text: string, isFinal: boolean, speechFinal: boolean) =>
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', is_final: isFinal, speech_final: speechFinal, text }));

		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			(config.xai as any).granularMinWords = 3;
		});

		afterEach(() => {
			vi.useRealTimers();
			(config.xai as any).granularMinWords = 5;
		});

		it('does NOT enable granular by default (one final per turn preserved)', async () => {
			// Default config (no granular flag) -> is_final/!speech_final stays interim, only
			// speech_final commits. This guards the default behavioral contract.
			const b = new XAIBackend('test-tag', { id: 'p1' });
			const finals: TranscriptionMessage[] = [];
			b.onCompleteTranscription = (m) => finals.push(m);
			const p = b.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await p;
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.partial', is_final: true, speech_final: false, text: 'one two three four five' }));
			expect(finals).toHaveLength(0); // no granular commit without the flag
		});

		it('commits a stabilized prefix as a FINAL before end of turn', async () => {
			await connectGranular();
			partial('one two three four five', false, false); // t=0
			expect(finalResults).toHaveLength(0); // nothing stable yet

			vi.setSystemTime(700);
			partial('one two three four five six', false, false); // first 4 stable >=600ms
			// guard=2 holds back the last two; minWords=3 -> "one two three" committed.
			expect(finalResults).toHaveLength(1);
			expect(finalResults[0].is_interim).toBe(false);
			expect(finalResults[0].transcript[0].text).toBe('one two three');
		});

		it('speech_final flushes only the trailing remainder (no double-emit of committed text)', async () => {
			await connectGranular();
			partial('hello world foo bar', false, false); // t=0
			vi.setSystemTime(700);
			partial('hello world foo bar baz', false, false); // commit "hello world foo"
			const committedSoFar = finalResults.map((m) => m.transcript[0].text).join(' ');
			expect(committedSoFar).toBe('hello world foo');

			vi.setSystemTime(800);
			partial('hello world foo bar baz qux', true, true); // speech_final re-emits whole turn
			const all = finalResults.map((m) => m.transcript[0].text);
			// the end-of-turn commit must be only the uncommitted tail, never the whole turn
			expect(all[all.length - 1]).toBe('bar baz qux');
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe('hello world foo bar baz qux');
		});

		it('emits the in-progress remainder as an interim (Deepgram-like)', async () => {
			await connectGranular();
			partial('one two three four five', false, false);
			vi.setSystemTime(700);
			partial('one two three four five six', false, false);
			// after committing "one two three", the interim shows the uncommitted remainder
			expect(interimResults[interimResults.length - 1].is_interim).toBe(true);
			expect(interimResults[interimResults.length - 1].transcript[0].text).toBe('four five six');
		});

		it('flushes a now-stable prefix on the timer when interims stop (pause)', async () => {
			await connectGranular();
			partial('aa bb cc dd ee', false, false); // t=0, nothing stable yet
			expect(finalResults).toHaveLength(0);
			// No further interims arrive; advance time so the scheduled flush timer fires.
			await vi.advanceTimersByTimeAsync(900);
			expect(finalResults.length).toBeGreaterThanOrEqual(1);
			expect(finalResults[0].transcript[0].text).toBe('aa bb cc');
		});

		it('clears the flush timer on close — no ghost commit after teardown (reconnect safety)', async () => {
			// On a recoverable "ASR stream timed out" reconnect the old backend is closed and a fresh
			// XAIBackend (fresh segmenter) takes over. The old backend's armed flush timer must not
			// fire a late/ghost commit after teardown — close() clears it.
			await connectGranular();
			partial('aa bb cc dd ee', false, false); // arms the flush timer, nothing committed yet
			expect(finalResults).toHaveLength(0);
			backend.close();
			await vi.advanceTimersByTimeAsync(3000); // the timer would have fired by now
			expect(finalResults).toHaveLength(0); // no ghost commit
		});

		it('flushes the in-progress tail on transcript.done when no speech_final occurred', async () => {
			await connectGranular();
			partial('hello world foo bar', false, false); // t=0
			vi.setSystemTime(700);
			partial('hello world foo bar baz', false, false); // commit "hello world foo"
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe('hello world foo');
			// stream closes mid-turn -> transcript.done re-emits the whole turn; flush only the tail
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'hello world foo bar baz', duration: 3 }));
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe('hello world foo bar baz');
		});

		it('ignores transcript.done that repeats an already-committed turn (no duplicate)', async () => {
			await connectGranular();
			partial('hello world foo bar baz', true, true); // speech_final ends the turn
			const afterTurn = finalResults.map((m) => m.transcript[0].text).join(' ');
			expect(afterTurn).toBe('hello world foo bar baz');
			// stream-end done repeats the whole turn -> must be ignored
			getMockWs().simulateMessage(JSON.stringify({ type: 'transcript.done', text: 'hello world foo bar baz', duration: 5 }));
			expect(finalResults.map((m) => m.transcript[0].text).join(' ')).toBe(afterTurn);
		});

		it('falls back to default mode (no granular) when diarize is enabled', async () => {
			(config.xai as any).diarize = true;
			try {
				await connectGranular();
				// is_final/!speech_final must remain interim (granular disabled under diarize)
				partial('one two three four five', true, false);
				vi.setSystemTime(700);
				partial('one two three four five six', true, false);
				expect(finalResults).toHaveLength(0);
			} finally {
				(config.xai as any).diarize = false;
			}
		});

		it('can be enabled via global config flag (not just per-connection)', async () => {
			(config.xai as any).granularFinals = true;
			(config.xai as any).granularStabilityMs = 600;
			(config.xai as any).granularGuardWords = 2;
			try {
				backend = new XAIBackend('test-tag', { id: 'p1' });
				finalResults = [];
				backend.onCompleteTranscription = (m) => finalResults.push(m);
				const p = backend.connect(DEFAULT_CONFIG); // no per-connection override
				getMockWs().simulateOpen();
				await p;
				partial('one two three four five', false, false);
				vi.setSystemTime(700);
				partial('one two three four five six', false, false);
				expect(finalResults).toHaveLength(1);
				expect(finalResults[0].transcript[0].text).toBe('one two three');
			} finally {
				(config.xai as any).granularFinals = false;
				(config.xai as any).granularStabilityMs = 1000;
				(config.xai as any).granularGuardWords = 3;
			}
		});
	});

	describe('close', () => {
		it('should set status to closed', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			backend.close();
			expect(backend.getStatus()).toBe('closed');
		});

		it('should call onClosed when WebSocket closes remotely', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const closedSpy = vi.fn();
			backend.onClosed = closedSpy;

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			getMockWs().simulateClose();
			expect(closedSpy).toHaveBeenCalled();
		});

		it('should fire onClosed exactly once across close() and the close event', async () => {
			const backend = new XAIBackend('test-tag', { id: 'p1' });
			const closedSpy = vi.fn();
			backend.onClosed = closedSpy;

			const connectPromise = backend.connect(DEFAULT_CONFIG);
			getMockWs().simulateOpen();
			await connectPromise;

			backend.close();
			getMockWs().simulateClose();
			expect(closedSpy).toHaveBeenCalledTimes(1);
		});
	});
});
