import { describe, it, expect } from 'vitest';
import { checkEnrollConsistency, type EmbedFn } from '../../../src/identity/enrollGuard';

// 1s of 16kHz s16le mono. `marker` is written as the first sample so a fake embedder can
// tell sub-windows apart by content.
const sec = (marker: number, seconds = 1): Buffer => {
  const b = Buffer.alloc(16000 * 2 * seconds);
  b.writeInt16LE(marker, 0);
  return b;
};

// Fake embedder: returns a unit vector chosen by the slice's first sample. Same marker → same
// vector (cosine 1.0); different markers → orthogonal vectors (cosine 0.0).
const vecFor = (marker: number): Float32Array => {
  const v = new Float32Array(4);
  v[marker % 4] = 1;
  return v;
};
const fakeEmbed: EmbedFn = async (pcm: Buffer) => vecFor(pcm.readInt16LE(0));

describe('checkEnrollConsistency', () => {
  it('accepts a single consistent voice (all sub-windows identical)', async () => {
    const pcm = Buffer.concat([sec(1), sec(1), sec(1), sec(1)]);
    const r = await checkEnrollConsistency(pcm, fakeEmbed, { subWindowSec: 1, threshold: 0.5 });
    expect(r.consistent).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.windows).toBe(4);
    expect(r.minCosine).toBeCloseTo(1, 5);
  });

  it('blocks a window with a divergent second voice', async () => {
    // first half speaker 1, second half speaker 2 (orthogonal → cosine 0)
    const pcm = Buffer.concat([sec(1), sec(1), sec(2), sec(2)]);
    const r = await checkEnrollConsistency(pcm, fakeEmbed, { subWindowSec: 1, threshold: 0.5 });
    expect(r.consistent).toBe(false);
    expect(r.reason).toBe('divergent');
    expect(r.minCosine).toBeCloseTo(0, 5);
  });

  it('does not block when there is too little audio to judge (<2 sub-windows)', async () => {
    const r = await checkEnrollConsistency(sec(1), fakeEmbed, { subWindowSec: 2, threshold: 0.5 });
    expect(r.consistent).toBe(true);
    expect(r.reason).toBe('insufficient-audio');
  });

  it('does not block when fewer than 2 sub-windows embed successfully', async () => {
    const nullEmbed: EmbedFn = async () => null;
    const pcm = Buffer.concat([sec(1), sec(1), sec(1)]);
    const r = await checkEnrollConsistency(pcm, nullEmbed, { subWindowSec: 1, threshold: 0.5 });
    expect(r.consistent).toBe(true);
    expect(r.reason).toBe('insufficient-embeddings');
    expect(r.windows).toBe(0);
  });

  it('respects the threshold at the boundary', async () => {
    // Two vectors at cosine 0.5 exactly: build embed that returns fixed vectors per marker.
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0.5, Math.sqrt(0.75)]); // cosine(a,b) = 0.5
    const embed: EmbedFn = async (pcm) => (pcm.readInt16LE(0) === 1 ? a : b);
    const pcm = Buffer.concat([sec(1), sec(2)]);
    const atThreshold = await checkEnrollConsistency(pcm, embed, { subWindowSec: 1, threshold: 0.5 });
    expect(atThreshold.consistent).toBe(true); // >= threshold accepted
    const aboveThreshold = await checkEnrollConsistency(pcm, embed, { subWindowSec: 1, threshold: 0.6 });
    expect(aboveThreshold.consistent).toBe(false);
  });
});
