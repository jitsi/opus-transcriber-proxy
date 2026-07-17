import sherpa from 'sherpa-onnx-node';
import { createDiarizer, countSpeakers } from '../src/diarizer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadWav(path: string): Float32Array {
  const wave = (sherpa as any).readWave(path);
  return Float32Array.from(wave.samples as Float32Array);
}

const REC = '../poc-recordings';
const diar = createDiarizer({
  segModel: 'models/segmentation-3.0.onnx',
  embeddingModel: 'models/campplus.onnx',
});

const single = await diar.analyze(loadWav(`${REC}/philomena/philomena_1.wav`));
const multi = await diar.analyze(loadWav(`${REC}/detect/multi/philomena-historian.wav`));

const singleN = countSpeakers(single);
const multiN = countSpeakers(multi);
console.log(`SINGLE philomena_1        : ${singleN} speaker(s), ${single.length} segments`);
console.log(`MULTI  philomena-historian: ${multiN} speaker(s), ${multi.length} segments`);
const pass = singleN === 1 && multiN >= 2;
console.log(pass ? 'GATE-DETECT: PASS' : 'GATE-DETECT: FAIL');
