import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { createEmbedder, cosine } from '../src/embedder.js';
import { createDiarizer, countSpeakers } from '../src/diarizer.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { decideMatch } from '../src/matcher.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadWav = (p: string): Float32Array => Float32Array.from((sherpa as any).readWave(p).samples as Float32Array);

const REC = process.argv[2] ?? '../poc-recordings';
const emb = createEmbedder('models/campplus.onnx');
const store = new MemoryStore();
const TENANT = 'harness';

// Speakers = subdirs with per-speaker enrollment clips (exclude the detect/ dir).
const speakers = readdirSync(REC).filter(
  (d) => d !== 'detect' && statSync(join(REC, d)).isDirectory(),
);

// Each speaker dir: *.wav clips excluding *_full.wav. First = enroll, rest = probe.
const clips: Record<string, string[]> = {};
for (const spk of speakers) {
  const files = readdirSync(join(REC, spk))
    .filter((f) => f.endsWith('.wav') && !f.includes('_full'))
    .sort();
  if (files.length) clips[spk] = files.map((f) => join(REC, spk, f));
}

console.log('=== IDENTITY ===');
for (const spk of Object.keys(clips)) {
  await store.upsert(TENANT, spk, await emb.embed(loadWav(clips[spk][0])));
}
const cands = await store.query(TENANT);
let total = 0;
let correct = 0;
const same: number[] = [];
const cross: number[] = [];
for (const spk of Object.keys(clips)) {
  for (const clip of clips[spk].slice(1)) {
    const v = await emb.embed(loadWav(clip));
    for (const c of cands) (c.identity === spk ? same : cross).push(cosine(v, c.vector));
    const { identity, score } = decideMatch(v, cands, 0.5);
    total++;
    if (identity === spk) correct++;
    console.log(`  ${spk}/${clip.split('/').pop()} -> ${identity} (${score.toFixed(3)}) ${identity === spk ? 'OK' : 'WRONG'}`);
  }
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
if (total) console.log(`identity accuracy: ${correct}/${total} = ${((100 * correct) / total).toFixed(1)}%`);
console.log(`same mean=${mean(same).toFixed(3)}  cross mean=${mean(cross).toFixed(3)}  suggested MATCH_THRESHOLD~=${(((mean(same) || 0) + (mean(cross) || 0)) / 2).toFixed(3)}`);

console.log('\n=== DETECTION ===');
const diar = createDiarizer({ segModel: 'models/segmentation-3.0.onnx', embeddingModel: 'models/campplus.onnx' });
// single-speaker probes = each speaker's first clip; multi = detect/multi/*
const singleClips = Object.values(clips).map((c) => c[0]);
for (const c of singleClips) {
  const n = countSpeakers(await diar.analyze(loadWav(c)));
  console.log(`  single ${c.split('/').slice(-2).join('/')} -> ${n} ${n === 1 ? 'OK' : 'WRONG'}`);
}
const multiDir = join(REC, 'detect', 'multi');
if (existsSync(multiDir)) {
  for (const f of readdirSync(multiDir).filter((f) => f.endsWith('.wav'))) {
    const n = countSpeakers(await diar.analyze(loadWav(join(multiDir, f))));
    console.log(`  multi  ${f} -> ${n} ${n >= 2 ? 'OK' : 'WRONG'}`);
  }
}
