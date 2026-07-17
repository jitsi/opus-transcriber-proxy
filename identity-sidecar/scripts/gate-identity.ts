import sherpa from 'sherpa-onnx-node';
import { createEmbedder, cosine } from '../src/embedder.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadWav(path: string): Float32Array {
  const wave = (sherpa as any).readWave(path);
  return Float32Array.from(wave.samples as Float32Array);
}

const REC = '../poc-recordings';
const emb = createEmbedder('models/campplus.onnx');

const phil1 = await emb.embed(loadWav(`${REC}/philomena/philomena_1.wav`));
const phil2 = await emb.embed(loadWav(`${REC}/philomena/philomena_2.wav`));
const med1 = await emb.embed(loadWav(`${REC}/medievalist/medievalist_1.wav`));

console.log(`embedding dim: ${emb.dim}`);
const same = cosine(phil1, phil2);
const cross1 = cosine(phil1, med1);
const cross2 = cosine(phil2, med1);
console.log(`SAME  philomena_1 vs philomena_2 : ${same.toFixed(4)}`);
console.log(`CROSS philomena_1 vs medievalist : ${cross1.toFixed(4)}`);
console.log(`CROSS philomena_2 vs medievalist : ${cross2.toFixed(4)}`);
const margin = same - Math.max(cross1, cross2);
console.log(`margin (same - worstCross): ${margin.toFixed(4)}`);
console.log(margin > 0.1 ? 'GATE-ID: PASS' : 'GATE-ID: FAIL');
