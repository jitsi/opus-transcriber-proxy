// RFC 6464 audio level of a PCM frame, for the ssrc-audio-level RTP header extension.
//
// Part of the Worker-safe core (see scripts/check-worker-safe.mjs): no Node imports.

/** The RFC 6464 level for digital silence: -127 dBov, the quietest representable value. */
export const AUDIO_LEVEL_SILENCE = 127;

// 0 dBov is a full-scale signal: RMS 32768 for 16-bit PCM. Levels are relative to its power.
const FULL_SCALE_POWER = 32768 * 32768;

/**
 * Compute the RFC 6464 audio level of one frame of signed 16-bit little-endian mono PCM: the RMS of the frame
 * expressed in -dBov, so 0 is full scale and 127 is silence (or anything at or below -127 dBov).
 *
 * The computation is one pass over the samples plus one log10 per frame, on the order of a microsecond for a 20 ms
 * frame -- negligible next to the Opus encode of the same frame, so the encoder backends compute it for every frame
 * (including DTX frames, whose level the consumer never reads) rather than making it opt-in.
 *
 * `pcm` may be a view into a larger buffer; an odd byte offset is handled (via DataView) but is not the fast path.
 */
export function computeAudioLevel(pcm: Uint8Array): number {
	const sampleCount = pcm.byteLength >> 1;
	if (sampleCount === 0) return AUDIO_LEVEL_SILENCE;

	let sumSquares = 0;
	if ((pcm.byteOffset & 1) === 0) {
		const samples = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
		for (let i = 0; i < sampleCount; i++) {
			const s = samples[i];
			sumSquares += s * s;
		}
	} else {
		const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		for (let i = 0; i < sampleCount; i++) {
			const s = view.getInt16(i << 1, true);
			sumSquares += s * s;
		}
	}
	if (sumSquares === 0) return AUDIO_LEVEL_SILENCE;

	// -dBov of the RMS: -20*log10(rms/32768) == -10*log10(meanSquare/32768^2). Clamp to the 7-bit field.
	const level = Math.round(-10 * Math.log10(sumSquares / sampleCount / FULL_SCALE_POWER));
	// `<= 0` also normalises the -0 that rounding a marginally-above-full-scale frame produces.
	return level <= 0 ? 0 : level > AUDIO_LEVEL_SILENCE ? AUDIO_LEVEL_SILENCE : level;
}
