import { cosine } from './embedder.js';

/**
 * Open-set match: return the best candidate iff its cosine >= threshold,
 * else {identity:null, score:bestScore}. Never forces a wrong identity.
 */
export function decideMatch(
  query: Float32Array,
  candidates: { identity: string; vector: Float32Array }[],
  threshold: number,
): { identity: string | null; score: number } {
  let best = { identity: null as string | null, score: 0 };
  for (const c of candidates) {
    const score = cosine(query, c.vector);
    if (score > best.score) best = { identity: c.identity, score };
  }
  if (best.identity !== null && best.score >= threshold) return best;
  return { identity: null, score: best.score };
}
