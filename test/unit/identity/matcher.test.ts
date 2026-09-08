import { describe, it, expect } from 'vitest';
import { decideMatch } from '../../../src/identity/matcher';
import type { Fingerprint } from '../../../src/identity/vectorize';

const fp = (identity: string, vector: number[], name?: string): Fingerprint => ({
	identity,
	vector: Float32Array.from(vector),
	name,
});

describe('decideMatch', () => {
	it('returns the best candidate when its cosine >= threshold', () => {
		const q = Float32Array.from([1, 0, 0]);
		const r = decideMatch(q, [fp('alice', [0, 1, 0]), fp('bob', [1, 0, 0], 'Bob')], 0.9);
		expect(r.identity).toBe('bob');
		expect(r.name).toBe('Bob');
		expect(r.score).toBeCloseTo(1, 5);
	});

	it('returns null identity but the real best score when below threshold', () => {
		const q = Float32Array.from([1, 0, 0]);
		// best cosine here is 0 (orthogonal) — must be reported, not forced to a match.
		const r = decideMatch(q, [fp('alice', [0, 1, 0])], 0.5);
		expect(r.identity).toBeNull();
		expect(r.score).toBeCloseTo(0, 5);
	});

	it('reports a negative best score on no-match (not a misleading 0)', () => {
		const q = Float32Array.from([1, 0]);
		const r = decideMatch(q, [fp('alice', [-1, 0])], 0.5);
		expect(r.identity).toBeNull();
		expect(r.score).toBeCloseTo(-1, 5);
	});

	it('returns {null, 0} when there are no candidates (never emits -Infinity)', () => {
		const r = decideMatch(Float32Array.from([1, 0, 0]), [], 0.5);
		expect(r).toEqual({ identity: null, score: 0 });
	});

	it('picks the highest of several above-threshold candidates', () => {
		const q = Float32Array.from([1, 1, 0]);
		const r = decideMatch(q, [fp('a', [1, 0, 0]), fp('b', [1, 1, 0]), fp('c', [0, 1, 0])], 0.5);
		expect(r.identity).toBe('b'); // exact direction → cosine 1
	});
});
