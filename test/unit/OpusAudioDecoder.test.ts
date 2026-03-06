/**
 * Tests for OpusAudioDecoder
 *
 * Tests gap detection, packet-loss concealment, chunk-sequence tracking,
 * and reset/free behaviour in isolation from OutgoingConnection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpusAudioDecoder } from '../../src/OpusDecoder/OpusAudioDecoder';
import { NO_CHUNK_INFO } from '../../src/AudioDecoder';

// Fixed return values used by the mock below
const DECODE_SAMPLES = 480; // 20 ms at 24 kHz
const CONCEAL_SAMPLES = 240; // 10 ms at 24 kHz

let mockDecodeFrame: ReturnType<typeof vi.fn>;
let mockConceal: ReturnType<typeof vi.fn>;
let mockReset: ReturnType<typeof vi.fn>;
let mockFree: ReturnType<typeof vi.fn>;

vi.mock('../../src/OpusDecoder/OpusDecoder', () => {
	class MockOpusDecoder {
		ready = Promise.resolve();
		decodeFrame = mockDecodeFrame;
		conceal = mockConceal;
		reset = mockReset;
		free = mockFree;
	}
	return { OpusDecoder: MockOpusDecoder };
});

function makeDecodeResult(samplesDecoded = DECODE_SAMPLES) {
	return {
		errors: [],
		audioData: new Uint8Array(samplesDecoded * 2),
		samplesDecoded,
		sampleRate: 24000,
		channels: 1,
	};
}

function makeConcealResult(samplesDecoded = CONCEAL_SAMPLES) {
	return {
		errors: [],
		audioData: new Uint8Array(samplesDecoded * 2),
		samplesDecoded,
		sampleRate: 24000,
		channels: 1,
	};
}

const FRAME = new Uint8Array([0x01, 0x02, 0x03]);

describe('OpusAudioDecoder', () => {
	beforeEach(() => {
		mockDecodeFrame = vi.fn(() => makeDecodeResult());
		mockConceal = vi.fn(() => makeConcealResult());
		mockReset = vi.fn();
		mockFree = vi.fn();
	});

	describe('constructor', () => {
		it('should construct with default sample rate 24000', () => {
			expect(() => new OpusAudioDecoder()).not.toThrow();
		});

		it('should construct with all supported sample rates', () => {
			for (const rate of [8000, 12000, 16000, 24000, 48000] as const) {
				expect(() => new OpusAudioDecoder(rate)).not.toThrow();
			}
		});

		it('should throw for an unsupported sample rate', () => {
			expect(() => new OpusAudioDecoder(44100 as any)).toThrow('Unsupported Opus sample rate: 44100');
		});
	});

	describe('ready', () => {
		it('should delegate to the inner decoder ready promise', async () => {
			const decoder = new OpusAudioDecoder();
			await expect(decoder.ready).resolves.toBeUndefined();
		});
	});

	describe('decodeChunk (no gap tracking)', () => {
		it('should return a single normal frame when NO_CHUNK_INFO is used', () => {
			const decoder = new OpusAudioDecoder();
			const result = decoder.decodeChunk(FRAME, NO_CHUNK_INFO, NO_CHUNK_INFO);

			expect(result).not.toBeNull();
			expect(result).toHaveLength(1);
			expect(result![0].kind).toBe('normal');
			expect(mockDecodeFrame).toHaveBeenCalledWith(FRAME);
			expect(mockConceal).not.toHaveBeenCalled();
		});

		it('should return a single normal frame for the first sequenced chunk', () => {
			const decoder = new OpusAudioDecoder();
			const result = decoder.decodeChunk(FRAME, 0, 0);

			expect(result).toHaveLength(1);
			expect(result![0].kind).toBe('normal');
		});
	});

	describe('decodeChunk (out-of-order / replay)', () => {
		it('should return null for an out-of-order chunk', () => {
			const decoder = new OpusAudioDecoder();
			decoder.decodeChunk(FRAME, 5, 0);
			const result = decoder.decodeChunk(FRAME, 3, 0);

			expect(result).toBeNull();
		});

		it('should return null for a replayed chunk (same chunkNo)', () => {
			const decoder = new OpusAudioDecoder();
			decoder.decodeChunk(FRAME, 2, 0);
			const result = decoder.decodeChunk(FRAME, 2, 0);

			expect(result).toBeNull();
		});

		it('should accept gap-skipping chunks (chunk 0 then chunk 5)', () => {
			const decoder = new OpusAudioDecoder();
			decoder.decodeChunk(FRAME, 0, 0);
			const result = decoder.decodeChunk(FRAME, 5, 960 * 5);

			expect(result).not.toBeNull();
		});
	});

	describe('decodeChunk (gap detection and concealment)', () => {
		it('should emit a concealment frame before the normal frame when one packet is lost', () => {
			const decoder = new OpusAudioDecoder();
			decoder.decodeChunk(FRAME, 0, 0);           // baseline
			const result = decoder.decodeChunk(FRAME, 2, 960); // gap of 1

			expect(result).not.toBeNull();
			expect(result).toHaveLength(2);
			expect(result![0].kind).toBe('concealment');
			expect(result![1].kind).toBe('normal');
			expect(mockConceal).toHaveBeenCalledTimes(1);
		});

		it('should not emit concealment on the very first chunk even if chunkNo > 0', () => {
			const decoder = new OpusAudioDecoder();
			// No prior baseline — no concealment possible
			const result = decoder.decodeChunk(FRAME, 5, 0);

			expect(result).toHaveLength(1);
			expect(result![0].kind).toBe('normal');
			expect(mockConceal).not.toHaveBeenCalled();
		});

		it('should pass the arriving frame to conceal (FEC)', () => {
			const decoder = new OpusAudioDecoder();
			decoder.decodeChunk(FRAME, 0, 0);
			decoder.decodeChunk(FRAME, 2, 960); // gap of 1

			expect(mockConceal).toHaveBeenCalledWith(FRAME, expect.any(Number));
		});

		it('should cap concealment at maxConcealmentSamples (120 ms)', () => {
			const decoder = new OpusAudioDecoder(24000);
			const maxSamples = Math.round(0.120 * 24000); // 2880

			decoder.decodeChunk(FRAME, 0, 0);
			// Simulate a huge gap — many lost frames
			decoder.decodeChunk(FRAME, 1000, 0);

			const [concealSamples] = mockConceal.mock.calls[0].slice(1);
			expect(concealSamples).toBeLessThanOrEqual(maxSamples);
		});
	});

	describe('_lastTimestamp update', () => {
		it('should not overwrite _lastTimestamp when timestamp is NO_CHUNK_INFO', () => {
			const decoder = new OpusAudioDecoder();

			// First frame: chunkNo=0, timestamp=480
			decoder.decodeChunk(FRAME, 0, 480);

			// Second frame: chunkNo=1, timestamp=NO_CHUNK_INFO — should NOT update _lastTimestamp
			decoder.decodeChunk(FRAME, 1, NO_CHUNK_INFO);

			// Third frame: chunkNo=3 — gap of 1; concealment samples should be
			// calculated from the original timestamp (480), not from NO_CHUNK_INFO (-1)
			decoder.decodeChunk(FRAME, 3, 480 * 3);

			// Concealment should have been called (gap of 1), and the delta should
			// not be inflated by NO_CHUNK_INFO (-1) being used as the last timestamp
			expect(mockConceal).toHaveBeenCalledTimes(1);
			const concealSamples: number = mockConceal.mock.calls[0][1];
			// If NO_CHUNK_INFO (-1) had been used, delta would be 480*3 - (-1) = 1441,
			// giving a much larger sample count than the correct 480
			expect(concealSamples).toBeLessThanOrEqual(DECODE_SAMPLES);
		});
	});

	describe('reset', () => {
		it('should allow a previously out-of-order chunk to be accepted after reset', () => {
			const decoder = new OpusAudioDecoder();
			decoder.decodeChunk(FRAME, 10, 0);
			decoder.reset();

			const result = decoder.decodeChunk(FRAME, 0, 0);
			expect(result).not.toBeNull();
		});

		it('should suppress concealment after reset (no baseline)', () => {
			const decoder = new OpusAudioDecoder();
			decoder.decodeChunk(FRAME, 0, 0);
			decoder.reset();

			// chunkNo=5 with no prior baseline after reset — no concealment
			const result = decoder.decodeChunk(FRAME, 5, 0);
			expect(result).toHaveLength(1);
			expect(result![0].kind).toBe('normal');
			expect(mockConceal).not.toHaveBeenCalled();
		});
	});

	describe('free', () => {
		it('should delegate to the inner decoder free', () => {
			const decoder = new OpusAudioDecoder();
			decoder.free();
			expect(mockFree).toHaveBeenCalledTimes(1);
		});
	});
});
