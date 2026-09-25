/**
 * Property test for the xAI long-turn cap (XAI_MAX_TURN_MS).
 *
 * Generates seeded random turns in the event shapes xAI has been seen to send since 2026-09-19 and
 * checks invariants instead of exact outputs:
 *  - is_final carries only its own segment's text (the interim text resets after it);
 *  - speech_final carries the whole turn, either as an exact space-join of the segments or
 *    re-punctuated/re-cased (the xai-live-turn.json capture), and sometimes never comes at all;
 *  - when diarized, a committed segment's trailing words often have no `speaker`, while every
 *    speech_final word is labelled;
 *  - during silence xAI sends empty is_final events with no words.
 *
 * Invariants: every word of the turn reaches a final exactly once and in order; a turn that ends
 * inside the cap is one final (per speaker); a diarized final always has a speaker, and a
 * single-speaker turn never yields a final under any other speaker; none of these shapes trips the
 * reconciliation fallback warnings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XAIBackend, resetXAIConnectCooldown } from '../../../src/backends/XAIBackend';
import type { TranscriptionMessage } from '../../../src/transcriberproxy';
import { config } from '../../../src/config';
import logger from '../../../src/logger';

let lastWsInstance: any = null;

vi.mock('ws', () => {
	const { EventEmitter } = require('node:events');
	class MockWs extends EventEmitter {
		public readyState = 1;
		static OPEN = 1;
		static CLOSED = 3;
		private _listeners: Map<string, Set<Function>> = new Map();
		constructor(public url: string, public options?: any) {
			super();
			lastWsInstance = this;
		}
		addEventListener(event: string, handler: Function): void {
			if (!this._listeners.has(event)) this._listeners.set(event, new Set());
			this._listeners.get(event)!.add(handler);
		}
		send(): void {}
		close(): void { this.readyState = 3; }
		terminate(): void { this.readyState = 3; }
		_trigger(event: string, data: any): void { this._listeners.get(event)?.forEach((fn) => fn(data)); }
		simulateOpen(): void { this.readyState = 1; this._trigger('open', {}); }
		simulateMessage(data: any): void { this._trigger('message', { data }); }
	}
	return { default: MockWs };
});

vi.mock('../../../src/logger', () => ({
	default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/metrics', () => ({ writeMetric: vi.fn() }));
vi.mock('../../../src/telemetry/instruments', () => ({
	getInstruments: () => ({ backendHandshakeFailuresTotal: { add: vi.fn() } }),
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
			maxTurnMs: 15000,
			connectAttempts: 1,
			connectBackoffMs: 0,
		},
	},
}));

/** mulberry32: small, seedable, good enough to make a failing case reproducible from its seed. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Short, repetitive vocabulary on purpose: repeated words are what make text alignment hard.
const VOCAB = ['the', 'a', 'we', 'it', 'is', 'so', 'and', 'that', 'this', 'one', 'speaker', 'here', 'room', 'think',
	'there', 'only', 'why', 'zero', 'like', 'you', 'know', 'right', 'okay', 'meeting', 'transcript', 'final'];

interface Word { text: string; speaker?: number; confidence: number }
interface Segment { words: Word[]; commitAfterMs: number }
interface Turn { segments: Segment[]; speakers: number[]; sendSpeechFinal: boolean; repunctuate: boolean }

function generateTurn(r: () => number, diarize: boolean): Turn {
	const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
	const nSegments = 1 + Math.floor(r() * 7);
	const multiSpeaker = diarize && r() < 0.3;
	let speaker = Math.floor(r() * 3);
	const speakers = new Set<number>([speaker]);
	const segments: Segment[] = [];
	for (let s = 0; s < nSegments; s++) {
		const n = 3 + Math.floor(r() * 26);
		const words: Word[] = [];
		for (let i = 0; i < n; i++) {
			if (multiSpeaker && i > 0 && r() < 0.05) {
				speaker = (speaker + 1) % 3;
				speakers.add(speaker);
			}
			let text = pick(VOCAB);
			if (i === 0 && s === 0) text = text[0].toUpperCase() + text.slice(1);
			if (i === n - 1) text += pick(['.', '?', '.']);
			else if (r() < 0.1) text += ',';
			words.push({ text, confidence: 0.9, ...(diarize && { speaker }) });
		}
		segments.push({ words, commitAfterMs: 2000 + Math.floor(r() * 16000) });
	}
	return {
		segments,
		speakers: [...speakers],
		sendSpeechFinal: r() < 0.8,
		repunctuate: !diarize && r() < 0.5,
	};
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);

describe('XAIBackend long-turn cap: property test', () => {
	let backend: XAIBackend;
	let finals: TranscriptionMessage[];
	const send = (msg: any) => lastWsInstance.simulateMessage(JSON.stringify(msg));

	beforeEach(async () => {
		vi.clearAllMocks();
		resetXAIConnectCooldown();
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
		(config.xai as any).diarize = false;
		(config.xai as any).maxTurnMs = 15000;
	});

	async function connect() {
		backend = new XAIBackend('prop-tag', { id: 'p1' });
		finals = [];
		backend.onCompleteTranscription = (m) => finals.push(m);
		const p = backend.connect({ model: undefined, language: undefined, prompt: undefined });
		lastWsInstance.simulateOpen();
		await p;
	}

	/** Play one turn through the backend on the fake clock. Returns the turn's authoritative text. */
	function playTurn(r: () => number, turn: Turn, diarize: boolean): { fullText: string; fullWords: Word[] } {
		// Silence before the turn: empty is_final heartbeats, which must not start a turn.
		for (let i = 0; i < 2; i++) {
			send({ type: 'transcript.partial', is_final: true, speech_final: false, text: '' });
			vi.advanceTimersByTime(2000);
		}

		const fullWords: Word[] = [];
		for (const seg of turn.segments) {
			const segText = seg.words.map((w) => w.text).join(' ');
			// A few growing interims, then the commit, spread over commitAfterMs.
			const steps = 1 + Math.floor(r() * 3);
			for (let k = 1; k <= steps; k++) {
				const upto = Math.max(1, Math.floor((seg.words.length * k) / (steps + 1)));
				const words = seg.words.slice(0, upto);
				send({ type: 'transcript.partial', is_final: false, speech_final: false,
					text: words.map((w) => w.text).join(' '), words });
				vi.advanceTimersByTime(Math.floor(seg.commitAfterMs / (steps + 1)));
			}
			// The committed segment: when diarized, the trailing words often lose their label.
			let committedWords = seg.words;
			if (diarize && r() < 0.6) {
				const keep = 1 + Math.floor(r() * (seg.words.length - 1));
				committedWords = seg.words.map((w, i) => (i < keep ? w : { text: w.text, confidence: w.confidence }));
			}
			send({ type: 'transcript.partial', is_final: true, speech_final: false, text: segText, words: committedWords });
			vi.advanceTimersByTime(Math.floor(seg.commitAfterMs / (steps + 1)));
			fullWords.push(...seg.words);
		}

		let fullText = fullWords.map((w) => w.text).join(' ');
		if (turn.repunctuate) {
			// Segment-ending periods become commas and the next segment's first word is lowercased.
			fullText = turn.segments
				.map((s, i) => {
					const t = s.words.map((w) => w.text).join(' ');
					return i < turn.segments.length - 1 ? t.replace(/[.?]$/, ',') : t;
				})
				.map((t, i) => (i > 0 ? t[0].toLowerCase() + t.slice(1) : t))
				.join(' ');
		}
		if (turn.sendSpeechFinal) {
			send({ type: 'transcript.partial', is_final: true, speech_final: true, text: fullText, words: fullWords });
		} else {
			// No speech_final: only the cap timer (and any past-cap commits) can emit.
			vi.advanceTimersByTime(60000);
		}
		return { fullText, fullWords };
	}

	const turnAgeAtEnd = (turn: Turn) =>
		turn.segments.reduce((sum, s) => sum + s.commitAfterMs, 0);

	for (const diarize of [false, true]) {
		it(`every word reaches a final exactly once, in order (${diarize ? 'diarized' : 'non-diarized'})`, async () => {
			(config.xai as any).diarize = diarize;
			const CASES = 400;
			let capped = 0;
			let noSpeechFinal = 0;
			let splitTurns = 0;
			for (let seed = 1; seed <= CASES; seed++) {
				await connect();
				const r = rng(seed * (diarize ? 7919 : 104729));
				const turn = generateTurn(r, diarize);
				const { fullText, fullWords } = playTurn(r, turn, diarize);
				if (turnAgeAtEnd(turn) >= 15000) capped++;
				if (!turn.sendSpeechFinal) noSpeechFinal++;
				if (finals.length > 1) splitTurns++;
				const ctx = `seed=${seed} diarize=${diarize} segments=${turn.segments.length} ` +
					`speechFinal=${turn.sendSpeechFinal} repunct=${turn.repunctuate} turnAge=${turnAgeAtEnd(turn)}`;

				const emitted = norm(finals.map((m) => m.transcript[0].text).join(' '));
				expect(emitted, ctx).toEqual(norm(turn.sendSpeechFinal ? fullText : fullWords.map((w) => w.text).join(' ')));

				if (turn.sendSpeechFinal && turnAgeAtEnd(turn) < 15000) {
					// Inside the cap the turn is emitted exactly as before: one final per speaker run.
					if (!diarize) expect(finals, ctx).toHaveLength(1);
				}

				if (diarize) {
					for (const m of finals) expect(m.speaker, ctx).toBeTypeOf('number');
					if (turn.speakers.length === 1) {
						expect(new Set(finals.map((m) => m.speaker)), ctx).toEqual(new Set(turn.speakers));
						// A single-speaker turn is never cut at a missing label: at most one final per flush.
						const flushes = 1 + turn.segments.length;
						expect(finals.length, ctx).toBeLessThanOrEqual(flushes);
					}
				}

				const warns = (logger.warn as any).mock.calls.map((a: any[]) => String(a[0]));
				expect(warns.filter((w: string) => w.includes('speech_final for prop-tag')), ctx).toEqual([]);

				backend.close();
				vi.clearAllMocks();
			}
			// Guard the generator: the cases must actually exercise the cap and the no-speech_final path.
			expect(capped / CASES).toBeGreaterThan(0.5);
			expect(noSpeechFinal / CASES).toBeGreaterThan(0.1);
			expect(splitTurns / CASES).toBeGreaterThan(0.3);
		});
	}
});
