import type { Embedder } from '../embedder.js';
import type { Diarizer, SpeakerGuard } from '../diarizer.js';
import type { FingerprintStore } from '../store/FingerprintStore.js';
import { decideMatch } from '../matcher.js';
import { slicePcm } from './slice.js';
import { handleForIndex } from './handles.js';
import { SessionRegistry } from './SessionRegistry.js';

export interface Turn {
  start: number;
  end: number;
  sessionSpeakerId: number;
  handle: string;
  identity: string | null;
  score: number;
}

export interface AnalyzeResult {
  speakerCount: number;
  multiple: boolean;
  turns: Turn[];
}

export interface AnalyzeDeps {
  diarizer: Diarizer;
  embedder: Embedder;
  store: FingerprintStore;
  registry: SessionRegistry;
  matchThreshold: number;
  guard: SpeakerGuard;
}

/**
 * Count distinct *people* in a chunk's turns, applying the min-duration/share
 * guard and then identity-regularizing: clusters that resolved to the SAME
 * enrolled identity are one person; each unresolved cluster that clears the
 * guard counts as one (unknown) person.
 */
export function countPeople(turns: Turn[], guard: SpeakerGuard): number {
  const durBySpeaker = new Map<number, number>();
  const identityBySpeaker = new Map<number, string | null>();
  let total = 0;
  for (const t of turns) {
    const d = t.end - t.start;
    durBySpeaker.set(t.sessionSpeakerId, (durBySpeaker.get(t.sessionSpeakerId) ?? 0) + d);
    identityBySpeaker.set(t.sessionSpeakerId, t.identity);
    total += d;
  }
  const identities = new Set<string>();
  let unknownClusters = 0;
  for (const [spk, dur] of durBySpeaker) {
    if (dur < guard.minDurationSec || (total > 0 && dur / total < guard.minShare)) continue;
    const id = identityBySpeaker.get(spk) ?? null;
    if (id) identities.add(id);
    else unknownClusters++;
  }
  return identities.size + unknownClusters;
}

export class AnalyzePipeline {
  constructor(private deps: AnalyzeDeps) {}

  async analyze(sessionId: string, streamId: string, tenant: string, audio: Float32Array): Promise<AnalyzeResult> {
    const state = this.deps.registry.get(sessionId, streamId);
    const segs = await this.deps.diarizer.analyze(audio);
    const turns: Turn[] = [];

    for (const seg of segs) {
      const slice = slicePcm(audio, seg.start, seg.end);
      if (slice.length === 0) continue;
      const vec = await this.deps.embedder.embed(slice);
      const id = state.clusterer.assign(vec);
      if (!state.handles.has(id)) state.handles.set(id, handleForIndex(id));

      // Resolve identity once per cluster; re-query while still unresolved.
      if (!state.identity.has(id)) {
        const centroid = state.clusterer.getCentroid(id) ?? vec;
        const candidates = await this.deps.store.query(tenant);
        const m = decideMatch(centroid, candidates, this.deps.matchThreshold);
        if (m.identity) state.identity.set(id, { identity: m.identity, score: m.score });
      }
      const resolved = state.identity.get(id);
      turns.push({
        start: seg.start,
        end: seg.end,
        sessionSpeakerId: id,
        handle: state.handles.get(id)!,
        identity: resolved?.identity ?? null,
        score: resolved?.score ?? 0,
      });
    }

    const speakerCount = countPeople(turns, this.deps.guard);
    return { speakerCount, multiple: speakerCount > 1, turns };
  }
}
