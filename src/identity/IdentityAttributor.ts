import type { ISidecarClient } from './SidecarClient';
import { attribute, type Word, type AttributedSegment } from './RoomAttributor';

export interface IdentityAttributorOptions {
  sessionId: string;
  streamId: string;
  tenant: string;
  sampleRate?: number; // default 16000
  maxBufferSec?: number; // ring cap, default 120
  analyzeWindowSec?: number; // rolling context sent per final, default 45
}

/**
 * Per-stream PCM ring buffer + speaker attribution. Maintains a media clock
 * (origin = first appended sample, matching the audio sent to the ASR backend)
 * so xAI's absolute per-word times and the sidecar's turns share a timeline.
 *
 * On a final, it slices the utterance's PCM, asks the sidecar to diarize+identify
 * it, converts the returned turns to absolute media time, and attributes each
 * word to a speaker. Fully off the hot path: attributeFinal never throws and
 * returns null when the feature can't produce a result.
 */
export class IdentityAttributor {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private bufStartSec = 0;
  private readonly bytesPerSec: number;
  private readonly maxBytes: number;
  private readonly windowSec: number;

  constructor(
    private sidecar: ISidecarClient,
    private o: IdentityAttributorOptions,
  ) {
    const sr = o.sampleRate ?? 16000;
    this.bytesPerSec = sr * 2; // s16le mono
    this.maxBytes = (o.maxBufferSec ?? 120) * this.bytesPerSec;
    this.windowSec = o.analyzeWindowSec ?? 45;
  }

  appendPcm(pcm: Uint8Array): void {
    // Copy — the decoder may reuse the underlying buffer after this returns.
    this.chunks.push(Buffer.from(pcm));
    this.bufferedBytes += pcm.byteLength;
    while (this.bufferedBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bufferedBytes -= dropped.length;
      this.bufStartSec += dropped.length / this.bytesPerSec;
    }
  }

  private sliceSec(startSec: number, endSec: number): Buffer | null {
    const all = Buffer.concat(this.chunks);
    let rs = Math.floor((startSec - this.bufStartSec) * this.bytesPerSec);
    let re = Math.ceil((endSec - this.bufStartSec) * this.bytesPerSec);
    rs = Math.max(0, rs) & ~1; // even byte (s16le sample) boundaries
    re = Math.min(all.length, re) & ~1;
    if (re <= rs) return null;
    return all.subarray(rs, re);
  }

  /** Attribute an utterance's words to speakers via the sidecar. Returns null on any failure. */
  async attributeFinal(words: Word[]): Promise<AttributedSegment[] | null> {
    if (!words.length) return null;
    const uEnd = words[words.length - 1].end;
    // Send a rolling window ending at the utterance end (not just the bare utterance) so the
    // sidecar diarizes with cross-speaker context → more consistent clustering / stable handles.
    const windowStart = Math.max(this.bufStartSec, uEnd - this.windowSec);
    const pcm = this.sliceSec(windowStart, uEnd);
    if (!pcm || pcm.length < this.bytesPerSec * 0.5) return null; // need >= 0.5s of audio
    const res = await this.sidecar.analyze(this.o.sessionId, this.o.streamId, this.o.tenant, pcm);
    if (!res || res.turns.length === 0) return null;
    // Turns are relative to the sliced window; shift to absolute media time to match the words.
    const absTurns = res.turns.map((t) => ({ ...t, start: t.start + windowStart, end: t.end + windowStart }));
    return attribute(words, absTurns);
  }
}
