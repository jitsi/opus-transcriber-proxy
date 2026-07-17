import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import sherpa from 'sherpa-onnx-node';
import { createEmbedder } from '../src/embedder.js';
import { createDiarizer } from '../src/diarizer.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { SessionRegistry } from '../src/pipeline/SessionRegistry.js';
import { AnalyzePipeline } from '../src/pipeline/AnalyzePipeline.js';

const SEG = 'models/segmentation-3.0.onnx';
const EMB = 'models/campplus.onnx';
const REC = '../poc-recordings';
const phil1 = `${REC}/philomena/philomena_1.wav`;
const phil2 = `${REC}/philomena/philomena_2.wav`;
const historian = `${REC}/detect/multi/philomena-historian.wav`;
const ready = [SEG, EMB, phil1, phil2, historian].every((p) => existsSync(p));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadWav = (p: string): Float32Array => Float32Array.from((sherpa as any).readWave(p).samples as Float32Array);

describe.skipIf(!ready)('integration: analyze pipeline on real audio', () => {
  function pipeline() {
    const store = new MemoryStore();
    const embedder = createEmbedder(EMB);
    const diarizer = createDiarizer({ segModel: SEG, embeddingModel: EMB });
    const registry = new SessionRegistry(() => 0, 300_000, 0.5);
    const p = new AnalyzePipeline({ diarizer, embedder, store, registry, matchThreshold: 0.5, guard: { minDurationSec: 2, minShare: 0.1 } });
    return { store, embedder, p };
  }

  it('resolves enrolled Philomena across two chunks (cross-recording) and stays single-speaker', async () => {
    const { store, embedder, p } = pipeline();
    await store.upsert('t1', 'philomena', await embedder.embed(loadWav(phil1)));

    const a = await p.analyze('sess', 'room', 't1', loadWav(phil1));
    const b = await p.analyze('sess', 'room', 't1', loadWav(phil2));

    expect(a.turns.some((t) => t.identity === 'philomena')).toBe(true);
    expect(b.turns.some((t) => t.identity === 'philomena')).toBe(true);
    expect(a.speakerCount).toBe(1);
    expect(b.speakerCount).toBe(1);
  });

  it('detects two people in the exchange and resolves Philomena among them', async () => {
    const { store, embedder, p } = pipeline();
    await store.upsert('t1', 'philomena', await embedder.embed(loadWav(phil1)));

    const res = await p.analyze('sess2', 'room', 't1', loadWav(historian));
    console.log(`INTEG historian speakerCount=${res.speakerCount} philomenaTurns=${res.turns.filter((t) => t.identity === 'philomena').length}`);
    expect(res.speakerCount).toBe(2);
    expect(res.turns.some((t) => t.identity === 'philomena')).toBe(true);
    expect(res.turns.some((t) => t.identity === null)).toBe(true);
  });
});
