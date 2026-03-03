/**
 * Tests for AudioFormat validation
 */

import { describe, it, expect } from 'vitest';
import { validateAudioFormat } from '../../src/AudioFormat';

describe('validateAudioFormat', () => {
	describe('non-object inputs', () => {
		it('should throw for null', () => {
			expect(() => validateAudioFormat(null)).toThrow('mediaFormat must be an object');
		});

		it('should throw for a string', () => {
			expect(() => validateAudioFormat('opus')).toThrow('mediaFormat must be an object');
		});

		it('should throw for a number', () => {
			expect(() => validateAudioFormat(42)).toThrow('mediaFormat must be an object');
		});

		it('should throw for undefined', () => {
			expect(() => validateAudioFormat(undefined)).toThrow('mediaFormat must be an object');
		});

		it('should throw for an array', () => {
			expect(() => validateAudioFormat([])).toThrow('mediaFormat.encoding must be a non-empty string');
		});
	});

	describe('encoding validation', () => {
		it('should throw for missing encoding', () => {
			expect(() => validateAudioFormat({})).toThrow('mediaFormat.encoding must be a non-empty string');
		});

		it('should throw for empty string encoding', () => {
			expect(() => validateAudioFormat({ encoding: '' })).toThrow('mediaFormat.encoding must be a non-empty string');
		});

		it('should throw for numeric encoding', () => {
			expect(() => validateAudioFormat({ encoding: 42 })).toThrow('mediaFormat.encoding must be a non-empty string');
		});

		it('should throw for null encoding', () => {
			expect(() => validateAudioFormat({ encoding: null })).toThrow('mediaFormat.encoding must be a non-empty string');
		});

		it('should throw for an unsupported encoding', () => {
			expect(() => validateAudioFormat({ encoding: 'pcm' })).toThrow('mediaFormat.encoding must be one of');
		});

		it('should throw for mp3 encoding', () => {
			expect(() => validateAudioFormat({ encoding: 'mp3' })).toThrow('mediaFormat.encoding must be one of');
		});

		it('should accept encoding "opus"', () => {
			expect(() => validateAudioFormat({ encoding: 'opus' })).not.toThrow();
		});

		it('should accept encoding "ogg-opus"', () => {
			expect(() => validateAudioFormat({ encoding: 'ogg-opus' })).not.toThrow();
		});

		it('should accept encoding "L16"', () => {
			expect(() => validateAudioFormat({ encoding: 'L16' })).not.toThrow();
		});
	});

	describe('channels validation', () => {
		it('should accept absent channels', () => {
			expect(() => validateAudioFormat({ encoding: 'opus' })).not.toThrow();
		});

		it('should throw for float channels', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', channels: 1.5 }))
				.toThrow('mediaFormat.channels must be a positive integer');
		});

		it('should throw for zero channels', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', channels: 0 }))
				.toThrow('mediaFormat.channels must be a positive integer');
		});

		it('should throw for negative channels', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', channels: -1 }))
				.toThrow('mediaFormat.channels must be a positive integer');
		});

		it('should accept channels: 1', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', channels: 1 })).not.toThrow();
		});

		it('should accept channels: 2', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', channels: 2 })).not.toThrow();
		});
	});

	describe('sampleRate validation', () => {
		it('should accept absent sampleRate', () => {
			expect(() => validateAudioFormat({ encoding: 'opus' })).not.toThrow();
		});

		it('should throw for a float sampleRate', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: 16000.5 }))
				.toThrow('mediaFormat.sampleRate must be a positive integer');
		});

		it('should throw for Infinity', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: Infinity }))
				.toThrow('mediaFormat.sampleRate must be a positive integer');
		});

		it('should throw for NaN', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: NaN }))
				.toThrow('mediaFormat.sampleRate must be a positive integer');
		});

		it('should throw for zero sampleRate', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: 0 }))
				.toThrow('mediaFormat.sampleRate must be a positive integer');
		});

		it('should throw for negative sampleRate', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: -16000 }))
				.toThrow('mediaFormat.sampleRate must be a positive integer');
		});

		it('should throw for string sampleRate', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: '16000' as any }))
				.toThrow('mediaFormat.sampleRate must be a positive integer');
		});

		it('should accept sampleRate 8000', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: 8000 })).not.toThrow();
		});

		it('should accept sampleRate 16000', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: 16000 })).not.toThrow();
		});

		it('should accept sampleRate 24000', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: 24000 })).not.toThrow();
		});

		it('should accept sampleRate 48000', () => {
			expect(() => validateAudioFormat({ encoding: 'opus', sampleRate: 48000 })).not.toThrow();
		});
	});

	describe('return value', () => {
		it('should return the same object reference for non-ogg-opus input', () => {
			const input = { encoding: 'opus', sampleRate: 24000, channels: 1 };
			const result = validateAudioFormat(input);
			expect(result).toBe(input);
		});

		it('should preserve all fields in the returned object', () => {
			const input = { encoding: 'L16', sampleRate: 16000, channels: 1 };
			const result = validateAudioFormat(input);
			expect(result.encoding).toBe('L16');
			expect(result.sampleRate).toBe(16000);
			expect(result.channels).toBe(1);
		});

		it('should accept an object with only the required encoding field', () => {
			const result = validateAudioFormat({ encoding: 'opus' });
			expect(result.encoding).toBe('opus');
			expect(result.sampleRate).toBeUndefined();
			expect(result.channels).toBeUndefined();
		});

		it('should normalise ogg-opus encoding to ogg', () => {
			const result = validateAudioFormat({ encoding: 'ogg-opus' });
			expect(result.encoding).toBe('ogg');
		});

		it('should preserve channels and sampleRate when normalising ogg-opus', () => {
			const result = validateAudioFormat({ encoding: 'ogg-opus', channels: 2, sampleRate: 48000 });
			expect(result.encoding).toBe('ogg');
			expect(result.channels).toBe(2);
			expect(result.sampleRate).toBe(48000);
		});
	});
});
