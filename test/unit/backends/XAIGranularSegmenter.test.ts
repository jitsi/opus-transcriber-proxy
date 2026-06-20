/**
 * Tests for XAIGranularSegmenter — the consumer-side roll-own granular finalizer.
 *
 * Includes a LIVE-REPLAY validation: a real transcript.partial event stream captured from
 * wss://api.x.ai/v1/stt (test/fixtures/xai-live-turn.json) is replayed through the shipping
 * segmenter and we assert the committed transcript reconstructs the authoritative turn exactly
 * (0 word-edits) while emitting it as multiple in-order segments. This is the same fixture and
 * algorithm validated by the tuning sweep in unreal-agents/experiments/xai-vs-deepgram-finalization.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XAIGranularSegmenter } from '../../../src/backends/XAIGranularSegmenter';

const normalize = (s: string): string =>
	s.toLowerCase().replace(/[.,!?;:"'’]/g, '').replace(/\s+/g, ' ').trim();
const normWords = (s: string): string[] => normalize(s).split(' ').filter(Boolean);

/** Word-level Levenshtein on normalized tokens (the same correctness metric as the harness). */
function wordEditDistance(a: string[], b: string[]): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++)
		for (let j = 1; j <= n; j++)
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
	return dp[m][n];
}

describe('XAIGranularSegmenter', () => {
	describe('stable-prefix freeze', () => {
		it('freezes words once stable for stabilityMs, holding back guardWords', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 600, guardWords: 2, minWords: 3 });

			// t=0: nothing is old enough to freeze yet.
			let r = seg.pushPartial('one two three four five', false, false, 0);
			expect(r.commits).toEqual([]);
			expect(r.interim).toBe('one two three four five');

			// t=700: the first 4 words have been stable for 700ms (>=600); guard=2 holds back the
			// last 2 ("five", and the newly arrived "six"). 4 frozen, batched at minWords=3.
			r = seg.pushPartial('one two three four five six', false, false, 700);
			expect(r.commits).toEqual(['one two three']);
			expect(r.interim).toBe('four five six'); // remainder after the emitted final
		});

		it('does not freeze a word that keeps getting revised inside the window', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 600, guardWords: 1, minWords: 2 });
			seg.pushPartial('alpha bravo charlie', false, false, 0);
			// charlie revised to "charles" at t=300 (within window) -> its clock resets.
			seg.pushPartial('alpha bravo charles delta', false, false, 300);
			// t=700: alpha/bravo stable since 0 (>=600) freeze; "charles" stable only since 300 (<600).
			const r = seg.pushPartial('alpha bravo charles delta echo', false, false, 700);
			expect(r.commits).toEqual(['alpha bravo']);
		});
	});

	describe('speech_final reconciliation', () => {
		it('flushes only the trailing remainder, not the re-emitted whole turn', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 600, guardWords: 1, minWords: 2 });
			seg.pushPartial('hello world foo', false, false, 0);
			const r1 = seg.pushPartial('hello world foo bar', false, false, 700);
			expect(r1.commits).toEqual(['hello world']); // "foo" held in batch buffer, "bar" is guard

			// speech_final re-emits the WHOLE turn; we must only append the uncommitted tail.
			const r2 = seg.pushPartial('hello world foo bar baz', true, true, 800);
			expect(r2.endOfTurn).toBe(true);
			expect(r2.commits).toEqual(['foo bar baz']); // NOT "hello world foo bar baz"
			expect(r2.interim).toBeNull();
		});

		it('resets state after end of turn so the next turn starts clean', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 600, guardWords: 1, minWords: 2 });
			seg.pushPartial('first turn done', true, true, 0);
			const r = seg.pushPartial('second', false, false, 100);
			expect(r.interim).toBe('second'); // no leakage of the first turn
		});
	});

	describe('chunk_final reconstruction (segment-wise, interims reset)', () => {
		it('folds a chunk_final into the base and appends the fresh next interim', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 10_000, guardWords: 0, minWords: 100 });
			// big stability + huge minWords => nothing commits; we inspect the reconstructed interim.
			seg.pushPartial('but its such a pain', false, false, 0);
			seg.pushPartial('but its such a pain.', true, false, 100); // chunk_final segment
			const r = seg.pushPartial('that i thought', false, false, 200); // fresh next segment
			// The interim (full uncommitted hypothesis) must be base + the fresh continuation,
			// with NO duplication and NO loss of the finalized segment.
			expect(r.interim).toBe('but its such a pain. that i thought');
		});

		it('handles a cumulative interim (already includes the base) without duplicating', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 10_000, guardWords: 0, minWords: 100 });
			seg.pushPartial('alpha beta.', true, false, 0); // chunk_final base = "alpha beta."
			// a cumulative provider would resend the base prefix; mergeBase must not double it.
			const r = seg.pushPartial('alpha beta. gamma', false, false, 100);
			expect(r.interim).toBe('alpha beta. gamma');
		});
	});

	describe('batching', () => {
		it('flushes a short segment early when a word ends a sentence', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 100, guardWords: 0, minWords: 10 });
			seg.pushPartial('yes.', false, false, 0);
			const r = seg.pushPartial('yes. and', false, false, 500);
			// "yes." ends a sentence -> emitted even though minWords (10) not reached.
			expect(r.commits).toEqual(['yes.']);
		});
	});

	describe('flushDue (pause / timer path)', () => {
		it('commits a now-stable prefix when interims stop arriving', () => {
			const seg = new XAIGranularSegmenter({ stabilityMs: 600, guardWords: 1, minWords: 2 });
			seg.pushPartial('aa bb cc dd', false, false, 0); // nothing stable yet
			expect(seg.nextDueTime()).toBe(600); // earliest eligibility
			const r = seg.flushDue(700); // timer fires after the window with no new interim
			expect(r.commits).toEqual(['aa bb']); // cc held in buffer, dd is guard
		});
	});

	describe('live replay against real captured xAI events', () => {
		const fixture = JSON.parse(
			readFileSync(join(__dirname, '../../fixtures/xai-live-turn.json'), 'utf8'),
		) as { authoritativeTurn: string; events: Array<{ t: number; is_final: boolean; speech_final: boolean; text: string }> };

		function replay(stabilityMs: number, guardWords: number, minWords: number) {
			const seg = new XAIGranularSegmenter({ stabilityMs, guardWords, minWords });
			const commits: string[] = [];
			for (const e of fixture.events) {
				const r = seg.pushPartial(e.text, e.is_final, e.speech_final, e.t);
				commits.push(...r.commits);
			}
			return commits;
		}

		it('reconstructs the authoritative turn with 0 word-edits (default 1000ms/3-guard)', () => {
			const commits = replay(1000, 3, 5);
			const committed = normWords(commits.join(' '));
			const authoritative = normWords(fixture.authoritativeTurn);
			expect(wordEditDistance(committed, authoritative)).toBe(0);
			expect(committed.length).toBe(authoritative.length);
		});

		it('emits the turn as MANY in-order segments, not one late block', () => {
			const commits = replay(1000, 3, 5);
			expect(commits.length).toBeGreaterThanOrEqual(5); // granular
			// no single commit is the whole turn (that would be the displaced-block bug)
			const turnWordCount = normWords(fixture.authoritativeTurn).length;
			for (const c of commits) expect(normWords(c).length).toBeLessThan(turnWordCount);
		});

		it('keeps 0 word-edits across the whole tuned grid (fast and slow)', () => {
			const authoritative = normWords(fixture.authoritativeTurn);
			for (const stabilityMs of [600, 1000, 1500, 2000]) {
				for (const guard of [2, 3, 5]) {
					const committed = normWords(replay(stabilityMs, guard, 5).join(' '));
					expect(wordEditDistance(committed, authoritative)).toBe(0);
				}
			}
		});
	});
});
