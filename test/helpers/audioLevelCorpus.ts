/**
 * Deterministic 480-sample (20 ms at 24 kHz) PCM frames that probe the RFC 6464 level computation: a sine amplitude
 * sweep and a noise sweep in fine dB steps (so every rounding boundary between two levels is exercised) and a
 * near-silence set of sparse 1-3 LSB samples plus the extremes.
 *
 * Shared by the libwebrtc cross-check test (test/unit/audioLevelWebrtc.test.ts) and the script that generates its
 * expected levels from the real libwebrtc code (test/fixtures/webrtc-audio-level/generate.mts), so both see exactly
 * the same frames.
 */

export const CORPUS_FRAME_SAMPLES = 480;
const N = CORPUS_FRAME_SAMPLES;

export interface AudioLevelCorpus {
	sine: Int16Array[];
	noise: Int16Array[];
	nearSilence: Int16Array[];
}

/** 440 Hz sine from full scale down 100 dB, in 0.05 dB steps. */
function sineSweep(): Int16Array[] {
	const frames: Int16Array[] = [];
	for (let step = 0; step <= 2000; step++) {
		const amplitude = 32767 * Math.pow(10, -(step * 0.05) / 20);
		const f = new Int16Array(N);
		for (let i = 0; i < N; i++) f[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 24000));
		frames.push(f);
	}
	return frames;
}

/** Uniform noise from a fixed-seed 32-bit LCG, from full scale down 100 dB, in 0.1 dB steps. */
function noiseSweep(): Int16Array[] {
	let seed = 12345;
	const rand = () => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return seed / 0x80000000 - 1; // [-1, 1)
	};
	const frames: Int16Array[] = [];
	for (let step = 0; step <= 1000; step++) {
		const amplitude = 32767 * Math.pow(10, -(step * 0.1) / 20);
		const f = new Int16Array(N);
		for (let i = 0; i < N; i++) f[i] = Math.max(-32768, Math.min(32767, Math.round(amplitude * rand())));
		frames.push(f);
	}
	return frames;
}

/**
 * k alternating-sign samples of magnitude m (m = 1..3; k = 0, 1, 2, 3, then 4..480 in steps of 4 -- k = 1, m = 1 is
 * the quietest non-silent frame there is), then all -32768 and all 32767.
 */
function nearSilence(): Int16Array[] {
	const ks = [0, 1, 2, 3];
	for (let k = 4; k <= N; k += 4) ks.push(k);
	const frames: Int16Array[] = [];
	for (let m = 1; m <= 3; m++) {
		for (const k of ks) {
			const f = new Int16Array(N);
			for (let i = 0; i < k; i++) f[i] = i % 2 ? m : -m;
			frames.push(f);
		}
	}
	frames.push(new Int16Array(N).fill(-32768));
	frames.push(new Int16Array(N).fill(32767));
	return frames;
}

export function buildAudioLevelCorpus(): AudioLevelCorpus {
	return { sine: sineSweep(), noise: noiseSweep(), nearSilence: nearSilence() };
}

/** A frame's bytes as the little-endian int16 PCM the encoder backends pass to computeAudioLevel. */
export function frameBytes(frame: Int16Array): Uint8Array {
	const bytes = new Uint8Array(frame.length * 2);
	const view = new DataView(bytes.buffer);
	frame.forEach((s, i) => view.setInt16(i * 2, s, true));
	return bytes;
}
