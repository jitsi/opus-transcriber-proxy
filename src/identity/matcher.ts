import { cosine } from './vecmath';
import type { Fingerprint } from './vectorize';

export interface MatchResult {
	identity: string | null;
	score: number;
	name?: string;
}

/**
 * Open-set match: return the best candidate iff its cosine >= threshold, else
 * {identity:null, score:bestScore}. Never forces a wrong identity.
 */
export function decideMatch(query: Float32Array, candidates: Fingerprint[], threshold: number): MatchResult {
	// -Infinity (not 0) so the reported score is the actual best cosine even when all candidates are
	// negative — otherwise a no-match would log a misleading score of 0 instead of e.g. -0.12.
	let best: MatchResult = { identity: null, score: -Infinity };
	for (const c of candidates) {
		const score = cosine(query, c.vector);
		if (score > best.score) best = { identity: c.identity, score, name: c.name };
	}
	if (best.identity !== null && best.score >= threshold) return best;
	// No match: report the best observed score (0 when there were no candidates, so we never emit -Infinity).
	return { identity: null, score: Number.isFinite(best.score) ? best.score : 0 };
}
