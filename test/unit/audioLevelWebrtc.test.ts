/**
 * Cross-checks computeAudioLevel against libwebrtc's RmsLevel -- the RFC 6464 level Chrome itself sends in the
 * ssrc-audio-level extension -- frame for frame. The expected levels in vectors.json were produced by the real
 * libwebrtc code (modules/audio_processing/rms_level.cc) compiled into test/fixtures/webrtc-audio-level/harness.cc,
 * run over the same deterministic corpus; see generate.mts there to regenerate them.
 */
import { describe, it, expect } from 'vitest';
import { computeAudioLevel } from '../../src/OpusEncoder/audioLevel';
import { buildAudioLevelCorpus, CORPUS_FRAME_SAMPLES, frameBytes } from '../helpers/audioLevelCorpus';
import vectors from '../fixtures/webrtc-audio-level/vectors.json';

const corpus = buildAudioLevelCorpus();

describe('computeAudioLevel matches libwebrtc RmsLevel', () => {
	it('uses the corpus the vectors were generated from', () => {
		expect(vectors.frameSamples).toBe(CORPUS_FRAME_SAMPLES);
		expect(vectors.levels.sine).toHaveLength(corpus.sine.length);
		expect(vectors.levels.noise).toHaveLength(corpus.noise.length);
		expect(vectors.levels.nearSilence).toHaveLength(corpus.nearSilence.length);
	});

	it.each([
		['a sine amplitude sweep in 0.05 dB steps', 'sine'],
		['a noise amplitude sweep in 0.1 dB steps', 'noise'],
		['near-silence and the extremes', 'nearSilence'],
	] as const)('on %s', (_desc, set) => {
		const ours = corpus[set].map((f) => computeAudioLevel(frameBytes(f)));
		expect(ours).toEqual(vectors.levels[set]);
	});

	it('spans the whole range, so the comparison covers every rounding boundary it can reach', () => {
		const all = [...vectors.levels.sine, ...vectors.levels.noise];
		// A 100 dB sweep in sub-dB steps visits every level from full scale to -100 dBov.
		for (let level = 3; level <= 100; level++) expect(all).toContain(level);
		expect(vectors.levels.nearSilence).toContain(127);
		expect(vectors.levels.nearSilence).toContain(117);
	});
});
