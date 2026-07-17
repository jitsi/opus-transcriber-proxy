import sherpa from 'sherpa-onnx-node';
import { createDiarizer, speakerCount, countSpeakers } from '../src/diarizer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadWav(path: string): Float32Array {
  const wave = (sherpa as any).readWave(path);
  return Float32Array.from(wave.samples as Float32Array);
}

const REC = '../poc-recordings';
const solo = loadWav(`${REC}/philomena/philomena_1.wav`);
const multi = loadWav(`${REC}/detect/multi/philomena-historian.wav`);

console.log('threshold | solo raw->guarded | multi raw->guarded');
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const d = createDiarizer({
    segModel: 'models/segmentation-3.0.onnx',
    embeddingModel: 'models/campplus.onnx',
    clusterThreshold: t,
  });
  const s = await d.analyze(solo);
  const m = await d.analyze(multi);
  console.log(
    `  ${t}     |   ${speakerCount(s)} -> ${countSpeakers(s)}        |   ${speakerCount(m)} -> ${countSpeakers(m)}`,
  );
}
