/**
 * Tests for the OpusDecoder wrapper.
 *
 * The wrapper now binds to the native libopus addon. We mock the native module
 * (src/OpusDecoder/nativeOpus) so these tests exercise the wrapper logic —
 * sample-rate/channel selection, result shaping, FEC vs PLC dispatch, frame-size
 * capping and error handling — without compiling or loading the real addon.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../src/logger', () => ({
	default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Controllable fake native module. vi.hoisted so the refs exist when vi.mock runs.
const h = vi.hoisted(() => {
	const decode = vi.fn();
	const reset = vi.fn();
	const destroy = vi.fn();
	const ctorCalls: Array<{ sampleRate: number; channels: number }> = [];
	let throwOnConstruct: Error | null = null;

	class FakeNativeDecoder {
		decode = decode;
		reset = reset;
		destroy = destroy;
		constructor(sampleRate: number, channels: number) {
			if (throwOnConstruct) throw throwOnConstruct;
			ctorCalls.push({ sampleRate, channels });
		}
	}

	return {
		decode,
		reset,
		destroy,
		ctorCalls,
		FakeNativeDecoder,
		setThrowOnConstruct: (e: Error | null) => {
			throwOnConstruct = e;
		},
	};
});

vi.mock('../../src/OpusDecoder/nativeOpus', () => ({
	nativeOpus: { OpusDecoder: h.FakeNativeDecoder, OpusEncoder: class {} },
	OPUS_APPLICATION: { voip: 2048, audio: 2049, restricted_lowdelay: 2051 },
}));

import { OpusDecoder } from '../../src/OpusDecoder/OpusDecoder';

/** Build a PCM Buffer representing `samples` mono int16 samples. */
function pcmBuffer(samples: number, channels = 1): Buffer {
	return Buffer.alloc(samples * channels * 2);
}

describe('OpusDecoder (native wrapper)', () => {
	beforeEach(() => {
		h.ctorCalls.length = 0;
		h.setThrowOnConstruct(null);
		// mockReset (vitest config) clears implementations; restore a sane default.
		h.decode.mockReturnValue(pcmBuffer(960, 1)); // 960 mono samples by default
		h.reset.mockReturnValue(undefined);
		h.destroy.mockReturnValue(undefined);
	});

	describe('Constructor and initialization', () => {
		it('defaults to 48kHz / 2 channels', () => {
			new OpusDecoder();
			expect(h.ctorCalls[0]).toEqual({ sampleRate: 48000, channels: 2 });
		});

		it('honors a custom sample rate', () => {
			new OpusDecoder({ sampleRate: 24000 });
			expect(h.ctorCalls[0]).toEqual({ sampleRate: 24000, channels: 2 });
		});

		it('honors custom channels', () => {
			new OpusDecoder({ channels: 1 });
			expect(h.ctorCalls[0]).toEqual({ sampleRate: 48000, channels: 1 });
		});

		it('honors both sample rate and channels', () => {
			new OpusDecoder({ sampleRate: 16000, channels: 1 });
			expect(h.ctorCalls[0]).toEqual({ sampleRate: 16000, channels: 1 });
		});

		it('falls back to 48kHz for an invalid sample rate', () => {
			new OpusDecoder({ sampleRate: 99999 as any });
			expect(h.ctorCalls[0]).toEqual({ sampleRate: 48000, channels: 2 });
		});

		it('throws if native decoder creation fails', () => {
			h.setThrowOnConstruct(new Error('OPUS_BAD_ARG'));
			expect(() => new OpusDecoder()).toThrow('OPUS_BAD_ARG');
		});

		it('exposes a resolved ready promise', async () => {
			const decoder = new OpusDecoder();
			await expect(decoder.ready).resolves.toBeUndefined();
		});
	});

	describe('decodeFrame', () => {
		it('decodes a valid Opus frame', () => {
			h.decode.mockReturnValue(pcmBuffer(960, 1));
			const decoder = new OpusDecoder({ sampleRate: 24000, channels: 1 });

			const result = decoder.decodeFrame(new Uint8Array([1, 2, 3, 4]));

			expect(h.decode).toHaveBeenCalledWith(expect.any(Buffer), expect.any(Number), false);
			expect(result.samplesDecoded).toBe(960);
			expect(result.sampleRate).toBe(24000);
			expect(result.channels).toBe(1);
			expect(result.errors).toHaveLength(0);
			expect(result.audioData).toBeInstanceOf(Uint8Array);
			expect(result.audioData.length).toBe(960 * 2);
		});

		it('reports samplesDecoded scaled by channels', () => {
			h.decode.mockReturnValue(pcmBuffer(480, 2)); // 480 samples * 2ch
			const decoder = new OpusDecoder({ channels: 2 });

			const result = decoder.decodeFrame(new Uint8Array([1, 2]));

			expect(result.samplesDecoded).toBe(480);
			expect(result.audioData.length).toBe(480 * 2 * 2);
		});

		it('captures decode errors thrown by the native layer', () => {
			h.decode.mockImplementation(() => {
				throw new Error('OPUS_INVALID_PACKET: corrupted');
			});
			const decoder = new OpusDecoder();

			const result = decoder.decodeFrame(new Uint8Array([0xff, 0xff]));

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('OPUS_INVALID_PACKET');
			expect(result.samplesDecoded).toBe(0);
			expect(result.audioData.length).toBe(0);
		});

		it('returns an error if the decoder was freed', () => {
			const decoder = new OpusDecoder();
			decoder.free();

			const result = decoder.decodeFrame(new Uint8Array([1, 2]));

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toBe('Decoder freed or not initialized');
			expect(result.samplesDecoded).toBe(0);
		});
	});

	describe('conceal', () => {
		it('performs FEC decode when given the next packet', () => {
			h.decode.mockReturnValue(pcmBuffer(960, 1));
			const decoder = new OpusDecoder({ sampleRate: 48000, channels: 1 });

			const result = decoder.conceal(new Uint8Array([1, 2, 3]), 960);

			// FEC: packet present, fec flag = true.
			expect(h.decode).toHaveBeenCalledWith(expect.any(Buffer), 960, true);
			expect(result.samplesDecoded).toBe(960);
			expect(result.errors).toHaveLength(0);
		});

		it('performs PLC decode without a packet', () => {
			h.decode.mockReturnValue(pcmBuffer(960, 1));
			const decoder = new OpusDecoder({ sampleRate: 48000, channels: 1 });

			decoder.conceal(undefined, 960);

			// PLC: null packet, fec flag = false.
			expect(h.decode).toHaveBeenCalledWith(null, 960, false);
		});

		it('caps the concealment frame size to 120ms at the output rate', () => {
			h.decode.mockReturnValue(pcmBuffer(5760, 1));
			const decoder = new OpusDecoder({ sampleRate: 48000, channels: 1 });

			decoder.conceal(undefined, 999999);

			const frameSizeArg = h.decode.mock.calls[0][1] as number;
			expect(frameSizeArg).toBeLessThanOrEqual(0.12 * 48000); // 5760
		});

		it('captures conceal errors thrown by the native layer', () => {
			h.decode.mockImplementation(() => {
				throw new Error('OPUS_INTERNAL_ERROR');
			});
			const decoder = new OpusDecoder();

			const result = decoder.conceal(undefined, 960);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('OPUS_INTERNAL_ERROR');
			expect(result.samplesDecoded).toBe(0);
		});

		it('returns an error if the decoder was freed', () => {
			const decoder = new OpusDecoder();
			decoder.free();

			const result = decoder.conceal(undefined, 960);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toBe('Decoder freed or not initialized');
		});
	});

	describe('reset', () => {
		it('resets the native decoder state', () => {
			const decoder = new OpusDecoder();
			decoder.reset();
			expect(h.reset).toHaveBeenCalled();
		});

		it('throws if the decoder was freed', () => {
			const decoder = new OpusDecoder();
			decoder.free();
			expect(() => decoder.reset()).toThrow('Decoder freed or not initialized');
		});
	});

	describe('free', () => {
		it('destroys the native decoder', () => {
			const decoder = new OpusDecoder();
			decoder.free();
			expect(h.destroy).toHaveBeenCalledTimes(1);
		});

		it('is safe to call multiple times', () => {
			const decoder = new OpusDecoder();
			decoder.free();
			decoder.free();
			decoder.free();
			expect(h.destroy).toHaveBeenCalledTimes(1);
		});
	});
});
