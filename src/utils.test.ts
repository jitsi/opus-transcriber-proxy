import { describe, it, expect } from 'vitest';
import { extractSessionParameters } from './utils';

describe('extractSessionParameters', () => {
	describe('tag parameter', () => {
		it('should extract a single tag parameter', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&tag=production';
			const params = extractSessionParameters(url);

			expect(params.tags).toEqual(['production']);
		});

		it('should extract multiple tag parameters', () => {
			const url =
				'ws://localhost:8080/transcribe?sessionId=test&tag=production&tag=region-us&tag=customer-service';
			const params = extractSessionParameters(url);

			expect(params.tags).toEqual(['production', 'region-us', 'customer-service']);
		});

		it('should return empty array when no tags are provided', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test';
			const params = extractSessionParameters(url);

			expect(params.tags).toEqual([]);
		});

		it('should handle tags with special characters', () => {
			const url =
				'ws://localhost:8080/transcribe?sessionId=test&tag=env:production&tag=region_us-east-1';
			const params = extractSessionParameters(url);

			expect(params.tags).toEqual(['env:production', 'region_us-east-1']);
		});

		it('should preserve tag order', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&tag=first&tag=second&tag=third';
			const params = extractSessionParameters(url);

			expect(params.tags).toEqual(['first', 'second', 'third']);
		});

		it('should work with other URL parameters', () => {
			const url =
				'ws://localhost:8080/transcribe?sessionId=test&sendBack=true&tag=production&provider=deepgram&tag=region-us';
			const params = extractSessionParameters(url);

			expect(params.sessionId).toBe('test');
			expect(params.sendBack).toBe(true);
			expect(params.provider).toBe('deepgram');
			expect(params.tags).toEqual(['production', 'region-us']);
		});

		it('should handle empty tag values', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&tag=&tag=valid';
			const params = extractSessionParameters(url);

			expect(params.tags).toEqual(['', 'valid']);
		});
	});

	describe('existing parameters', () => {
		it('should extract sessionId', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test123';
			const params = extractSessionParameters(url);

			expect(params.sessionId).toBe('test123');
		});

		it('should extract sendBack as boolean', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&sendBack=true';
			const params = extractSessionParameters(url);

			expect(params.sendBack).toBe(true);
		});

		it('should default sendBack to false', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test';
			const params = extractSessionParameters(url);

			expect(params.sendBack).toBe(false);
		});

		it('should extract sendBackInterim as boolean', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&sendBackInterim=true';
			const params = extractSessionParameters(url);

			expect(params.sendBackInterim).toBe(true);
		});

		it('should extract language', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&lang=en';
			const params = extractSessionParameters(url);

			expect(params.language).toBe('en');
		});

		it('should extract provider', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&provider=deepgram';
			const params = extractSessionParameters(url);

			expect(params.provider).toBe('deepgram');
		});

		it('should default encoding to opus', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test';
			const params = extractSessionParameters(url);

			expect(params.encoding).toBe('opus');
		});

		it('should extract ogg-opus encoding', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&encoding=ogg-opus';
			const params = extractSessionParameters(url);

			expect(params.encoding).toBe('ogg-opus');
		});

		it('should extract useDispatcher as boolean', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test&useDispatcher=true';
			const params = extractSessionParameters(url);

			expect(params.useDispatcher).toBe(true);
		});

		it('should preserve URL object', () => {
			const url = 'ws://localhost:8080/transcribe?sessionId=test';
			const params = extractSessionParameters(url);

			expect(params.url).toBeInstanceOf(URL);
			expect(params.url.toString()).toBe(url);
		});
	});
});
