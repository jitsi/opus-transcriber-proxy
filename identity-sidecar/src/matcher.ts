import { cosine } from './embedder.js';
import type { Fingerprint } from './store/FingerprintStore.js';

export interface MatchResult {
  identity: string | null;
  score: number;
  name?: string;
}

/**
 * Open-set match: return the best candidate iff its cosine >= threshold,
 * else {identity:null, score:bestScore}. Never forces a wrong identity.
 */
export function decideMatch(query: Float32Array, candidates: Fingerprint[], threshold: number): MatchResult {
  let best: MatchResult = { identity: null, score: 0 };
  for (const c of candidates) {
    const score = cosine(query, c.vector);
    if (score > best.score) best = { identity: c.identity, score, name: c.name };
  }
  if (best.identity !== null && best.score >= threshold) return best;
  return { identity: null, score: best.score };
}
