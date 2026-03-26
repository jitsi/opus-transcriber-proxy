/**
 * Factory for creating transcription backends
 */

import { config, getDefaultProvider, type Provider } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
import { OpenAIBackend } from './OpenAIBackend';
import { GeminiBackend } from './GeminiBackend';
import { DeepgramBackend } from './DeepgramBackend';
import { DummyBackend } from './DummyBackend';

export interface OpenAICustomOptions {
	openaiCustomUrl?: string;
	openaiCustomApiKey?: string;
}

export function createBackend(tag: string, participantInfo: any, provider?: Provider, customOptions?: OpenAICustomOptions): TranscriptionBackend {
	const backendType = provider || getDefaultProvider();

	logger.info(`Creating ${backendType} transcription backend for tag: ${tag}`);

	switch (backendType) {
		case 'openai':
			return new OpenAIBackend(tag, participantInfo);
		case 'openai_custom':
			return new OpenAIBackend(tag, participantInfo, customOptions?.openaiCustomUrl, customOptions?.openaiCustomApiKey);
		case 'gemini':
			return new GeminiBackend(tag, participantInfo);
		case 'deepgram':
			return new DeepgramBackend(tag, participantInfo);
		case 'dummy':
			return new DummyBackend(tag, participantInfo);
		default:
			throw new Error(`Unknown transcription backend: ${backendType}`);
	}
}

export function getBackendConfig(provider?: Provider): BackendConfig {
	const backendType = provider || getDefaultProvider();

	switch (backendType) {
		case 'openai':
		case 'openai_custom':
			return {
				language: undefined, // Will be set per-connection based on options
				prompt: config.openai.transcriptionPrompt,
				model: config.openai.model,
			};
		case 'gemini':
			return {
				language: undefined, // Will be set per-connection based on options
				prompt: config.gemini.transcriptionPrompt,
				model: config.gemini.model,
			};
		case 'deepgram':
			return {
				language: undefined, // Will be set per-connection based on options
				prompt: undefined, // Deepgram doesn't support prompts
				model: config.deepgram.model,
			};
		case 'dummy':
			return {
				language: undefined,
				prompt: undefined, // Dummy backend doesn't use prompts
				model: undefined,
			};
		default:
			throw new Error(`Unknown transcription backend: ${backendType}`);
	}
}
