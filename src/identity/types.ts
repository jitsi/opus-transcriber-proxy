// Shared value types for the speaker-identity path. Kept in their own module (rather than in a
// component) so they have no behavioural dependencies and can be imported freely by the attributor,
// the proxy, and the dispatcher-message builders.

/** One transcribed word with media-time offsets and, when the backend diarizes, a speaker label. */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** Backend-provided diarization speaker label (xAI/Deepgram), when available. */
  speaker?: number;
}

/** A per-speaker slice of an utterance, with the resolved identity (or nulls when unresolved). */
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
