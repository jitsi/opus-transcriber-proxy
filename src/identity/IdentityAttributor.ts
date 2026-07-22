import type { ISidecarClient, IdentifyResult } from './SidecarClient';
import type { Word, AttributedSegment } from './RoomAttributor';

export interface IdentityAttributorOptions {
  sessionId: string;
  streamId: string;
  sampleRate?: number; // default 16000
  maxBufferSec?: number; // ring cap, default 120
  analyzeWindowSec?: number; // rolling context sent per final, default 45
}

export interface UtteranceAnalysis {
  speakerCount: number;
  segments: AttributedSegment[];
  pcm: Buffer; // the analyzed window slice (reusable for enrollment)
  windowSec: number;
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

  /**
   * Attribute an utterance to speakers using the TRANSCRIPTION BACKEND's diarization labels
   * (`word.speaker`), and the sidecar only to IDENTIFY each speaker's voice (embed + match — no
   * pyannote). This removes the sidecar's diarization from the hot path (the ~15-25s latency source
   * that caused laggy CC + end-of-meeting store tail-loss). Words with no `speaker` collapse to a
   * single speaker (0), so non-diarizing backends still get a fast single-speaker identify. JIT-16065.
   *
   * Returns speakerCount + per-run segments (in order, each labelled with its speaker's resolved
   * identity) + the whole-utterance PCM (reusable for auto-enrollment). Null when there are no words.
   */
  async analyze(words: Word[], tenant: string): Promise<UtteranceAnalysis | null> {
    if (!words.length) return null;

    // Group consecutive words into runs by backend speaker label.
    interface Run {
      speaker: number;
      words: Word[];
    }
    const runs: Run[] = [];
    for (const w of words) {
      const spk = w.speaker ?? 0;
      const last = runs[runs.length - 1];
      if (last && last.speaker === spk) last.words.push(w);
      else runs.push({ speaker: spk, words: [w] });
    }

    // Identify each distinct speaker from the concatenation of all their runs' audio.
    const runsBySpeaker = new Map<number, Run[]>();
    for (const r of runs) {
      const arr = runsBySpeaker.get(r.speaker) ?? [];
      arr.push(r);
      runsBySpeaker.set(r.speaker, arr);
    }
    const minBytes = this.bytesPerSec * 0.5; // need >= 0.5s of audio to attempt a match
    const idBySpeaker = new Map<number, IdentifyResult>();
    await Promise.all(
      [...runsBySpeaker.entries()].map(async ([spk, spkRuns]) => {
        const slice = this.concatSlices(spkRuns.map((r) => [r.words[0].start, r.words[r.words.length - 1].end] as [number, number]));
        if (!slice || slice.length < minBytes) return;
        const m = await this.sidecar.identify(tenant, slice);
        if (m && m.identity) idBySpeaker.set(spk, m);
      }),
    );

    // Per-run attributed segments, in order, each labelled with its speaker's resolved identity.
    const segments: AttributedSegment[] = runs.map((run) => {
      const m = idBySpeaker.get(run.speaker);
      return {
        sessionSpeakerId: run.speaker,
        handle: null,
        identity: m?.identity ?? null,
        name: m?.name ?? null,
        score: m?.score ?? 0,
        text: run.words.map((w) => w.text).join(' '),
        start: run.words[0].start,
        end: run.words[run.words.length - 1].end,
      };
    });

    const speakerCount = runsBySpeaker.size;
    const pcm = this.sliceSec(words[0].start, words[words.length - 1].end) ?? Buffer.alloc(0);
    return { speakerCount, segments, pcm, windowSec: pcm.length / this.bytesPerSec };
  }

  /**
   * Slice the whole-utterance PCM for a set of words WITHOUT identifying anyone — used on
   * individual (non-diarized) endpoints, which enroll in the background but must NOT run an
   * open-set identify (the owner is already known, and a spurious match would misattribute).
   * Returns null when there are no words or the window is empty. JIT-16065.
   */
  extractWindow(words: Word[]): { pcm: Buffer; windowSec: number } | null {
    if (!words.length) return null;
    const pcm = this.sliceSec(words[0].start, words[words.length - 1].end);
    if (!pcm || pcm.length === 0) return null;
    return { pcm, windowSec: pcm.length / this.bytesPerSec };
  }

  /** Concatenate PCM slices for a set of [startSec, endSec] ranges (one speaker's runs). */
  private concatSlices(ranges: Array<[number, number]>): Buffer | null {
    const parts: Buffer[] = [];
    for (const [s, e] of ranges) {
      const b = this.sliceSec(s, e);
      if (b) parts.push(b);
    }
    return parts.length ? Buffer.concat(parts) : null;
  }
}
