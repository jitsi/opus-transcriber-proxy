import { describe, it, expect } from 'vitest';
import { AUDIO_LEVEL_SILENCE, computeAudioLevel } from '../../src/OpusEncoder/audioLevel';

const FRAME_SAMPLES = 480; // 20 ms at 24 kHz

/** One frame of a constant-amplitude square wave (RMS == amplitude), as little-endian int16 PCM. */
function square(amplitude: number, byteOffset = 0): Uint8Array {
	const buf = new Uint8Array(byteOffset + FRAME_SAMPLES * 2);
	const view = new DataView(buf.buffer, byteOffset);
	for (let i = 0; i < FRAME_SAMPLES; i++) view.setInt16(i * 2, i % 2 === 0 ? amplitude : -amplitude, true);
	return new Uint8Array(buf.buffer, byteOffset, FRAME_SAMPLES * 2);
}

describe('computeAudioLevel (RFC 6464 -dBov)', () => {
	it('reports silence as 127', () => {
		expect(computeAudioLevel(new Uint8Array(FRAME_SAMPLES * 2))).toBe(AUDIO_LEVEL_SILENCE);
		expect(computeAudioLevel(new Uint8Array(0))).toBe(AUDIO_LEVEL_SILENCE);
	});

	it('reports a full-scale signal as 0 and clamps above full scale', () => {
		expect(computeAudioLevel(square(32767))).toBe(0);
		// -32768 squared exceeds 32767^2, so the RMS is marginally above full scale: clamps to 0, never negative.
		expect(computeAudioLevel(square(-32768))).toBe(0);
	});

	it('is -20*log10(rms / 32768), rounded', () => {
		expect(computeAudioLevel(square(3277))).toBe(20); // -20 dBov
		expect(computeAudioLevel(square(1036))).toBe(30); // -30 dBov
		expect(computeAudioLevel(square(33))).toBe(60); // -60 dBov
	});

	it('clamps very quiet but non-zero audio to 127', () => {
		// A single LSB in one sample of 480: RMS ~ 0.046 -> ~-117 dBov; still within range, so not clamped...
		const oneLsb = new Uint8Array(FRAME_SAMPLES * 2);
		oneLsb[0] = 1;
		expect(computeAudioLevel(oneLsb)).toBe(117);
		// ...whereas the formula can only exceed 127 for a frame long enough to dilute one LSB further.
		const dilute = new Uint8Array(200000 * 2);
		dilute[0] = 1;
		expect(computeAudioLevel(dilute)).toBe(AUDIO_LEVEL_SILENCE);
	});

	it('handles an odd byte offset into a larger buffer', () => {
		expect(computeAudioLevel(square(3277, 1))).toBe(20);
		expect(computeAudioLevel(square(3277, 2))).toBe(20);
	});
});
