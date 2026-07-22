import { cosine } from './vecmath';

// Single-mic enrollment guard. Before auto-enrolling a "single-person" endpoint's audio as one
// speaker's fingerprint, verify the window really IS one consistent voice: split it into
// sub-windows, embed each, and compare. If a second voice is present (a shared mic on a
// non-diarized endpoint, where the transcription backend's per-word speaker labels are absent),
// the sub-window embeddings diverge and we refuse to enroll. Pure + injectable (no sherpa) so it
// unit-tests without the native codec. JIT-16065.

export type EmbedFn = (pcm: Buffer) => Promise<Float32Array | null>;

export interface EnrollConsistencyOptions {
  sampleRate?: number; // default 16000 (s16le mono)
  subWindowSec?: number; // sub-window length in seconds, default 2
  threshold?: number; // min pairwise cosine to accept as a single voice, default 0.5
}

export interface EnrollConsistencyResult {
  /** true ⇒ safe to enroll (one consistent voice, or not enough data to judge). */
  consistent: boolean;
  /** Minimum pairwise cosine across embedded sub-windows; NaN when it couldn't be computed. */
  minCosine: number;
  /** Number of sub-windows that embedded successfully. */
  windows: number;
  reason: 'ok' | 'divergent' | 'insufficient-audio' | 'insufficient-embeddings';
}

/**
 * Decide whether `pcm` is a single consistent voice. Only ever BLOCKS on a positive detection of
 * divergence (min pairwise cosine < threshold); when there isn't enough audio/embeddings to judge
 * it does NOT block (refusing a legit enroll on missing data is worse — a later window will pass).
 */
export async function checkEnrollConsistency(
  pcm: Buffer,
  embed: EmbedFn,
  opts: EnrollConsistencyOptions = {},
): Promise<EnrollConsistencyResult> {
  const sr = opts.sampleRate ?? 16000;
  const bytesPerSec = sr * 2;
  const subBytes = Math.max(2, Math.floor((opts.subWindowSec ?? 2) * bytesPerSec)) & ~1; // even (s16le)
  const threshold = opts.threshold ?? 0.5;

  const n = Math.floor(pcm.length / subBytes);
  if (n < 2) return { consistent: true, minCosine: NaN, windows: n, reason: 'insufficient-audio' };

  const vecs: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const v = await embed(pcm.subarray(i * subBytes, (i + 1) * subBytes));
    if (v) vecs.push(v);
  }
  if (vecs.length < 2) {
    return { consistent: true, minCosine: NaN, windows: vecs.length, reason: 'insufficient-embeddings' };
  }

  let minCos = Infinity;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const c = cosine(vecs[i], vecs[j]);
      if (c < minCos) minCos = c;
    }
  }

  return minCos >= threshold
    ? { consistent: true, minCosine: minCos, windows: vecs.length, reason: 'ok' }
    : { consistent: false, minCosine: minCos, windows: vecs.length, reason: 'divergent' };
}
