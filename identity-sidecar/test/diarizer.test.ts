import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import sherpa from 'sherpa-onnx-node';
import { createDiarizer, countSpeakers } from '../src/diarizer.js';

const SEG = 'models/segmentation-3.0.onnx';
const EMB = 'models/campplus.onnx';
const REC = '../poc-recordings';
const single = `${REC}/philomena/philomena_1.wav`;
const multi = `${REC}/detect/multi/philomena-historian.wav`;
const ready = [SEG, EMB, single, multi].every((p) => existsSync(p));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadWav = (p: string): Float32Array => Float32Array.from((sherpa as any).readWave(p).samples as Float32Array);

describe.skipIf(!ready)('diarizer (pyannote + guard)', () => {
  const diar = createDiarizer({ segModel: SEG, embeddingModel: EMB });

  it('detection gate: single-speaker clip -> 1 speaker', async () => {
    const n = countSpeakers(await diar.analyze(loadWav(single)));
    console.log(`GATE-DETECT single=${n}`);
    expect(n).toBe(1);
  });

  it('detection gate: two-speaker clip -> >= 2 speakers', async () => {
    const n = countSpeakers(await diar.analyze(loadWav(multi)));
    console.log(`GATE-DETECT multi=${n}`);
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
