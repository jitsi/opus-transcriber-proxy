/**
 * Tests for OpusDecoder module
 *
 * Note: We mock the WASM module and focus on testing the wrapper logic,
 * not the actual Opus decoding implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpusDecoder } from '../../src/OpusDecoder/OpusDecoder';
import type { OpusDecodedAudio } from '../../src/OpusDecoder/OpusDecoder';

// Mock logger
vi.mock('../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock fs and path for WASM loading
// Create a minimal valid WASM module: magic number + version
vi.mock('fs', () => ({
	default: {
		readFileSync: vi.fn(() => {
			// WASM magic number: 0x00 0x61 0x73 0x6d (asm)
			// Version: 0x01 0x00 0x00 0x00
			return new Uint8Array([
				0x00, 0x61, 0x73, 0x6d, // magic number "\0asm"
				0x01, 0x00, 0x00, 0x00, // version 1
			]);
		}),
	},
}));

vi.mock('path', () => ({
	default: {
		dirname: vi.fn(() => '/mock/dir'),
		join: vi.fn(() => '/mock/opus-decoder.wasm'),
	},
}));

// Mock the opus decoder module
vi.mock('../../dist/opus-decoder.cjs', () => ({
	default: vi.fn((options: any) => {
		// Call instantiateWasm if provided
		if (options.instantiateWasm) {
			const mockExports = {
				_opus_frame_decoder_create: () => 1,
				_opus_frame_decoder_destroy: () => {},
				_opus_frame_decoder_reset: () => {},
				_opus_frame_decode: () => 960,
				_malloc: () => 1000,
				_free: () => {},
				wasmMemory: { buffer: new ArrayBuffer(1024) },
			};

			const mockInstance = { exports: mockExports };
			options.instantiateWasm({}, (instance: any) => {});
			return Promise.resolve(mockExports);
		}
		return Promise.resolve({});
	}),
}));

// Create a mock WASM instance
const createMockWasmInstance = (options: {
	createReturns?: number;
	decodeReturns?: number;
	decodeCallback?: (decoder: number, inputPtr: number, inputLength: number, outputPtr: number, frameSize: number, enableFec: number) => number;
} = {}) => {
	const heap = new ArrayBuffer(1024 * 1024); // 1MB mock heap
	const allocations = new Map<number, number>();
	let nextPtr = 1000;

	return {
		opus_frame_decoder_create: vi.fn((sampleRate: number, channels: number) => {
			return options.createReturns !== undefined ? options.createReturns : 1; // Success: return pointer
		}),
		opus_frame_decoder_destroy: vi.fn(),
		opus_frame_decoder_reset: vi.fn(),
		opus_frame_decode: vi.fn((decoder: number, inputPtr: number, inputLength: number, outputPtr: number, frameSize: number, enableFec: number) => {
			if (options.decodeCallback) {
				return options.decodeCallback(decoder, inputPtr, inputLength, outputPtr, frameSize, enableFec);
			}
			// Default: return number of samples decoded (simulate 20ms at 48kHz = 960 samples)
			return options.decodeReturns !== undefined ? options.decodeReturns : 960;
		}),
		malloc: vi.fn((size: number) => {
			const ptr = nextPtr;
			nextPtr += size;
			allocations.set(ptr, size);
			return ptr;
		}),
		free: vi.fn((ptr: number) => {
			allocations.delete(ptr);
		}),
		HEAP: heap,
		module: {},
	};
};

describe('OpusDecoder', () => {
	let mockWasmInstance: ReturnType<typeof createMockWasmInstance>;

	beforeEach(() => {
		vi.clearAllMocks();

		// Create default mock WASM instance
		mockWasmInstance = createMockWasmInstance();

		// Mock the static opusModule promise
		(OpusDecoder as any).opusModule = Promise.resolve(mockWasmInstance);
	});

	describe('Constructor and initialization', () => {
		it('should initialize with default values', async () => {
			const decoder = new OpusDecoder();

			await decoder.ready;

			// Default: 48kHz, 2 channels
			expect(mockWasmInstance.opus_frame_decoder_create).toHaveBeenCalledWith(48000, 2);
		});

		it('should initialize with custom sample rate', async () => {
			const decoder = new OpusDecoder({ sampleRate: 24000 });

			await decoder.ready;

			expect(mockWasmInstance.opus_frame_decoder_create).toHaveBeenCalledWith(24000, 2);
		});

		it('should initialize with custom channels', async () => {
			const decoder = new OpusDecoder({ channels: 1 });

			await decoder.ready;

			expect(mockWasmInstance.opus_frame_decoder_create).toHaveBeenCalledWith(48000, 1);
		});

		it('should initialize with both custom sample rate and channels', async () => {
			const decoder = new OpusDecoder({ sampleRate: 16000, channels: 1 });

			await decoder.ready;

			expect(mockWasmInstance.opus_frame_decoder_create).toHaveBeenCalledWith(16000, 1);
		});

		it('should default to 48kHz for invalid sample rate', async () => {
			const decoder = new OpusDecoder({ sampleRate: 99999 as any });

			await decoder.ready;

			expect(mockWasmInstance.opus_frame_decoder_create).toHaveBeenCalledWith(48000, 2);
		});

		it('should throw error if decoder creation fails', async () => {
			// Mock decoder creation to return error code
			mockWasmInstance = createMockWasmInstance({ createReturns: -1 }); // OPUS_BAD_ARG
			(OpusDecoder as any).opusModule = Promise.resolve(mockWasmInstance);

			const decoder = new OpusDecoder();

			await expect(decoder.ready).rejects.toThrow('libopus opus_decoder_create failed');
		});

		it('should allocate memory for input and output buffers', async () => {
			const decoder = new OpusDecoder();

			await decoder.ready;

			// Should call malloc at least twice (input and output buffers)
			expect(mockWasmInstance.malloc.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('decodeFrame', () => {
		it('should decode valid Opus frame', async () => {
			const decoder = new OpusDecoder({ sampleRate: 24000, channels: 1 });
			await decoder.ready;

			const opusFrame = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
			const result = decoder.decodeFrame(opusFrame);

			expect(mockWasmInstance.opus_frame_decode).toHaveBeenCalled();
			expect(result.samplesDecoded).toBe(960);
			expect(result.sampleRate).toBe(24000);
			expect(result.channels).toBe(1);
			expect(result.errors).toHaveLength(0);
			expect(result.pcmData).toBeInstanceOf(Int16Array);
		});

		it('should handle decode errors', async () => {
			// Mock decoder to return error
			mockWasmInstance = createMockWasmInstance({ decodeReturns: -4 }); // OPUS_INVALID_PACKET
			(OpusDecoder as any).opusModule = Promise.resolve(mockWasmInstance);

			const decoder = new OpusDecoder();
			await decoder.ready;

			const opusFrame = new Uint8Array([0xFF, 0xFF]);
			const result = decoder.decodeFrame(opusFrame);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('OPUS_INVALID_PACKET');
			expect(result.samplesDecoded).toBe(0);
		});

		it('should return error if decoder not initialized', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			// Free the decoder
			decoder.free();

			const opusFrame = new Uint8Array([0x01, 0x02]);
			const result = decoder.decodeFrame(opusFrame);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toBe('Decoder freed or not initialized');
			expect(result.samplesDecoded).toBe(0);
		});

		it('should track frame statistics', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			// Decode multiple frames
			const frame1 = new Uint8Array([0x01, 0x02]);
			const frame2 = new Uint8Array([0x03, 0x04, 0x05]);

			decoder.decodeFrame(frame1);
			decoder.decodeFrame(frame2);

			// Frame numbers should increment
			expect(mockWasmInstance.opus_frame_decode).toHaveBeenCalledTimes(2);
		});

		it('should return PCM data with correct length', async () => {
			// Mock to return specific sample count
			mockWasmInstance = createMockWasmInstance({ decodeReturns: 480 }); // 10ms at 48kHz
			(OpusDecoder as any).opusModule = Promise.resolve(mockWasmInstance);

			const decoder = new OpusDecoder({ channels: 2 });
			await decoder.ready;

			const opusFrame = new Uint8Array([0x01, 0x02]);
			const result = decoder.decodeFrame(opusFrame);

			// PCM data length should be samplesDecoded * channels
			expect(result.pcmData.length).toBe(480 * 2);
		});
	});

	describe('conceal', () => {
		it('should perform FEC with next packet', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			const nextPacket = new Uint8Array([0x01, 0x02, 0x03]);
			const result = decoder.conceal(nextPacket, 960);

			// Should call decode with FEC enabled (last parameter = 1)
			expect(mockWasmInstance.opus_frame_decode).toHaveBeenCalledWith(
				expect.any(Number), // decoder pointer
				expect.any(Number), // input ptr
				3, // input length
				expect.any(Number), // output ptr
				960, // frame size
				1, // enableFec = 1 for FEC
			);

			expect(result.samplesDecoded).toBe(960);
			expect(result.errors).toHaveLength(0);
		});

		it('should perform PLC without next packet', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			const result = decoder.conceal(undefined, 960);

			// Should call decode with null input for PLC
			expect(mockWasmInstance.opus_frame_decode).toHaveBeenCalledWith(
				expect.any(Number), // decoder pointer
				0, // input ptr = 0 for PLC
				0, // input length = 0
				expect.any(Number), // output ptr
				960, // frame size
				0, // enableFec = 0 for PLC
			);

			expect(result.samplesDecoded).toBe(960);
		});

		it('should limit samples to conceal to output buffer size', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			// Request more samples than buffer can hold
			const result = decoder.conceal(undefined, 999999);

			// Should be capped to _outputChannelSize (120 * 48 = 5760)
			const callArgs = mockWasmInstance.opus_frame_decode.mock.calls[0];
			expect(callArgs[4]).toBeLessThanOrEqual(5760);
		});

		it('should handle conceal errors', async () => {
			mockWasmInstance = createMockWasmInstance({ decodeReturns: -3 }); // OPUS_INTERNAL_ERROR
			(OpusDecoder as any).opusModule = Promise.resolve(mockWasmInstance);

			const decoder = new OpusDecoder();
			await decoder.ready;

			const result = decoder.conceal(undefined, 960);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('OPUS_INTERNAL_ERROR');
			expect(result.samplesDecoded).toBe(0);
		});

		it('should return error if decoder not initialized', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			decoder.free();

			const result = decoder.conceal(undefined, 960);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toBe('Decoder freed or not initialized');
		});
	});

	describe('reset', () => {
		it('should reset decoder state', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			decoder.reset();

			expect(mockWasmInstance.opus_frame_decoder_reset).toHaveBeenCalled();
		});

		it('should throw error if decoder not initialized', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			decoder.free();

			expect(() => decoder.reset()).toThrow('Decoder freed or not initialized');
		});
	});

	describe('free', () => {
		it('should free all allocated memory', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			const mallocCallCount = mockWasmInstance.malloc.mock.calls.length;

			decoder.free();

			// Should free all allocated pointers
			expect(mockWasmInstance.free.mock.calls.length).toBeGreaterThanOrEqual(mallocCallCount);
		});

		it('should destroy decoder instance', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			decoder.free();

			expect(mockWasmInstance.opus_frame_decoder_destroy).toHaveBeenCalled();
		});

		it('should be safe to call multiple times', async () => {
			const decoder = new OpusDecoder();
			await decoder.ready;

			decoder.free();
			decoder.free();
			decoder.free();

			// Should not throw
		});
	});

	describe('ready promise', () => {
		it('should resolve when initialization completes', async () => {
			const decoder = new OpusDecoder();

			await expect(decoder.ready).resolves.toBeUndefined();
		});

		it('should reject if WASM module fails to load', async () => {
			// Mock WASM module to reject
			(OpusDecoder as any).opusModule = Promise.reject(new Error('WASM load failed'));

			const decoder = new OpusDecoder();

			await expect(decoder.ready).rejects.toThrow('WASM load failed');
		});
	});
});
