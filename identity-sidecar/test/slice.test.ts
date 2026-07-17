import { describe, it, expect } from 'vitest';
import { slicePcm } from '../src/pipeline/slice.js';

describe('slicePcm', () => {
  const audio = Float32Array.from({ length: 32000 }, (_v, i) => i); // 2s @16k

  it('slices [1,2)s to 16000 samples from offset 16000', () => {
    const s = slicePcm(audio, 1.0, 2.0);
    expect(s.length).toBe(16000);
    expect(s[0]).toBe(16000);
  });

  it('clamps past the end', () => {
    const s = slicePcm(audio, 1.5, 5.0);
    expect(s.length).toBe(8000);
  });

  it('returns empty for an inverted range', () => {
    expect(slicePcm(audio, 2.0, 1.0).length).toBe(0);
  });
});
