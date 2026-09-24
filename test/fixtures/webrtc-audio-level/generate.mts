/**
 * Regenerate vectors.json: libwebrtc's RFC 6464 level for every frame of the shared corpus
 * (test/helpers/audioLevelCorpus.ts), as computed by the real libwebrtc code via the harness in harness.cc.
 *
 *   npx tsx test/fixtures/webrtc-audio-level/generate.mts <path/to/webrtc_level> <path/to/webrtc/src>
 *
 * The second argument is only used to record which libwebrtc commit produced the vectors.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildAudioLevelCorpus, CORPUS_FRAME_SAMPLES, frameBytes } from '../../helpers/audioLevelCorpus';

const [harness, webrtcSrc] = process.argv.slice(2);
if (!harness || !webrtcSrc) {
	console.error('usage: generate.mts <path/to/webrtc_level> <path/to/webrtc/src>');
	process.exit(2);
}

function webrtcLevels(frames: Int16Array[]): number[] {
	const input = Buffer.concat(frames.map((f) => Buffer.from(frameBytes(f))));
	const out = execFileSync(harness, [String(CORPUS_FRAME_SAMPLES)], { input, maxBuffer: 1 << 26 }).toString();
	const levels = out.trim().split('\n').map(Number);
	if (levels.length !== frames.length) throw new Error(`harness returned ${levels.length} levels for ${frames.length} frames`);
	return levels;
}

const corpus = buildAudioLevelCorpus();
const commit = execFileSync('git', ['-C', webrtcSrc, 'log', '-1', '--format=%H %cs'], { encoding: 'utf8' }).trim();
const vectors = {
	source: 'libwebrtc modules/audio_processing/rms_level.cc (RmsLevel::Analyze per 10 ms, Average per 20 ms packet)',
	webrtcCommit: commit,
	frameSamples: CORPUS_FRAME_SAMPLES,
	levels: {
		sine: webrtcLevels(corpus.sine),
		noise: webrtcLevels(corpus.noise),
		nearSilence: webrtcLevels(corpus.nearSilence),
	},
};
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors.json');
fs.writeFileSync(outFile, JSON.stringify(vectors) + '\n');
console.log(`wrote ${outFile}: ${corpus.sine.length + corpus.noise.length + corpus.nearSilence.length} frames`);
