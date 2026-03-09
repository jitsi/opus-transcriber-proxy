import { describe, it, expect, vi } from 'vitest';
import { CascadedDecoder } from '../../src/CascadedDecoder';
import { NO_CHUNK_INFO } from '../../src/AudioDecoder';
import type { AudioDecoder, DecodedAudio } from '../../src/AudioDecoder';

// ---------------------------------------------------------------------------
// Minimal mock AudioDecoder
// ---------------------------------------------------------------------------

function makeDecoded(data: number[]): DecodedAudio {
	return { audioData: new Uint8Array(data), samplesDecoded: data.length / 2, errors: [], kind: 'normal' };
}

function mockDecoder(opts: {
	decodeChunkFn?: (frame: Uint8Array, chunkNo: number, ts: number) => DecodedAudio[] | null;
	ready?: Promise<void>;
} = {}): AudioDecoder {
	return {
		ready: opts.ready ?? Promise.resolve(),
		decodeChunk: vi.fn(opts.decodeChunkFn ?? (() => [])),
		reset: vi.fn(),
		free: vi.fn(),
	};
}

// ---------------------------------------------------------------------------

describe('CascadedDecoder', () => {
	describe('ready', () => {
		it('resolves when both decoders are ready', async () => {
			const outer = mockDecoder();
			const inner = mockDecoder();
			const cascaded = new CascadedDecoder(outer, inner);
			await expect(cascaded.ready).resolves.toBeUndefined();
		});

		it('waits for both decoders to be ready', async () => {
			let resolveOuter!: () => void;
			let resolveInner!: () => void;
			const outerReady = new Promise<void>((r) => (resolveOuter = r));
			const innerReady = new Promise<void>((r) => (resolveInner = r));
			const outer = mockDecoder({ ready: outerReady });
			const inner = mockDecoder({ ready: innerReady });
			const cascaded = new CascadedDecoder(outer, inner);

			let resolved = false;
			cascaded.ready.then(() => (resolved = true));

			resolveOuter();
			await Promise.resolve();
			expect(resolved).toBe(false);

			resolveInner();
			await cascaded.ready;
			expect(resolved).toBe(true);
		});
	});

	describe('decodeChunk', () => {
		it('returns null when outer returns null', () => {
			const outer = mockDecoder({ decodeChunkFn: () => null });
			const inner = mockDecoder();
			const cascaded = new CascadedDecoder(outer, inner);

			const result = cascaded.decodeChunk(new Uint8Array([1, 2]), 0, 0);
			expect(result).toBeNull();
			expect(inner.decodeChunk).not.toHaveBeenCalled();
		});

		it('returns empty array when outer returns empty array', () => {
			const outer = mockDecoder({ decodeChunkFn: () => [] });
			const inner = mockDecoder({ decodeChunkFn: () => [makeDecoded([1, 2])] });
			const cascaded = new CascadedDecoder(outer, inner);

			const result = cascaded.decodeChunk(new Uint8Array([1, 2]), 0, 0);
			expect(result).toEqual([]);
			expect(inner.decodeChunk).not.toHaveBeenCalled();
		});

		it('feeds each outer frame to the inner decoder', () => {
			const opusFrame1 = new Uint8Array([0xaa, 0x01]);
			const opusFrame2 = new Uint8Array([0xaa, 0x02]);
			const outer = mockDecoder({
				decodeChunkFn: () => [
					{ audioData: opusFrame1, samplesDecoded: 0, errors: [], kind: 'normal' },
					{ audioData: opusFrame2, samplesDecoded: 0, errors: [], kind: 'normal' },
				],
			});
			const pcm1 = makeDecoded([1, 2, 3, 4]);
			const pcm2 = makeDecoded([5, 6, 7, 8]);
			const innerCalls: Uint8Array[] = [];
			const inner = mockDecoder({
				decodeChunkFn: (frame) => {
					innerCalls.push(frame);
					return [innerCalls.length === 1 ? pcm1 : pcm2];
				},
			});
			const cascaded = new CascadedDecoder(outer, inner);

			const result = cascaded.decodeChunk(new Uint8Array([0x99]), 3, 100)!;
			expect(innerCalls[0]).toBe(opusFrame1);
			expect(innerCalls[1]).toBe(opusFrame2);
			expect(result).toHaveLength(2);
			expect(result[0]).toBe(pcm1);
			expect(result[1]).toBe(pcm2);
		});

		it('passes the original chunkNo and timestamp to the outer decoder', () => {
			let capturedChunkNo = -1;
			let capturedTimestamp = -1;
			const outer = mockDecoder({
				decodeChunkFn: (_, chunkNo, ts) => {
					capturedChunkNo = chunkNo;
					capturedTimestamp = ts;
					return [];
				},
			});
			const inner = mockDecoder();
			const cascaded = new CascadedDecoder(outer, inner);

			cascaded.decodeChunk(new Uint8Array([1]), 7, 12345);
			expect(capturedChunkNo).toBe(7);
			expect(capturedTimestamp).toBe(12345);
		});

		it('always passes NO_CHUNK_INFO to the inner decoder', () => {
			const innerArgs: Array<{ chunkNo: number; ts: number }> = [];
			const outer = mockDecoder({
				decodeChunkFn: () => [
					{ audioData: new Uint8Array([1]), samplesDecoded: 0, errors: [], kind: 'normal' },
				],
			});
			const inner = mockDecoder({
				decodeChunkFn: (_, chunkNo, ts) => {
					innerArgs.push({ chunkNo, ts });
					return [];
				},
			});
			const cascaded = new CascadedDecoder(outer, inner);
			cascaded.decodeChunk(new Uint8Array([1]), 5, 99);
			expect(innerArgs[0].chunkNo).toBe(NO_CHUNK_INFO);
			expect(innerArgs[0].ts).toBe(NO_CHUNK_INFO);
		});

		it('skips inner null results (no crash, no output)', () => {
			const outer = mockDecoder({
				decodeChunkFn: () => [
					{ audioData: new Uint8Array([1]), samplesDecoded: 0, errors: [], kind: 'normal' },
				],
			});
			const inner = mockDecoder({ decodeChunkFn: () => null });
			const cascaded = new CascadedDecoder(outer, inner);

			const result = cascaded.decodeChunk(new Uint8Array([1]), 0, 0);
			expect(result).toEqual([]);
		});

		it('flattens multiple inner results from multiple outer frames', () => {
			const outer = mockDecoder({
				decodeChunkFn: () => [
					{ audioData: new Uint8Array([1]), samplesDecoded: 0, errors: [], kind: 'normal' },
					{ audioData: new Uint8Array([2]), samplesDecoded: 0, errors: [], kind: 'normal' },
				],
			});
			const inner = mockDecoder({
				decodeChunkFn: () => [
					makeDecoded([10, 20]),
					makeDecoded([30, 40]),
				],
			});
			const cascaded = new CascadedDecoder(outer, inner);

			const result = cascaded.decodeChunk(new Uint8Array([0]), 0, 0)!;
			// 2 outer frames × 2 inner results each = 4 total
			expect(result).toHaveLength(4);
		});
	});

	describe('reset()', () => {
		it('resets both outer and inner decoders', () => {
			const outer = mockDecoder();
			const inner = mockDecoder();
			const cascaded = new CascadedDecoder(outer, inner);
			cascaded.reset();
			expect(outer.reset).toHaveBeenCalledOnce();
			expect(inner.reset).toHaveBeenCalledOnce();
		});
	});

	describe('free()', () => {
		it('frees both outer and inner decoders', () => {
			const outer = mockDecoder();
			const inner = mockDecoder();
			const cascaded = new CascadedDecoder(outer, inner);
			cascaded.free();
			expect(outer.free).toHaveBeenCalledOnce();
			expect(inner.free).toHaveBeenCalledOnce();
		});
	});
});
