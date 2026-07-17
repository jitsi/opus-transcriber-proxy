import { describe, it, expect } from 'vitest';
import { decideMatch } from '../src/matcher.js';

const v = (...xs: number[]): Float32Array => {
  const a = Float32Array.from(xs);
  let s = 0;
  for (const x of a) s += x * x;
  s = Math.sqrt(s) || 1;
  return a.map((x) => x / s) as Float32Array;
};

describe('decideMatch', () => {
  const cands = [
    { identity: 'alice', vector: v(1, 0, 0) },
    { identity: 'bob', vector: v(0, 1, 0) },
  ];

  it('returns best candidate above threshold', () => {
    const r = decideMatch(v(0.9, 0.1, 0), cands, 0.5);
    expect(r.identity).toBe('alice');
    expect(r.score).toBeGreaterThan(0.5);
  });

  it('returns null below threshold but reports best score', () => {
    const r = decideMatch(v(0, 0, 1), cands, 0.5);
    expect(r.identity).toBeNull();
    expect(r.score).toBeLessThan(0.5);
  });

  it('returns null with score 0 when no candidates', () => {
    expect(decideMatch(v(1, 0, 0), [], 0.5)).toEqual({ identity: null, score: 0 });
  });
});
