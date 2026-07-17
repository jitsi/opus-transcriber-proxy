import sherpa from 'sherpa-onnx-node';

export interface Segment {
  start: number;
  end: number;
  speaker: number;
}

export interface Diarizer {
  analyze(audio: Float32Array): Promise<Segment[]>;
}

export interface DiarizerModels {
  segModel: string;
  embeddingModel: string;
  clusterThreshold?: number;
}

export function createDiarizer({ segModel, embeddingModel, clusterThreshold = 0.8 }: DiarizerModels): Diarizer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sd = new (sherpa as any).OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: segModel }, numThreads: 1, debug: false },
    embedding: { model: embeddingModel, numThreads: 1, debug: false },
    // numClusters -1 => auto-detect count via the cosine threshold.
    clustering: { numClusters: -1, threshold: clusterThreshold },
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  });
  return {
    async analyze(audio: Float32Array): Promise<Segment[]> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const segs = sd.process(audio) as any[];
      return segs.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }));
    },
  };
}

export function speakerCount(segs: Segment[]): number {
  return new Set(segs.map((s) => s.speaker)).size;
}

/** Total speech duration per speaker id. */
export function speakerDurations(segs: Segment[]): Map<number, number> {
  const d = new Map<number, number>();
  for (const s of segs) d.set(s.speaker, (d.get(s.speaker) ?? 0) + (s.end - s.start));
  return d;
}

export interface SpeakerGuard {
  /** A speaker must have at least this much total speech (seconds). */
  minDurationSec: number;
  /** ...and at least this share of total speech (0-1). */
  minShare: number;
}

export const DEFAULT_GUARD: SpeakerGuard = { minDurationSec: 2.0, minShare: 0.1 };

/**
 * Speaker ids that clear the guard — brief blips (a stray cough, a
 * cross-talk fragment, a mis-clustered 0.3s segment) are dropped so they
 * can't inflate the count. Makes single-speaker → 1 robust to the
 * clustering threshold, which is the fragile knob.
 */
export function significantSpeakers(segs: Segment[], guard: SpeakerGuard = DEFAULT_GUARD): number[] {
  const durations = speakerDurations(segs);
  let total = 0;
  for (const v of durations.values()) total += v;
  const out: number[] = [];
  for (const [spk, dur] of durations) {
    if (dur >= guard.minDurationSec && (total === 0 || dur / total >= guard.minShare)) out.push(spk);
  }
  return out;
}

export function countSpeakers(segs: Segment[], guard: SpeakerGuard = DEFAULT_GUARD): number {
  return significantSpeakers(segs, guard).length;
}

export function hasMultipleSpeakers(segs: Segment[], guard: SpeakerGuard = DEFAULT_GUARD): boolean {
  return countSpeakers(segs, guard) > 1;
}
