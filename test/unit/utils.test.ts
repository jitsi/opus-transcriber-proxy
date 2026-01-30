/**
 * Tests for utils module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractSessionParameters, getTurnDetectionConfig } from '../../src/utils';

describe('utils', () => {
	describe('extractSessionParameters', () => {
		it('should extract sessionId from query params', () => {
			const url = 'http://localhost:8080/transcribe?sessionId=test-session-123';

			const params = extractSessionParameters(url);

			expect(params.sessionId).toBe('test-session-123');
		});

		it('should extract connect parameter', () => {
			const url = 'http://localhost:8080/transcribe?connect=ws://example.com/websocket';

			const params = extractSessionParameters(url);

			expect(params.connect).toBe('ws://example.com/websocket');
		});

		it('should parse boolean flags correctly (true)', () => {
			const url =
				'http://localhost:8080/transcribe?useDispatcher=true&sendBack=true&sendBackInterim=true';

			const params = extractSessionParameters(url);

			expect(params.useDispatcher).toBe(true);
			expect(params.sendBack).toBe(true);
			expect(params.sendBackInterim).toBe(true);
		});

		it('should parse boolean flags correctly (false)', () => {
			const url =
				'http://localhost:8080/transcribe?useDispatcher=false&sendBack=false&sendBackInterim=false';

			const params = extractSessionParameters(url);

			expect(params.useDispatcher).toBe(false);
			expect(params.sendBack).toBe(false);
			expect(params.sendBackInterim).toBe(false);
		});

		it('should default boolean flags to false when not specified', () => {
			const url = 'http://localhost:8080/transcribe';

			const params = extractSessionParameters(url);

			expect(params.useDispatcher).toBe(false);
			expect(params.sendBack).toBe(false);
			expect(params.sendBackInterim).toBe(false);
		});

		it('should extract language parameter', () => {
			const url = 'http://localhost:8080/transcribe?lang=en-US';

			const params = extractSessionParameters(url);

			expect(params.language).toBe('en-US');
		});

		it('should extract provider parameter', () => {
			const url = 'http://localhost:8080/transcribe?provider=openai';

			const params = extractSessionParameters(url);

			expect(params.provider).toBe('openai');
		});

		it('should handle null values for optional parameters', () => {
			const url = 'http://localhost:8080/transcribe';

			const params = extractSessionParameters(url);

			expect(params.sessionId).toBeNull();
			expect(params.connect).toBeNull();
			expect(params.language).toBeNull();
			expect(params.provider).toBeNull();
		});

		it('should parse complex URL with multiple parameters', () => {
			const url =
				'http://localhost:8080/transcribe?sessionId=abc123&connect=ws://example.com&useDispatcher=true&sendBack=true&lang=es&provider=deepgram';

			const params = extractSessionParameters(url);

			expect(params.sessionId).toBe('abc123');
			expect(params.connect).toBe('ws://example.com');
			expect(params.useDispatcher).toBe(true);
			expect(params.sendBack).toBe(true);
			expect(params.sendBackInterim).toBe(false);
			expect(params.language).toBe('es');
			expect(params.provider).toBe('deepgram');
		});

		it('should return parsed URL object', () => {
			const url = 'http://localhost:8080/transcribe?sessionId=test';

			const params = extractSessionParameters(url);

			expect(params.url).toBeInstanceOf(URL);
			expect(params.url.hostname).toBe('localhost');
			expect(params.url.port).toBe('8080');
			expect(params.url.pathname).toBe('/transcribe');
		});

		it('should handle URL with port', () => {
			const url = 'http://localhost:3000/transcribe';

			const params = extractSessionParameters(url);

			expect(params.url.port).toBe('3000');
		});

		it('should handle URL without query parameters', () => {
			const url = 'http://localhost:8080/events';

			const params = extractSessionParameters(url);

			expect(params.sessionId).toBeNull();
			expect(params.connect).toBeNull();
		});
	});

	// Note: getTurnDetectionConfig() is a simple wrapper that uses dynamic require()
	// which doesn't work well in tests due to path resolution. Since it's just a pass-through
	// to config.openai.turnDetection, we're testing the config module directly instead.
});
