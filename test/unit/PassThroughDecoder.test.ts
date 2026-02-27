/**
 * Tests for PassThroughDecoder
 */

import { describe, it, expect } from 'vitest';
import { PassThroughDecoder } from '../../src/PassThroughDecoder';
import { NO_CHUNK_INFO } from '../../src/AudioDecoder';

describe('PassThroughDecoder', () => {
	describe('Construction and initialization', () => {
		it('should construct and be immediately ready', async () => {
			const decoder = new PassThroughDecoder();

			await expect(decoder.ready).resolves.toBeUndefined();
		});
	});

	describe('decodeChunk', () => {
		it('should pass through data unchanged when no chunk info', () => {
			const decoder = new PassThroughDecoder();
			const inputData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

			const result = decoder.decodeChunk(inputData, NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result).not.toBeNull();
			expect(result!).toHaveLength(1);

			const frame = result![0];
			expect(frame.errors).toHaveLength(0);
			expect(frame.samplesDecoded).toBe(0);

			expect(frame.audioData).toEqual(inputData);
		});

		it('should pass through sequential chunks', () => {
			const decoder = new PassThroughDecoder();
			const frame1 = new Uint8Array([1, 2, 3, 4]);
			const frame2 = new Uint8Array([5, 6, 7, 8]);

			const r1 = decoder.decodeChunk(frame1, 0, 0);
			const r2 = decoder.decodeChunk(frame2, 1, 960);

			expect(r1).not.toBeNull();
			expect(r1!).toHaveLength(1);
			expect(r2).not.toBeNull();
			expect(r2!).toHaveLength(1);
		});

		it('should discard out-of-order packets (null return)', () => {
			const decoder = new PassThroughDecoder();

			// Establish baseline
			decoder.decodeChunk(new Uint8Array([1, 2, 3, 4]), 5, 0);

			// Out-of-order packet
			const result = decoder.decodeChunk(new Uint8Array([5, 6, 7, 8]), 3, 0);
			expect(result).toBeNull();
		});

		it('should discard replayed packets (chunkDelta === 0)', () => {
			const decoder = new PassThroughDecoder();

			decoder.decodeChunk(new Uint8Array([1, 2]), 2, 0);

			const result = decoder.decodeChunk(new Uint8Array([3, 4]), 2, 0);
			expect(result).toBeNull();
		});

		it('should handle empty frames', () => {
			const decoder = new PassThroughDecoder();

			const result = decoder.decodeChunk(new Uint8Array([]), NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result).not.toBeNull();
			expect(result!).toHaveLength(1);
			expect(result![0].errors).toHaveLength(0);
			expect(result![0].samplesDecoded).toBe(0);
			expect(result![0].audioData.length).toBe(0);
		});

		it('should handle large frames', () => {
			const decoder = new PassThroughDecoder();
			const inputData = new Uint8Array(1024);
			for (let i = 0; i < inputData.length; i++) inputData[i] = i % 256;

			const result = decoder.decodeChunk(inputData, NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result).not.toBeNull();
			const frame = result![0];
			expect(frame.errors).toHaveLength(0);
			expect(frame.samplesDecoded).toBe(0);

			expect(frame.audioData).toEqual(inputData);
		});

		it('should skip chunk tracking when NO_CHUNK_INFO is passed', () => {
			const decoder = new PassThroughDecoder();

			// Two frames with same "no info" sentinel — should never discard
			const r1 = decoder.decodeChunk(new Uint8Array([1, 2]), NO_CHUNK_INFO, NO_CHUNK_INFO);
			const r2 = decoder.decodeChunk(new Uint8Array([3, 4]), NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(r1).not.toBeNull();
			expect(r2).not.toBeNull();
		});
	});

	describe('reset', () => {
		it('should clear chunk tracking so next frame is accepted', () => {
			const decoder = new PassThroughDecoder();

			decoder.decodeChunk(new Uint8Array([1, 2]), 10, 0);
			decoder.reset();

			// After reset, a lower chunk number is accepted (no prior baseline)
			const result = decoder.decodeChunk(new Uint8Array([3, 4]), 0, 0);
			expect(result).not.toBeNull();
		});
	});

	describe('free', () => {
		it('should free without errors', () => {
			const decoder = new PassThroughDecoder();
			expect(() => decoder.free()).not.toThrow();
		});

		it('should still work after free (no-op)', () => {
			const decoder = new PassThroughDecoder();
			decoder.free();

			const result = decoder.decodeChunk(new Uint8Array([1, 2, 3, 4]), NO_CHUNK_INFO, NO_CHUNK_INFO);
			expect(result).not.toBeNull();
			expect(result![0].errors).toHaveLength(0);
			expect(result![0].samplesDecoded).toBe(0);
		});
	});
});
