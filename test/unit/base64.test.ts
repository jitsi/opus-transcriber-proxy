/**
 * Round-trip tests for the runtime-neutral base64 module, covering the active implementation
 * (native Uint8Array.toBase64 where available, else the portable atob/btoa path) and the
 * provideBase64 override hook used by the Node runtime for the Buffer fast path.
 */
import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes, provideBase64 } from '../../src/translate/base64';

function randomBytes(n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
	return out;
}

describe('base64', () => {
	it('round-trips empty input', () => {
		expect(bytesToBase64(new Uint8Array(0))).toBe('');
		expect(base64ToBytes('')).toEqual(new Uint8Array(0));
	});

	it('matches Buffer for a known vector', () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
		expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
	});

	it('round-trips random payloads, including one beyond the 0x8000 chunking boundary', () => {
		for (const size of [1, 3, 4, 960, 0x8000, 0x8000 + 1, 3 * 0x8000 + 7]) {
			const bytes = randomBytes(size);
			const b64 = bytesToBase64(bytes);
			expect(b64).toBe(Buffer.from(bytes).toString('base64'));
			expect(base64ToBytes(b64)).toEqual(bytes);
		}
	});

	it('respects a subarray view (non-zero byteOffset)', () => {
		const backing = randomBytes(100);
		const view = backing.subarray(10, 60);
		expect(bytesToBase64(view)).toBe(Buffer.from(view).toString('base64'));
	});

	it('provideBase64 overrides the implementation (the Node runtime injects Buffer-based ones)', () => {
		try {
			provideBase64(
				() => 'OVERRIDDEN',
				() => new Uint8Array([9]),
			);
			expect(bytesToBase64(new Uint8Array([1, 2]))).toBe('OVERRIDDEN');
			expect(base64ToBytes('anything')).toEqual(new Uint8Array([9]));
		} finally {
			// Leave a correct implementation in place for any later test in this file/process.
			provideBase64(
				(bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
				(b64) => {
					const buf = Buffer.from(b64, 'base64');
					return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
				},
			);
		}
	});
});
