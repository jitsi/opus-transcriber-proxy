/**
 * Tests for BackendFactory module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all backend implementations
vi.mock('../../../src/backends/OpenAIBackend', () => ({
	OpenAIBackend: vi.fn().mockImplementation((tag, participantInfo) => ({
		tag,
		participantInfo,
		type: 'OpenAIBackend',
	})),
}));

vi.mock('../../../src/backends/GeminiBackend', () => ({
	GeminiBackend: vi.fn().mockImplementation((tag, participantInfo) => ({
		tag,
		participantInfo,
		type: 'GeminiBackend',
	})),
}));

vi.mock('../../../src/backends/DeepgramBackend', () => ({
	DeepgramBackend: vi.fn().mockImplementation((tag, participantInfo) => ({
		tag,
		participantInfo,
		type: 'DeepgramBackend',
	})),
}));

vi.mock('../../../src/backends/DummyBackend', () => ({
	DummyBackend: vi.fn().mockImplementation((tag, participantInfo) => ({
		tag,
		participantInfo,
		type: 'DummyBackend',
	})),
}));

// Mock logger
vi.mock('../../../src/logger', () => ({
	default: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock dotenv
vi.mock('dotenv', () => ({
	default: {
		config: vi.fn(),
	},
}));

describe('BackendFactory', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();

		// Clear config-related env vars
		delete process.env.OPENAI_API_KEY;
		delete process.env.GEMINI_API_KEY;
		delete process.env.DEEPGRAM_API_KEY;
		delete process.env.ENABLE_DUMMY_PROVIDER;
		delete process.env.OPENAI_MODEL;
		delete process.env.OPENAI_TRANSCRIPTION_PROMPT;
		delete process.env.GEMINI_MODEL;
		delete process.env.GEMINI_TRANSCRIPTION_PROMPT;
		delete process.env.DEEPGRAM_MODEL;
	});

	describe('createBackend', () => {
		it('should create OpenAIBackend when provider is openai', async () => {
			const { createBackend } = await import('../../../src/backends/BackendFactory');
			const { OpenAIBackend } = await import('../../../src/backends/OpenAIBackend');

			const backend = createBackend('test-tag', { id: 'participant-1' }, 'openai');

			expect(OpenAIBackend).toHaveBeenCalledWith('test-tag', { id: 'participant-1' });
			expect(backend).toBeDefined();
		});

		it('should create GeminiBackend when provider is gemini', async () => {
			const { createBackend } = await import('../../../src/backends/BackendFactory');
			const { GeminiBackend } = await import('../../../src/backends/GeminiBackend');

			const backend = createBackend('test-tag', { id: 'participant-2' }, 'gemini');

			expect(GeminiBackend).toHaveBeenCalledWith('test-tag', { id: 'participant-2' });
			expect(backend).toBeDefined();
		});

		it('should create DeepgramBackend when provider is deepgram', async () => {
			const { createBackend } = await import('../../../src/backends/BackendFactory');
			const { DeepgramBackend } = await import('../../../src/backends/DeepgramBackend');

			const backend = createBackend('test-tag', { id: 'participant-3' }, 'deepgram');

			expect(DeepgramBackend).toHaveBeenCalledWith('test-tag', { id: 'participant-3' });
			expect(backend).toBeDefined();
		});

		it('should create DummyBackend when provider is dummy', async () => {
			const { createBackend } = await import('../../../src/backends/BackendFactory');
			const { DummyBackend } = await import('../../../src/backends/DummyBackend');

			const backend = createBackend('test-tag', { id: 'participant-4' }, 'dummy');

			expect(DummyBackend).toHaveBeenCalledWith('test-tag', { id: 'participant-4' });
			expect(backend).toBeDefined();
		});

		it('should use default provider when none specified', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');

			const { createBackend } = await import('../../../src/backends/BackendFactory');
			const { OpenAIBackend } = await import('../../../src/backends/OpenAIBackend');

			const backend = createBackend('test-tag', { id: 'participant-5' });

			// Should use OpenAI as it's first in default priority and has API key
			expect(OpenAIBackend).toHaveBeenCalled();
			expect(backend).toBeDefined();
		});

		it('should throw error for unknown provider', async () => {
			const { createBackend } = await import('../../../src/backends/BackendFactory');

			expect(() => {
				createBackend('test-tag', { id: 'participant-6' }, 'unknown' as any);
			}).toThrow('Unknown transcription backend: unknown');
		});

		it('should throw error when no provider available', async () => {
			// No API keys set
			const { createBackend } = await import('../../../src/backends/BackendFactory');

			expect(() => {
				createBackend('test-tag', { id: 'participant-7' });
			}).toThrow('Unknown transcription backend: null');
		});
	});

	describe('getBackendConfig', () => {
		it('should return OpenAI config', async () => {
			vi.stubEnv('OPENAI_MODEL', 'gpt-4o-transcribe');
			vi.stubEnv('OPENAI_TRANSCRIPTION_PROMPT', 'Transcribe this');

			const { getBackendConfig } = await import('../../../src/backends/BackendFactory');

			const config = getBackendConfig('openai');

			expect(config).toEqual({
				language: null,
				prompt: 'Transcribe this',
				model: 'gpt-4o-transcribe',
			});
		});

		it('should return Gemini config', async () => {
			vi.stubEnv('GEMINI_MODEL', 'gemini-2.0');
			vi.stubEnv('GEMINI_TRANSCRIPTION_PROMPT', 'Transcribe audio');

			const { getBackendConfig } = await import('../../../src/backends/BackendFactory');

			const config = getBackendConfig('gemini');

			expect(config).toEqual({
				language: null,
				prompt: 'Transcribe audio',
				model: 'gemini-2.0',
			});
		});

		it('should return Deepgram config', async () => {
			vi.stubEnv('DEEPGRAM_MODEL', 'nova-2');

			const { getBackendConfig } = await import('../../../src/backends/BackendFactory');

			const config = getBackendConfig('deepgram');

			expect(config).toEqual({
				language: null,
				prompt: undefined, // Deepgram doesn't support prompts
				model: 'nova-2',
			});
		});

		it('should return Dummy config', async () => {
			const { getBackendConfig } = await import('../../../src/backends/BackendFactory');

			const config = getBackendConfig('dummy');

			expect(config).toEqual({
				language: null,
				prompt: undefined,
				model: undefined,
			});
		});

		it('should use default provider when none specified', async () => {
			vi.stubEnv('OPENAI_API_KEY', 'test-key');
			vi.stubEnv('OPENAI_MODEL', 'gpt-4o-mini-transcribe');

			const { getBackendConfig } = await import('../../../src/backends/BackendFactory');

			const config = getBackendConfig();

			// Should use OpenAI config as default
			expect(config.model).toBe('gpt-4o-mini-transcribe');
		});

		it('should throw error for unknown provider', async () => {
			const { getBackendConfig } = await import('../../../src/backends/BackendFactory');

			expect(() => {
				getBackendConfig('invalid' as any);
			}).toThrow('Unknown transcription backend: invalid');
		});

		it('should handle undefined prompts', async () => {
			// Don't set OPENAI_TRANSCRIPTION_PROMPT env var

			const { getBackendConfig } = await import('../../../src/backends/BackendFactory');

			const config = getBackendConfig('openai');

			expect(config.prompt).toBeUndefined();
		});
	});
});
