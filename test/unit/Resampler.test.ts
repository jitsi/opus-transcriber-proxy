/**
 * Tests for PCM16 resampler
 */

import { describe, it, expect } from 'vitest';
import { resamplePCM16, RESAMPLER_SUPPORTED_SAMPLE_RATES } from '../../src/Resampler';

/** Build a Uint8Array from Int16 samples (little-endian) */
function toBytes(...samples: number[]): Uint8Array {
	const buf = new Uint8Array(samples.length * 2);
	const view = new DataView(buf.buffer);
	samples.forEach((s, i) => view.setInt16(i * 2, s, true));
	return buf;
}

/** Read Int16 samples back from a Uint8Array (little-endian) */
function fromBytes(buf: Uint8Array): number[] {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const samples: number[] = [];
	for (let i = 0; i < buf.byteLength / 2; i++) {
		samples.push(view.getInt16(i * 2, true));
	}
	return samples;
}

describe('RESAMPLER_SUPPORTED_SAMPLE_RATES', () => {
	it('should contain all standard Opus sample rates', () => {
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(8000)).toBe(true);
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(12000)).toBe(true);
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(16000)).toBe(true);
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(24000)).toBe(true);
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(48000)).toBe(true);
	});

	it('should not contain unsupported rates', () => {
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(44100)).toBe(false);
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(22050)).toBe(false);
		expect(RESAMPLER_SUPPORTED_SAMPLE_RATES.has(0)).toBe(false);
	});
});

describe('resamplePCM16', () => {
	describe('identity (rates match)', () => {
		it('should return the original frame reference unchanged', () => {
			const frame = toBytes(100, 200, 300);
			const result = resamplePCM16(frame, 24000, 24000);
			expect(result).toBe(frame);
		});

		it('should return the original frame unchanged for 8000 Hz identity', () => {
			const frame = toBytes(0, 1000, -1000);
			expect(resamplePCM16(frame, 8000, 8000)).toBe(frame);
		});
	});

	describe('output length', () => {
		it('should produce 3x as many samples when upsampling 8000 → 24000', () => {
			// 4 input samples × (24000/8000) = 12 output samples
			const input = toBytes(0, 100, 200, 300);
			const result = resamplePCM16(input, 8000, 24000);
			expect(result.byteLength).toBe(12 * 2);
		});

		it('should produce 1.5x as many samples when upsampling 16000 → 24000', () => {
			// 4 input samples × floor(4 * 24000/16000) = floor(6) = 6 output samples
			const input = toBytes(0, 0, 0, 0);
			const result = resamplePCM16(input, 16000, 24000);
			expect(result.byteLength).toBe(6 * 2);
		});

		it('should produce 0.5x as many samples when downsampling 48000 → 24000', () => {
			// 4 input samples × floor(4 * 24000/48000) = floor(2) = 2 output samples
			const input = toBytes(0, 100, 200, 300);
			const result = resamplePCM16(input, 48000, 24000);
			expect(result.byteLength).toBe(2 * 2);
		});

		it('should return empty output for empty input', () => {
			const result = resamplePCM16(new Uint8Array(0), 8000, 24000);
			expect(result.byteLength).toBe(0);
		});
	});

	describe('interpolation', () => {
		it('should preserve the first sample exactly', () => {
			const input = toBytes(1000, 2000);
			const result = resamplePCM16(input, 8000, 24000);
			const samples = fromBytes(result);
			expect(samples[0]).toBe(1000);
		});

		it('should keep values within the range of input samples', () => {
			const input = toBytes(0, 1000);
			const result = resamplePCM16(input, 8000, 24000);
			const samples = fromBytes(result);
			for (const s of samples) {
				expect(s).toBeGreaterThanOrEqual(0);
				expect(s).toBeLessThanOrEqual(1000);
			}
		});

		it('should produce monotonically non-decreasing output for monotonically increasing input', () => {
			const input = toBytes(0, 500, 1000);
			const result = resamplePCM16(input, 8000, 24000);
			const samples = fromBytes(result);
			for (let i = 1; i < samples.length; i++) {
				expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
			}
		});

		it('should handle negative sample values', () => {
			const input = toBytes(-1000, 0);
			const result = resamplePCM16(input, 8000, 24000);
			const samples = fromBytes(result);
			// All output values should be between -1000 and 0
			for (const s of samples) {
				expect(s).toBeGreaterThanOrEqual(-1000);
				expect(s).toBeLessThanOrEqual(0);
			}
		});
	});

	describe('output buffer', () => {
		it('should return a new Uint8Array with its own buffer (not a view of input)', () => {
			const input = toBytes(100, 200, 300, 400);
			const result = resamplePCM16(input, 8000, 24000);
			expect(result.buffer).not.toBe(input.buffer);
		});

		it('should handle a Uint8Array that is a sub-view of a larger buffer', () => {
			const large = new Uint8Array(20);
			// Write two PCM samples at offset 4
			const view = new DataView(large.buffer);
			view.setInt16(4, 500, true);
			view.setInt16(6, 1000, true);
			const sub = large.subarray(4, 8); // 2 samples

			const result = resamplePCM16(sub, 8000, 24000);
			// 2 input × (24000/8000) = 6 output samples
			expect(result.byteLength).toBe(6 * 2);
			expect(fromBytes(result)[0]).toBe(500);
		});
	});
});
