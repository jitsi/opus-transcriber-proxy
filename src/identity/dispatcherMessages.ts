import type { DispatcherMessage } from '../dispatcher';
import type { AttributedSegment } from './RoomAttributor';

export interface DispatcherBase {
  sessionId: string;
  endpointId: string; // original participant id / tag
  timestamp: number;
  language?: string;
}

/**
 * Build the dispatcher message(s) for a final, given speaker attribution.
 *
 * - No attribution (feature off-path, analysis failed/timed out, or a single
 *   UNresolved speaker) → one message, no override → the dispatcher resolves the
 *   real endpoint from KV as usual (never clobber a normal participant's identity).
 * - Single speaker resolved to a known identity → one message overriding to it.
 * - Multiple speakers (a room) → one message per speaker segment, each overriding
 *   to the resolved identity, or to the provisional handle for unknown speakers
 *   (so downstream isn't dropped for a speaker with no KV entry).
 */
export function buildDispatcherMessages(
  base: DispatcherBase,
  originalText: string,
  segments: AttributedSegment[] | null,
): DispatcherMessage[] {
  if (!segments || segments.length === 0) {
    return [{ ...base, text: originalText }];
  }
  if (segments.length === 1) {
    const s = segments[0];
    if (s.identity) {
      return [{ ...base, endpointId: s.identity, text: s.text, resolvedParticipant: { id: s.identity, name: s.identity } }];
    }
    return [{ ...base, text: originalText }];
  }
  return segments.map((s) => {
    const id = s.identity ?? `unknown:${s.handle ?? 'speaker'}`;
    const name = s.identity ?? s.handle ?? 'unknown';
    return { ...base, endpointId: id, text: s.text, resolvedParticipant: { id, name } };
  });
}
