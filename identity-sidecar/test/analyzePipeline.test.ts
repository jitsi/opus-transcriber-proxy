import { describe, it, expect, vi } from 'vitest';
import { AnalyzePipeline, countPeople, type Turn } from '../src/pipeline/AnalyzePipeline.js';
import { SessionRegistry } from '../src/pipeline/SessionRegistry.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import type { Embedder } from '../src/embedder.js';
import type { Diarizer } from '../src/diarizer.js';

// Audio: [0,1)s tagged 1, [1,2)s tagged 2 (via first sample).
const audio = new Float32Array(32000);
for (let i = 0; i < 16000; i++) audio[i] = 1 / 32768;
for (let i = 16000; i < 32000; i++) audio[i] = 2 / 32768;

const fakeEmbedder: Embedder = {
  dim: 3,
  async embed(a: Float32Array): Promise<Float32Array> {
    const tag = Math.round(a[0] * 32768);
    return Float32Array.from(tag === 1 ? [1, 0, 0] : tag === 2 ? [0, 1, 0] : [0, 0, 1]);
  },
};
const fakeDiarizer: Diarizer = {
  async analyze() {
    return [
      { start: 0, end: 1, speaker: 0 },
      { start: 1, end: 2, speaker: 1 },
    ];
  },
};
const guard = { minDurationSec: 0.5, minShare: 0.1 };

function build() {
  const store = new MemoryStore();
  const registry = new SessionRegistry(() => 0, 60_000, 0.5);
  const pipeline = new AnalyzePipeline({ diarizer: fakeDiarizer, embedder: fakeEmbedder, store, registry, matchThreshold: 0.5, guard });
  return { store, registry, pipeline };
}

describe('AnalyzePipeline', () => {
  it('resolves an enrolled speaker and leaves the other with a handle only', async () => {
    const { store, pipeline } = build();
    await store.upsert('t1', 'alice', Float32Array.from([1, 0, 0]));
    const res = await pipeline.analyze('s', 'stream', 't1', audio);
    expect(res.turns).toHaveLength(2);
    expect(res.turns[0].identity).toBe('alice');
    expect(res.turns[1].identity).toBeNull();
    expect(res.turns[1].handle).toMatch(/\w+ \w+/);
    expect(res.speakerCount).toBe(2);
    expect(res.multiple).toBe(true);
  });

  it('keeps sessionSpeakerId stable across chunks and caches resolved identity', async () => {
    const { store, pipeline } = build();
    await store.upsert('t1', 'alice', Float32Array.from([1, 0, 0]));
    const spy = vi.spyOn(store, 'query');
    const r1 = await pipeline.analyze('s', 'stream', 't1', audio);
    const queriesAfter1 = spy.mock.calls.length;
    const r2 = await pipeline.analyze('s', 'stream', 't1', audio);
    // alice's cluster id is stable across chunks
    const alice1 = r1.turns.find((t) => t.identity === 'alice')!.sessionSpeakerId;
    const alice2 = r2.turns.find((t) => t.identity === 'alice')!.sessionSpeakerId;
    expect(alice2).toBe(alice1);
    // second chunk does NOT re-query for the already-resolved alice cluster
    // (only the still-unresolved cluster re-queries), so < queriesAfter1.
    const queriesInChunk2 = spy.mock.calls.length - queriesAfter1;
    expect(queriesInChunk2).toBeLessThan(queriesAfter1);
  });
});

describe('countPeople (identity-regularized)', () => {
  const t = (spk: number, id: string | null, dur = 5): Turn => ({ start: 0, end: dur, sessionSpeakerId: spk, handle: 'h', identity: id, score: id ? 0.9 : 0 });

  it('collapses clusters that share an identity', () => {
    expect(countPeople([t(0, 'alice'), t(1, 'alice')], { minDurationSec: 1, minShare: 0.1 })).toBe(1);
  });

  it('counts distinct identities plus unknown clusters', () => {
    expect(countPeople([t(0, 'alice'), t(1, null)], { minDurationSec: 1, minShare: 0.1 })).toBe(2);
  });

  it('drops clusters that fail the duration guard', () => {
    expect(countPeople([t(0, 'alice', 5), t(1, null, 0.2)], { minDurationSec: 1, minShare: 0.01 })).toBe(1);
  });
});
