import { alignWordsToTurns } from './align';
import type { AnalyzeTurn } from './SidecarClient';

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface AttributedSegment {
  sessionSpeakerId: number | null;
  handle: string | null;
  identity: string | null;
  name: string | null;
  score: number;
  text: string;
  start: number;
  end: number;
}

/**
 * Split an ASR utterance (words with media-time offsets) into per-speaker
 * segments by attributing each word to the max-overlap diarization turn, then
 * grouping runs of consecutive words that share a turn's speaker.
 *
 * A 1-word "island" whose neighbours are the same speaker is re-assigned to that
 * speaker (a median filter over the per-word speaker sequence) — this removes
 * spurious single-word flips at turn boundaries.
 *
 * `words` and `turns` MUST be on the same media timeline (the caller reconciles
 * the stream origin). If `turns` is empty, the whole utterance is returned as a
 * single unattributed segment.
 */
export function attribute(words: Word[], turns: AnalyzeTurn[]): AttributedSegment[] {
  if (words.length === 0) return [];
  const idx = alignWordsToTurns(words, turns);

  // Per-word session-speaker id (null when no turn).
  const spk: (number | null)[] = idx.map((i) => (i >= 0 ? turns[i].sessionSpeakerId : null));

  // Median-filter single-word islands: X Y X -> X X X.
  for (let i = 1; i < spk.length - 1; i++) {
    if (spk[i] !== spk[i - 1] && spk[i - 1] === spk[i + 1]) spk[i] = spk[i - 1];
  }

  // Lookup handle/identity/score by session-speaker id (first turn with that id).
  const bySpeaker = new Map<number, AnalyzeTurn>();
  for (const t of turns) if (!bySpeaker.has(t.sessionSpeakerId)) bySpeaker.set(t.sessionSpeakerId, t);

  const segments: AttributedSegment[] = [];
  let cur: AttributedSegment | null = null;
  let curSpeaker: number | null | undefined;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const speaker = spk[i];
    if (!cur || speaker !== curSpeaker) {
      const turn = speaker !== null ? bySpeaker.get(speaker) : undefined;
      cur = {
        sessionSpeakerId: speaker,
        handle: turn ? turn.handle : null,
        identity: turn ? turn.identity : null,
        name: turn ? (turn.name ?? null) : null,
        score: turn ? turn.score : 0,
        text: w.text,
        start: w.start,
        end: w.end,
      };
      curSpeaker = speaker;
      segments.push(cur);
    } else {
      cur.text += ` ${w.text}`;
      cur.end = w.end;
    }
  }
  return segments;
}
