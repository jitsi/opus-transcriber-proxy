import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import sherpa from 'sherpa-onnx-node';
import { createEmbedder, cosine } from '../src/embedder.js';

const MODEL = 'models/campplus.onnx';
const REC = '../poc-recordings';
const clips = {
  phil1: `${REC}/philomena/philomena_1.wav`,
  phil2: `${REC}/philomena/philomena_2.wav`,
  med: `${REC}/medievalist/medievalist_1.wav`,
};
const haveModel = existsSync(MODEL);
const haveFixtures = Object.values(clips).every((p) => existsSync(p));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadWav = (p: string): Float32Array => Float32Array.from((sherpa as any).readWave(p).samples as Float32Array);

describe.skipIf(!haveModel)('embedder (CAM++)', () => {
  it('produces a fixed-dim L2-normalized vector', async () => {
    const emb = createEmbedder(MODEL);
    const v = await emb.embed(new Float32Array(16000));
    expect(v.length).toBe(192);
    let sum = 0;
    for (const x of v) sum += x * x;
    expect(Math.sqrt(sum)).toBeCloseTo(1, 3);
  });

  it.skipIf(!haveFixtures)('identity gate: same-speaker cosine > cross-speaker with margin', async () => {
    const emb = createEmbedder(MODEL);
    const a1 = await emb.embed(loadWav(clips.phil1));
    const a2 = await emb.embed(loadWav(clips.phil2));
    const b = await emb.embed(loadWav(clips.med));
    const same = cosine(a1, a2);
    const cross = Math.max(cosine(a1, b), cosine(a2, b));
    console.log(`GATE-ID same=${same.toFixed(3)} cross=${cross.toFixed(3)}`);
    expect(same).toBeGreaterThan(cross);
    expect(same - cross).toBeGreaterThan(0.1);
  });
});
