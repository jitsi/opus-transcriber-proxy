/**
 * Consumer-side "roll-own" granular finalization for xAI STT.
 *
 * WHY THIS EXISTS (the GT-meeting ordering bug)
 * ---------------------------------------------
 * In Jitsi Meetings we run one xAI WebSocket per participant and commit a final ONLY on xAI's
 * end-of-turn `speech_final` (which re-emits the WHOLE turn at once). For a long speaker that
 * means the entire turn's text lands in the stored transcript at ~end-of-turn — AFTER every
 * short "Yeah" / "Right" ack another participant said meanwhile. The transcript reads:
 *
 *     Jacqui: Yeah.   Jacqui: Yeah.   Jacqui: Right.   Emil: <entire 79-word block>
 *
 * i.e. the long turn is fully displaced behind the acks. (Verified live; see the tuning harness
 * in unreal-agents/experiments/xai-vs-deepgram-finalization.)
 *
 * THE FIX (no xAI change required)
 * --------------------------------
 * Reconstruct xAI's growing hypothesis from its interim stream and commit a STABLE PREFIX once
 * it has been unchanged for `stabilityMs`, holding back the last `guardWords` words as volatile,
 * then batch frozen words into Deepgram-sized segments. This makes the long turn commit
 * incrementally (first segment ~3s in), so it interleaves with the acks in order — exactly how
 * Deepgram's native `is_final` already behaves. It is provider-independent: it does not wait on
 * xAI's `chunk_final` (which only fires on internal silence), so it works on fluent speech too.
 *
 * RECONSTRUCTION (verified live against wss://api.x.ai/v1/stt, 2026-06):
 *   - Interims grow cumulatively WITHIN a segment ("But it's such a" -> "But it's such a pain.").
 *   - xAI emits `chunk_final` (is_final && !speech_final) for a finalized SEGMENT; its text is
 *     segment-wise (does NOT repeat earlier segments), and the next interim RESETS to the start
 *     of the next segment. So the full running hypothesis =
 *         (concatenation of chunk_final segments so far) + (current in-progress interim).
 *   - `speech_final` (is_final && speech_final) re-emits the ENTIRE turn and ends it.
 *   `mergeBase()` reconstructs this with a prefix-check (append unless already cumulative), so it
 *   stays correct even if xAI ever switches its interims to cumulative-across-segments.
 *
 * speech_final RECONCILIATION: because speech_final re-emits the whole turn, we must NOT reprint
 * it. We emit only the trailing words not already committed (the held-back guard tail + any
 * speech_final-only words like a final "So yeah."), taken from speech_final's authoritative text.
 * Reconciliation APPENDS — it never rewrites an already-committed word — so the only correctness
 * cost is a prefix word we committed early that xAI later revised (measured ~0 with a >=1000ms
 * window; see the tuning curve). This is a pure state machine driven by an injected clock value,
 * so it is unit-testable without real timers.
 */

export interface GranularResult {
	/** Committed segment texts to emit as FINALS (is_interim=false), in order. */
	commits: string[];
	/** The uncommitted remainder to emit as an interim (Deepgram-like), or null if empty. */
	interim: string | null;
	/** True when speech_final closed the turn (state has been reset for the next turn). */
	endOfTurn: boolean;
}

export interface GranularSegmenterOptions {
	/** Debounce window: a word freezes once its prefix has been unchanged this many ms. */
	stabilityMs: number;
	/** Volatile words held back at the growing edge (never frozen from the interim stream). */
	guardWords: number;
	/** Frozen words are batched into a segment once it reaches this many words (or a sentence end). */
	minWords: number;
}

const SENTENCE_END = /[.?!]$/;

function splitWords(s: string): string[] {
	return s.trim().split(/\s+/).filter(Boolean);
}

function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[.,!?;:"'’]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export class XAIGranularSegmenter {
	private readonly stabilityMs: number;
	private readonly guardWords: number;
	private readonly minWords: number;

	// --- per-turn state ---
	private baseText = ''; // accumulation of finalized chunk_final segments this turn
	private hyp: string[] = []; // current full hypothesis words
	private stableSince: number[] = []; // wall-clock ms the CURRENT value of position i first appeared
	private emittedWordCount = 0; // raw words already emitted as committed segments this turn
	private pending: string[] = []; // frozen-but-not-yet-batched words (held until minWords/sentence end)

	constructor(opts: GranularSegmenterOptions) {
		this.stabilityMs = Math.max(0, opts.stabilityMs);
		this.guardWords = Math.max(0, opts.guardWords);
		this.minWords = Math.max(1, opts.minWords);
	}

	/**
	 * Feed one transcript.partial. `isFinalSeg` = is_final flag, `speechFinal` = speech_final flag.
	 * `now` is the wall-clock ms (injected for testability). Returns committed segments + the
	 * current interim remainder.
	 */
	pushPartial(text: string, isFinalSeg: boolean, speechFinal: boolean, now: number): GranularResult {
		if (speechFinal) {
			return this.endTurn(text);
		}
		let hypText: string;
		if (isFinalSeg) {
			// chunk_final: a segment is finalized; fold it into the base and let the next interim
			// (which resets) append to it.
			this.baseText = this.mergeBase(this.baseText, text);
			hypText = this.baseText;
		} else {
			hypText = this.mergeBase(this.baseText, text);
		}
		this.updateHyp(splitWords(hypText), now);
		const commits = this.freeze(now);
		return { commits, interim: this.tailText(), endOfTurn: false };
	}

	/**
	 * Timer-driven freeze: call when interims stop arriving (a pause) so a now-stable prefix still
	 * commits. `now` is the current wall-clock ms. Returns any newly committed segments.
	 */
	flushDue(now: number): GranularResult {
		const commits = this.freeze(now);
		return { commits, interim: this.tailText(), endOfTurn: false };
	}

	/**
	 * The wall-clock ms at which the next not-yet-frozen, non-guard-held word becomes
	 * freeze-eligible — used to schedule the flush timer. Null when nothing is pending.
	 */
	nextDueTime(): number | null {
		const ceil = this.hyp.length - this.guardWords;
		const from = this.frozenCount();
		for (let i = from; i < ceil; i++) {
			if (this.stableSince[i] != null) return this.stableSince[i] + this.stabilityMs;
		}
		return null;
	}

	/**
	 * Whether a turn is currently in progress (some hypothesis seen and not yet ended). Used to
	 * decide whether a non-empty transcript.done should flush a trailing remainder or be ignored
	 * (the turn already ended via speech_final and committing it again would duplicate).
	 */
	hasActiveTurn(): boolean {
		return this.hyp.length > 0 || this.emittedWordCount > 0;
	}

	/** Number of words past the freeze pointer (emitted + held in the batching buffer). */
	private frozenCount(): number {
		return this.emittedWordCount + this.pending.length;
	}

	private mergeBase(base: string, t: string): string {
		if (!base) return t;
		// If the new text already includes the base (cumulative provider), use it as-is;
		// otherwise it is a fresh continuation -> append.
		return normalize(t).startsWith(normalize(base)) ? t : `${base} ${t}`;
	}

	private updateHyp(w: string[], now: number): void {
		let d = 0;
		while (d < w.length && d < this.hyp.length && w[d] === this.hyp[d]) d++;
		for (let i = d; i < w.length; i++) this.stableSince[i] = now;
		this.stableSince.length = w.length;
		this.hyp = w;
	}

	/** Advance the freeze pointer over stable words and batch them into segments. */
	private freeze(now: number): string[] {
		const ceil = this.hyp.length - this.guardWords;
		let i = this.frozenCount();
		for (; i < ceil; i++) {
			if (this.stableSince[i] == null || now - this.stableSince[i] < this.stabilityMs) break;
			this.pending.push(this.hyp[i]);
		}
		return this.batchPending();
	}

	/** Cut `pending` into segments of >= minWords (or ending a sentence); leftover stays pending. */
	private batchPending(): string[] {
		const out: string[] = [];
		let buf: string[] = [];
		for (const word of this.pending) {
			buf.push(word);
			if (buf.length >= this.minWords || SENTENCE_END.test(word)) {
				out.push(buf.join(' '));
				this.emittedWordCount += buf.length;
				buf = [];
			}
		}
		this.pending = buf;
		return out;
	}

	/** The uncommitted remainder (everything after the last emitted final), as interim text. */
	private tailText(): string | null {
		const tail = this.hyp.slice(this.emittedWordCount).join(' ').trim();
		return tail || null;
	}

	/**
	 * End of turn (speech_final): flush the trailing words not already emitted, taken from the
	 * authoritative whole-turn text, then reset for the next turn. Slicing by emittedWordCount
	 * (not the freeze pointer) means any frozen-but-unemitted/guard-held words get their final
	 * value from speech_final rather than a possibly-premature interim guess.
	 */
	private endTurn(text: string): GranularResult {
		const fullWords = splitWords(text);
		const tail = fullWords.slice(this.emittedWordCount).join(' ').trim();
		this.reset();
		return { commits: tail ? [tail] : [], interim: null, endOfTurn: true };
	}

	/** Reset all per-turn state (called at end of turn). */
	reset(): void {
		this.baseText = '';
		this.hyp = [];
		this.stableSince = [];
		this.emittedWordCount = 0;
		this.pending = [];
	}
}
