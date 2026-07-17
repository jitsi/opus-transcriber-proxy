import sherpa from 'sherpa-onnx-node';
import { createDiarizer, speakerCount, type Segment } from '../src/diarizer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadWav(path: string): Float32Array {
  const wave = (sherpa as any).readWave(path);
  return Float32Array.from(wave.samples as Float32Array);
}

const REC = '../poc-recordings';
const solo = loadWav(`${REC}/philomena/philomena_1.wav`);
const multi = loadWav(`${REC}/detect/multi/philomena-historian.wav`);

for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const d = createDiarizer({
    segModel: 'models/segmentation-3.0.onnx',
    embeddingModel: 'models/campplus.onnx',
    clusterThreshold: t,
  });
  const s = await d.analyze(solo);
  const m = await d.analyze(multi);
  console.log(`threshold=${t}  solo=${speakerCount(s)}  multi=${speakerCount(m)}`);
}

// Inspect the solo segments at threshold 0.8 to see if the extra "speaker" is a blip.
const d = createDiarizer({
  segModel: 'models/segmentation-3.0.onnx',
  embeddingModel: 'models/campplus.onnx',
  clusterThreshold: 0.8,
});
const segs: Segment[] = await d.analyze(solo);
console.log('\nsolo segments @0.8:');
for (const s of segs) console.log(`  spk${s.speaker}  ${s.start.toFixed(1)}-${s.end.toFixed(1)}s (${(s.end - s.start).toFixed(1)}s)`);
