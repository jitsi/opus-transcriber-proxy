/**
 * Tests for config module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dotenv to prevent loading actual .env file
vi.mock('dotenv', () => ({
	default: {
		config: vi.fn(),
	},
}));

describe('config', () => {
	// Save original env vars
	const originalEnv = { ...process.env };

	// Reset modules and env between tests to get fresh config
	beforeEach(async () => {
		vi.resetModules();
		vi.unstubAllEnvs();

		// Clear all env vars related to our config
		delete process.env.OPENAI_API_KEY;
		delete process.env.GEMINI_API_KEY;
		delete process.env.DEEPGRAM_API_KEY;
		delete process.env.ENABLE_DUMMY_PROVIDER;
		delete process.env.BROADCAST_TRANSCRIPTS;
		delete process.env.DEBUG;
		delete process.env.PORT;
		delete process.env.FORCE_COMMIT_TIMEOUT;
		delete process.env.PROVIDERS_PRIORITY;
		delete process.env.OPENAI_MODEL;
		delete process.env.OPENAI_TRANSCRIPTION_PROMPT;
		delete process.env.OPENAI_TURN_DETECTION;
		delete process.env.DEEPGRAM_MODEL;
		delete process.env.DEEPGRAM_LANGUAGE;
		delete process.env.DEEPGRAM_ENCODING;
		delete process.env.DEEPGRAM_PUNCTUATE;
		delete process.env.DEEPGRAM_DIARIZE;
		delete process.env.GEMINI_MODEL;
		delete process.env.GEMINI_TRANSCRIPTION_PROMPT;
	});

	// Restore original env after all tests
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	describe('Environment Variable Parsing', () => {
		it('should parse integer values with defaults', async () => {
			vi.stubEnv('PORT', '3000');
			vi.stubEnv('FORCE_COMMIT_TIMEOUT', '5');

			const { config } = await import('../../src/config');

			expect(config.server.port).toBe(3000);
			expect(config.forceCommitTimeout).toBe(5);
		});

		it('should use defaults for missing integer values', async () => {
			const { config } = await import('../../src/config');

			expect(config.server.port).toBe(8080); // Default
			expect(config.forceCommitTimeout).toBe(2); // Default
		});

		it('should use defaults for invalid integer values', async () => {
			vi.stubEnv('PORT', 'invalid');
			vi.stubEnv('FORCE_COMMIT_TIMEOUT', 'not-a-number');

			const { config } = await import('../../src/config');

			expect(config.server.port).toBe(8080); // Default
			expect(config.forceCommitTimeout).toBe(2); // Default
		});

		it('should parse boolean flags correctly', async () => {
			vi.stubEnv('ENABLE_DUMMY_PROVIDER', 'true');
			vi.stubEnv('BROADCAST_TRANSCRIPTS', 'true');
			vi.stubEnv('DEBUG', 'true');

			const { config } = await import('../../src/config');

			expect(config.enableDummyProvider).toBe(true);
			expect(config.broadcastTranscripts).toBe(true);
			expect(config.debug).toBe(true);
		});

		it('should default boolean flags to false', async () => {
			const { config } = await import('../../src/config');

			expect(config.enableDummyProvider).toBe(false);
			expect(config.broadcastTranscripts).toBe(false);
			expect(config.debug).toBe(false);
		});

		it('should parse JSON objects', async () => {
			const turnDetection = {
				type: 'server_vad',
				threshold: 0.7,
				prefix_padding_ms: 500,
				silence_duration_ms: 500,
			};
			vi.stubEnv('OPENAI_TURN_DETECTION', JSON.stringify(turnDetection));

			const { config } = await import('../../src/config');

			expect(config.openai.turnDetection).toEqual(turnDetection);
		});

		it('should use defaults for invalid JSON', async () => {
			vi.stubEnv('OPENAI_TURN_DETECTION', '{invalid json}');

			const { config } = await import('../../src/config');

			// Should use default value
			expect(config.openai.turnDetection).toEqual({
				type: 'server_vad',
				threshold: 0.5,
				prefix_padding_ms: 300,
				silence_duration_ms: 300,
			});
		});

		it('should parse provider priority list', async () => {
			vi.stubEnv('PROVIDERS_PRIORITY', 'deepgram,gemini,openai');

			const { config } = await import('../../src/config');

			expect(config.providersPriority).toEqual(['deepgram', 'gemini', 'openai']);
		});

		it('should trim whitespace from provider priority list', async () => {
			vi.stubEnv('PROVIDERS_PRIORITY', ' openai , deepgram , gemini ');

			const { config } = await import('../../src/config');

			expect(config.providersPriority).toEqual(['openai', 'deepgram', 'gemini']);
		});
	});

	describe('isProviderAvailable', () => {
		it('should return true for OpenAI when API key is set', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');

			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('openai')).toBe(true);
		});

		it('should return false for OpenAI when API key is missing', async () => {
			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('openai')).toBe(false);
		});

		it('should return true for Gemini when API key is set', async () => {
			vi.stubEnv('GEMINI_API_KEY', 'test-key');

			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('gemini')).toBe(true);
		});

		it('should return false for Gemini when API key is missing', async () => {
			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('gemini')).toBe(false);
		});

		it('should return true for Deepgram when API key is set', async () => {
			vi.stubEnv('DEEPGRAM_API_KEY', 'test-key');

			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('deepgram')).toBe(true);
		});

		it('should return false for Deepgram when API key is missing', async () => {
			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('deepgram')).toBe(false);
		});

		it('should return true for dummy when explicitly enabled', async () => {
			vi.stubEnv('ENABLE_DUMMY_PROVIDER', 'true');

			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('dummy')).toBe(true);
		});

		it('should return false for dummy when not enabled', async () => {
			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('dummy')).toBe(false);
		});
	});

	describe('getAvailableProviders', () => {
		it('should return all providers with API keys', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key-1');
			vi.stubEnv('GEMINI_API_KEY', 'test-key-2');
			vi.stubEnv('DEEPGRAM_API_KEY', 'test-key-3');

			const { getAvailableProviders } = await import('../../src/config');

			const available = getAvailableProviders();
			expect(available).toContain('openai');
			expect(available).toContain('gemini');
			expect(available).toContain('deepgram');
			expect(available).not.toContain('dummy'); // Not enabled
		});

		it('should return empty array when no providers available', async () => {
			const { getAvailableProviders } = await import('../../src/config');

			expect(getAvailableProviders()).toEqual([]);
		});

		it('should include dummy when enabled', async () => {
			vi.stubEnv('ENABLE_DUMMY_PROVIDER', 'true');

			const { getAvailableProviders } = await import('../../src/config');

			const available = getAvailableProviders();
			expect(available).toContain('dummy');
		});
	});

	describe('getDefaultProvider', () => {
		it('should return first available provider from priority list', async () => {
			vi.stubEnv('PROVIDERS_PRIORITY', 'openai,deepgram,gemini');
			vi.stubEnv('OPENAI_API_KEY', 'test-key');

			const { getDefaultProvider } = await import('../../src/config');

			expect(getDefaultProvider()).toBe('openai');
		});

		it('should skip unavailable providers in priority list', async () => {
			vi.stubEnv('PROVIDERS_PRIORITY', 'openai,deepgram,gemini');
			vi.stubEnv('DEEPGRAM_API_KEY', 'test-key'); // Only deepgram available

			const { getDefaultProvider } = await import('../../src/config');

			expect(getDefaultProvider()).toBe('deepgram');
		});

		it('should return null when no providers available', async () => {
			const { getDefaultProvider } = await import('../../src/config');

			expect(getDefaultProvider()).toBeNull();
		});

		it('should respect priority order', async () => {
			vi.stubEnv('PROVIDERS_PRIORITY', 'deepgram,openai,gemini');
			vi.stubEnv('OPENAI_API_KEY', 'test-key-1');
			vi.stubEnv('DEEPGRAM_API_KEY', 'test-key-2');

			const { getDefaultProvider } = await import('../../src/config');

			// Deepgram comes first in priority
			expect(getDefaultProvider()).toBe('deepgram');
		});
	});

	describe('isValidProvider', () => {
		it('should return true for valid providers', async () => {
			const { isValidProvider } = await import('../../src/config');

			expect(isValidProvider('openai')).toBe(true);
			expect(isValidProvider('gemini')).toBe(true);
			expect(isValidProvider('deepgram')).toBe(true);
			expect(isValidProvider('dummy')).toBe(true);
		});

		it('should return false for invalid providers', async () => {
			const { isValidProvider } = await import('../../src/config');

			expect(isValidProvider('invalid')).toBe(false);
			expect(isValidProvider('anthropic')).toBe(false);
			expect(isValidProvider('')).toBe(false);
		});
	});

	describe('Provider Configuration', () => {
		it('should load OpenAI configuration', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
			vi.stubEnv('OPENAI_MODEL', 'gpt-4o-transcribe');
			vi.stubEnv('OPENAI_TRANSCRIPTION_PROMPT', 'Custom prompt');

			const { config } = await import('../../src/config');

			expect(config.openai.apiKey).toBe('test-openai-key');
			expect(config.openai.model).toBe('gpt-4o-transcribe');
			expect(config.openai.transcriptionPrompt).toBe('Custom prompt');
		});

		it('should load Deepgram configuration', async () => {
			vi.stubEnv('DEEPGRAM_API_KEY', 'test-deepgram-key');
			vi.stubEnv('DEEPGRAM_MODEL', 'nova-2-general');
			vi.stubEnv('DEEPGRAM_LANGUAGE', 'en');
			vi.stubEnv('DEEPGRAM_ENCODING', 'opus');
			vi.stubEnv('DEEPGRAM_PUNCTUATE', 'true');
			vi.stubEnv('DEEPGRAM_DIARIZE', 'true');

			const { config } = await import('../../src/config');

			expect(config.deepgram.apiKey).toBe('test-deepgram-key');
			expect(config.deepgram.model).toBe('nova-2-general');
			expect(config.deepgram.language).toBe('en');
			expect(config.deepgram.encoding).toBe('opus');
			expect(config.deepgram.punctuate).toBe(true);
			expect(config.deepgram.diarize).toBe(true);
		});

		it('should load Gemini configuration', async () => {
			vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
			vi.stubEnv('GEMINI_MODEL', 'gemini-2.0');
			vi.stubEnv('GEMINI_TRANSCRIPTION_PROMPT', 'Custom gemini prompt');

			const { config } = await import('../../src/config');

			expect(config.gemini.apiKey).toBe('test-gemini-key');
			expect(config.gemini.model).toBe('gemini-2.0');
			expect(config.gemini.transcriptionPrompt).toBe('Custom gemini prompt');
		});
	});
});
