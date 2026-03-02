/**
 * Tests for AudioDecoderFactory
 */

import { describe, it, expect, vi } from 'vitest';
import { createAudioDecoder } from '../../src/AudioDecoderFactory';
import { PassThroughDecoder } from '../../src/PassThroughDecoder';
import { L16Decoder } from '../../src/L16Decoder';
import { OpusAudioDecoder } from '../../src/OpusDecoder/OpusAudioDecoder';

// Mock the WASM-backed OpusDecoder so tests don't require a compiled WASM module
vi.mock('../../src/OpusDecoder/OpusDecoder', () => {
	class MockOpusDecoder {
		ready = Promise.resolve();
		decodeFrame = vi.fn(() => ({
			audioData: new Uint8Array(960 * 2),
			samplesDecoded: 960,
			sampleRate: 24000,
			channels: 1,
			errors: [],
		}));
		conceal = vi.fn((frame: Uint8Array | undefined, samples: number) => ({
			audioData: new Uint8Array(samples * 2),
			samplesDecoded: samples,
			sampleRate: 24000,
			channels: 1,
			errors: [],
		}));
		reset = vi.fn();
		free = vi.fn();
	}
	return { OpusDecoder: MockOpusDecoder };
});

describe('createAudioDecoder', () => {
	describe('PassThroughDecoder (matching input and output encoding)', () => {
		it('should return a PassThroughDecoder for opus input and opus output', () => {
			const decoder = createAudioDecoder({ encoding: 'opus' }, { encoding: 'opus' });
			expect(decoder).toBeInstanceOf(PassThroughDecoder);
		});

		it('should return a PassThroughDecoder for ogg input and ogg output', () => {
			const decoder = createAudioDecoder({ encoding: 'ogg' }, { encoding: 'ogg' });
			expect(decoder).toBeInstanceOf(PassThroughDecoder);
		});

		it('should throw when input is L16 and output is opus', () => {
			expect(() => createAudioDecoder({ encoding: 'L16' }, { encoding: 'opus' })).toThrow(
				"Cannot pass through 'L16' input as 'opus' output",
			);
		});

		it('should throw when input is opus and output is ogg', () => {
			expect(() => createAudioDecoder({ encoding: 'opus' }, { encoding: 'ogg' })).toThrow(
				"Cannot pass through 'opus' input as 'ogg' output",
			);
		});
	});

	describe('L16Decoder (PCM input → PCM output)', () => {
		it('should return an L16Decoder for L16 input and L16 output', () => {
			const decoder = createAudioDecoder({ encoding: 'L16' }, { encoding: 'L16' });
			expect(decoder).toBeInstanceOf(L16Decoder);
		});

		it('should default to 24000 Hz when sampleRate is absent', () => {
			// Both rates default to 24000; L16Decoder supports that
			expect(() => createAudioDecoder({ encoding: 'L16' }, { encoding: 'L16' })).not.toThrow();
		});

		it('should respect explicit sampleRate in input and output formats', () => {
			expect(() =>
				createAudioDecoder(
					{ encoding: 'L16', sampleRate: 16000 },
					{ encoding: 'L16', sampleRate: 24000 },
				),
			).not.toThrow();
		});
	});

	describe('ogg input → PCM output (unsupported)', () => {
		it('should throw with a descriptive error', () => {
			expect(() => createAudioDecoder({ encoding: 'ogg' }, { encoding: 'L16' })).toThrow(
				'ogg-opus input cannot be decoded to PCM',
			);
		});

		it('should mention Deepgram with DEEPGRAM_ENCODING=opus as a workaround', () => {
			expect(() => createAudioDecoder({ encoding: 'ogg' }, { encoding: 'L16' })).toThrow(
				'DEEPGRAM_ENCODING=opus',
			);
		});
	});

	describe('Opus input → PCM output', () => {
		it('should return an OpusAudioDecoder for opus input and L16 output', () => {
			const decoder = createAudioDecoder({ encoding: 'opus' }, { encoding: 'L16' });
			expect(decoder).toBeInstanceOf(OpusAudioDecoder);
		});

		it('should default the output sample rate to 24000 Hz when absent', () => {
			expect(() => createAudioDecoder({ encoding: 'opus' }, { encoding: 'L16' })).not.toThrow();
		});

		it('should use the output format sampleRate for the decoder', () => {
			// 16000 is a valid Opus sample rate — should not throw
			expect(() =>
				createAudioDecoder({ encoding: 'opus' }, { encoding: 'L16', sampleRate: 16000 }),
			).not.toThrow();
		});
	});

	describe('unsupported input encoding', () => {
		it('should throw for an unknown input encoding', () => {
			expect(() => createAudioDecoder({ encoding: 'mp3' as any }, { encoding: 'L16' })).toThrow(
				"Unsupported input encoding 'mp3'",
			);
		});

		it('should throw for an empty string encoding', () => {
			expect(() => createAudioDecoder({ encoding: '' as any }, { encoding: 'L16' })).toThrow(
				"Unsupported input encoding ''",
			);
		});
	});
});
