import { describe, it, expect } from 'vitest';
import { SpeakerClusterer } from '../src/pipeline/SpeakerClusterer.js';

const v = (...xs: number[]): Float32Array => Float32Array.from(xs);

describe('SpeakerClusterer', () => {
  it('assigns near-identical vectors to the same cluster', () => {
    const c = new SpeakerClusterer(0.5);
    const a = c.assign(v(1, 0, 0));
    const b = c.assign(v(0.98, 0.02, 0));
    expect(a).toBe(b);
    expect(c.clusterCount()).toBe(1);
  });

  it('starts a new cluster for an orthogonal vector', () => {
    const c = new SpeakerClusterer(0.5);
    const a = c.assign(v(1, 0, 0));
    const b = c.assign(v(0, 1, 0));
    expect(b).not.toBe(a);
    expect(c.clusterCount()).toBe(2);
  });

  it('keeps a normalized centroid retrievable by id', () => {
    const c = new SpeakerClusterer(0.5);
    const id = c.assign(v(1, 0, 0));
    c.assign(v(0.9, 0.1, 0));
    const centroid = c.getCentroid(id)!;
    let n = 0;
    for (const x of centroid) n += x * x;
    expect(Math.sqrt(n)).toBeCloseTo(1, 3);
  });
});
