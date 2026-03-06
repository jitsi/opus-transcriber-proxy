/**
 * Tests for L16Decoder
 */

import { describe, it, expect } from 'vitest';
import { L16Decoder } from '../../src/L16Decoder';
import { NO_CHUNK_INFO } from '../../src/AudioDecoder';

/** Build a Uint8Array from Int16 samples (little-endian) */
function toBytes(...samples: number[]): Uint8Array {
	const buf = new Uint8Array(samples.length * 2);
	const view = new DataView(buf.buffer);
	samples.forEach((s, i) => view.setInt16(i * 2, s, true));
	return buf;
}

describe('L16Decoder', () => {
	describe('Constructor validation', () => {
		it('should construct with matching sample rates', () => {
			expect(() => new L16Decoder(24000, 24000)).not.toThrow();
		});

		it('should construct with different supported rates (16000 → 24000)', () => {
			expect(() => new L16Decoder(16000, 24000)).not.toThrow();
		});

		it('should construct with all supported rate combinations', () => {
			const rates = [8000, 12000, 16000, 24000, 48000];
			for (const inRate of rates) {
				for (const outRate of rates) {
					expect(() => new L16Decoder(inRate, outRate)).not.toThrow();
				}
			}
		});

		it('should throw for an unsupported input sample rate', () => {
			expect(() => new L16Decoder(44100, 24000))
				.toThrow('Unsupported L16 input sample rate: 44100');
		});

		it('should throw for an unsupported output sample rate', () => {
			expect(() => new L16Decoder(24000, 22050))
				.toThrow('Unsupported L16 output sample rate: 22050');
		});

		it('should throw for zero input sample rate', () => {
			expect(() => new L16Decoder(0, 24000))
				.toThrow('Unsupported L16 input sample rate: 0');
		});
	});

	describe('ready', () => {
		it('should resolve immediately (no async init needed)', async () => {
			const decoder = new L16Decoder(24000, 24000);
			await expect(decoder.ready).resolves.toBeUndefined();
		});
	});

	describe('decodeChunk (no resampling, rates match)', () => {
		it('should return the original frame reference unchanged', () => {
			const decoder = new L16Decoder(24000, 24000);
			const input = toBytes(100, 200, 300, 400);

			const result = decoder.decodeChunk(input, NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result).not.toBeNull();
			expect(result!).toHaveLength(1);
			expect(result![0].audioData).toBe(input); // resamplePCM16 returns original when rates match
		});

		it('should report correct samplesDecoded', () => {
			const decoder = new L16Decoder(24000, 24000);
			const input = toBytes(0, 0, 0, 0, 0, 0); // 6 samples

			const result = decoder.decodeChunk(input, NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result![0].samplesDecoded).toBe(6);
		});

		it('should return kind "normal" with no errors', () => {
			const decoder = new L16Decoder(24000, 24000);
			const result = decoder.decodeChunk(toBytes(1, 2, 3), NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result![0].kind).toBe('normal');
			expect(result![0].errors).toHaveLength(0);
		});
	});

	describe('decodeChunk (with resampling, rates differ)', () => {
		it('should produce upsampled output with correct byte length (16000 → 24000)', () => {
			const decoder = new L16Decoder(16000, 24000);
			const input = toBytes(0, 0, 0, 0); // 4 input samples

			const result = decoder.decodeChunk(input, NO_CHUNK_INFO, NO_CHUNK_INFO);

			// floor(4 * 24000/16000) = 6 output samples
			expect(result).not.toBeNull();
			expect(result![0].audioData.byteLength).toBe(6 * 2);
		});

		it('should report correct samplesDecoded after resampling', () => {
			const decoder = new L16Decoder(16000, 24000);
			const input = toBytes(0, 0, 0, 0); // 4 input samples → 6 output

			const result = decoder.decodeChunk(input, NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result![0].samplesDecoded).toBe(6);
		});

		it('should produce downsampled output (48000 → 24000)', () => {
			const decoder = new L16Decoder(48000, 24000);
			const input = toBytes(0, 0, 0, 0); // 4 input samples

			const result = decoder.decodeChunk(input, NO_CHUNK_INFO, NO_CHUNK_INFO);

			// floor(4 * 24000/48000) = 2 output samples
			expect(result![0].audioData.byteLength).toBe(2 * 2);
			expect(result![0].samplesDecoded).toBe(2);
		});
	});

	describe('chunk-sequence tracking', () => {
		it('should accept sequential chunks', () => {
			const decoder = new L16Decoder(24000, 24000);

			const r1 = decoder.decodeChunk(toBytes(1, 2), 0, 0);
			const r2 = decoder.decodeChunk(toBytes(3, 4), 1, 960);

			expect(r1).not.toBeNull();
			expect(r2).not.toBeNull();
		});

		it('should discard out-of-order packets (returns null)', () => {
			const decoder = new L16Decoder(24000, 24000);

			decoder.decodeChunk(toBytes(1, 2), 5, 0); // establish baseline
			const result = decoder.decodeChunk(toBytes(3, 4), 3, 0); // older chunk

			expect(result).toBeNull();
		});

		it('should discard replayed packets (chunkDelta === 0)', () => {
			const decoder = new L16Decoder(24000, 24000);

			decoder.decodeChunk(toBytes(1, 2), 2, 0);
			const result = decoder.decodeChunk(toBytes(3, 4), 2, 0);

			expect(result).toBeNull();
		});

		it('should skip order tracking when NO_CHUNK_INFO is used', () => {
			const decoder = new L16Decoder(24000, 24000);

			// Two frames with the sentinel — neither should be discarded
			const r1 = decoder.decodeChunk(toBytes(1, 2), NO_CHUNK_INFO, NO_CHUNK_INFO);
			const r2 = decoder.decodeChunk(toBytes(3, 4), NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(r1).not.toBeNull();
			expect(r2).not.toBeNull();
		});

		it('should accept gap-skipping chunks (chunk 0 then chunk 5)', () => {
			const decoder = new L16Decoder(24000, 24000);

			const r1 = decoder.decodeChunk(toBytes(1, 2), 0, 0);
			const r2 = decoder.decodeChunk(toBytes(3, 4), 5, 0); // skipped 1-4

			expect(r1).not.toBeNull();
			expect(r2).not.toBeNull();
		});
	});

	describe('reset', () => {
		it('should clear chunk tracking so lower chunk numbers are accepted after reset', () => {
			const decoder = new L16Decoder(24000, 24000);

			decoder.decodeChunk(toBytes(1, 2), 10, 0);
			decoder.reset();

			const result = decoder.decodeChunk(toBytes(3, 4), 0, 0);
			expect(result).not.toBeNull();
		});
	});

	describe('free', () => {
		it('should not throw', () => {
			const decoder = new L16Decoder(24000, 24000);
			expect(() => decoder.free()).not.toThrow();
		});

		it('should still decode after free (no-op)', () => {
			const decoder = new L16Decoder(24000, 24000);
			decoder.free();
			const result = decoder.decodeChunk(toBytes(1, 2), NO_CHUNK_INFO, NO_CHUNK_INFO);
			expect(result).not.toBeNull();
		});
	});
});
