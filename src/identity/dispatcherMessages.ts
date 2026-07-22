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
 * - Multiple speakers (a room) → one message per speaker segment: resolved speakers
 *   override to their identity; an UNresolved speaker falls back to the mic-owner
 *   endpoint (base.endpointId), never a synthetic `unknown:<handle>` id (which the
 *   dispatcher would turn into a phantom virtual participant). Matches the server.ts
 *   client path and the worker dispatch path. JIT-16065.
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
      return [
        { ...base, endpointId: s.identity, text: s.text, resolvedParticipant: { id: s.identity, name: s.name ?? s.identity } },
      ];
    }
    return [{ ...base, text: originalText }];
  }
  return segments.map((s) => {
    // Unresolved speaker → mic-owner endpoint (no override), so the dispatcher resolves it from KV
    // instead of inventing a phantom participant. Resolved → override to the identity.
    if (!s.identity) return { ...base, text: s.text };
    return { ...base, endpointId: s.identity, text: s.text, resolvedParticipant: { id: s.identity, name: s.name ?? s.identity } };
  });
}
