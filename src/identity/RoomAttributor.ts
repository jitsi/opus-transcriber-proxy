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
 * `words` and `turns` MUST be on the same media timeline (the caller reconciles
 * the stream origin). If `turns` is empty, the whole utterance is returned as a
 * single unattributed segment.
 */
export function attribute(words: Word[], turns: AnalyzeTurn[]): AttributedSegment[] {
  if (words.length === 0) return [];
  const idx = alignWordsToTurns(words, turns);

  const segments: AttributedSegment[] = [];
  let cur: AttributedSegment | null = null;
  let curSpeaker: number | null = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const turn = idx[i] >= 0 ? turns[idx[i]] : undefined;
    const speaker = turn ? turn.sessionSpeakerId : null;
    if (!cur || speaker !== curSpeaker) {
      cur = {
        sessionSpeakerId: turn ? turn.sessionSpeakerId : null,
        handle: turn ? turn.handle : null,
        identity: turn ? turn.identity : null,
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
