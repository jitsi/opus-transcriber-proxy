/*
 * Copyright @ 2025 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
		delete process.env.ENABLE_AGENT;
		delete process.env.AGENT_PROVISIONING_URL;
		delete process.env.AGENT_PROVISIONING_ROUTING;
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

	describe('agent provisioning', () => {
		it('keeps an http(s) AGENT_PROVISIONING_URL', async () => {
			process.env.ENABLE_AGENT = 'true';
			process.env.AGENT_PROVISIONING_URL = 'https://signal-api.example/voice-agent';
			const { config, configWarnings } = await import('../../src/config');
			expect(config.agent.provisioningUrl).toBe('https://signal-api.example/voice-agent');
			expect(configWarnings).toEqual([]);
		});

		it('drops an AGENT_PROVISIONING_URL that is not an http(s) URL with a warning while the agent is on, rather than failing to load', async () => {
			for (const bad of ['localhost:5280/voice-agent', 'wss://signal-api.example/voice-agent', 'not a url']) {
				vi.resetModules();
				const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
				process.env.ENABLE_AGENT = 'true';
				process.env.AGENT_PROVISIONING_URL = bad;
				const { config, configWarnings } = await import('../../src/config');
				expect(config.agent.provisioningUrl).toBe('');
				expect(configWarnings).toEqual([expect.stringContaining('AGENT_PROVISIONING_URL')]);
				expect(warn).toHaveBeenCalledWith(configWarnings[0]);
				warn.mockRestore();
			}
		});

		it('leaves AGENT_PROVISIONING_URL unchecked while the agent endpoint is off', async () => {
			process.env.AGENT_PROVISIONING_URL = 'not a url';
			const { config, configWarnings } = await import('../../src/config');
			expect(config.agent.provisioningUrl).toBe('not a url');
			expect(configWarnings).toEqual([]);
		});

		it('falls back to direct routing for an unknown AGENT_PROVISIONING_ROUTING, with a warning', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			process.env.AGENT_PROVISIONING_ROUTING = 'nginx';
			const { config, configWarnings } = await import('../../src/config');
			expect(config.agent.provisioningRouting).toBe('direct');
			expect(configWarnings).toEqual([expect.stringContaining('AGENT_PROVISIONING_ROUTING')]);
			warn.mockRestore();
			vi.resetModules();
			process.env.AGENT_PROVISIONING_ROUTING = 'HAProxy';
			expect((await import('../../src/config')).config.agent.provisioningRouting).toBe('haproxy');
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

		it('should return true for openai_custom when explicitly enabled', async () => {
			vi.stubEnv('ENABLE_OPENAI_CUSTOM_PROVIDER', 'true');

			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('openai_custom')).toBe(true);
		});

		it('should return false for openai_custom when not enabled', async () => {
			const { isProviderAvailable } = await import('../../src/config');

			expect(isProviderAvailable('openai_custom')).toBe(false);
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

		it('should include openai_custom when enabled', async () => {
			vi.stubEnv('ENABLE_OPENAI_CUSTOM_PROVIDER', 'true');

			const { getAvailableProviders } = await import('../../src/config');

			const available = getAvailableProviders();
			expect(available).toContain('openai_custom');
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

	describe('XAI_STT_ENDPOINTS', () => {
		const EU = 'wss://eu-west-1.api.x.ai/v1/stt';

		beforeEach(() => {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
		});

		it('is empty when unset', async () => {
			const { config } = await import('../../src/config');
			expect(config.xai.sttEndpoints.size).toBe(0);
		});

		it('maps names to wss URLs', async () => {
			vi.stubEnv('XAI_STT_ENDPOINTS', JSON.stringify({ eu: EU, 'us-east': 'wss://api.x.ai/v1/stt' }));
			const { config } = await import('../../src/config');
			expect(config.xai.sttEndpoints.get('eu')).toBe(EU);
			expect(config.xai.sttEndpoints.get('us-east')).toBe('wss://api.x.ai/v1/stt');
		});

		it('ignores a value that is not valid JSON or not an object, with a warning', async () => {
			const { parseEndpointMap, configWarnings } = await import('../../src/config');
			expect(parseEndpointMap('XAI_STT_ENDPOINTS', '{bad').size).toBe(0);
			expect(parseEndpointMap('XAI_STT_ENDPOINTS', '[1]').size).toBe(0);
			expect(configWarnings).toEqual(
				expect.arrayContaining([
					'XAI_STT_ENDPOINTS is not valid JSON; ignoring it',
					'XAI_STT_ENDPOINTS must be a JSON object that maps names to wss URLs; ignoring it',
				]),
			);
		});

		it('drops an entry whose URL has credentials, a query or a fragment, and never prints it', async () => {
			// These pass a scheme-only check. The URL is logged when a connection opens, and a query would
			// corrupt the stream URL that XAIBackend builds from it.
			const { parseEndpointMap, configWarnings } = await import('../../src/config');
			const map = parseEndpointMap(
				'XAI_STT_ENDPOINTS',
				JSON.stringify({
					ok: EU,
					userinfo: 'wss://user:hunter2@api.x.ai/v1/stt',
					query: 'wss://api.x.ai/v1/stt?token=hunter2',
					fragment: 'wss://api.x.ai/v1/stt#hunter2',
				}),
			);
			expect([...map.keys()]).toEqual(['ok']);
			const warnings = configWarnings.join('\n');
			for (const name of ['userinfo', 'query', 'fragment']) {
				expect(warnings).toContain(`entry "${name}" is not a wss URL without credentials, query or fragment`);
			}
			expect(warnings).not.toContain('hunter2');
		});

		it('never loads a name that is an inherited property name or __proto__', async () => {
			const { parseEndpointMap } = await import('../../src/config');
			// JSON.parse makes "__proto__" an own key. The name rule drops it, and a Map never reads the prototype.
			const map = parseEndpointMap('XAI_STT_ENDPOINTS', '{"__proto__":"wss://api.x.ai/v1/stt","ok":"wss://api.x.ai/v1/stt"}');
			expect([...map.keys()]).toEqual(['ok']);
			expect(map.get('constructor')).toBeUndefined();
			expect(map.get('__proto__')).toBeUndefined();
		});

		it('drops one bad entry and keeps the others, and never prints a URL in the warning', async () => {
			const { parseEndpointMap, configWarnings } = await import('../../src/config');
			const secretUrl = 'https://user:hunter2@api.x.ai/v1/stt';
			const map = parseEndpointMap(
				'XAI_STT_ENDPOINTS',
				JSON.stringify({ eu: EU, http: secretUrl, 'Bad Name': EU, num: 5 }),
			);
			expect([...map.keys()]).toEqual(['eu']);
			const warnings = configWarnings.join('\n');
			expect(warnings).toContain('entry "http" is not a wss URL');
			expect(warnings).toContain('"Bad Name"');
			expect(warnings).toContain('entry "num" is not a wss URL');
			expect(warnings).not.toContain('hunter2');
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
