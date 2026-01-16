/**
 * Factory for creating transcription backends
 */

import { config } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
import { OpenAIBackend } from './OpenAIBackend';
import { GeminiBackend } from './GeminiBackend';
import { DeepgramBackend } from './DeepgramBackend';
import { DummyBackend } from './DummyBackend';

export function createBackend(tag: string, participantInfo: any): TranscriptionBackend {
	const backendType = config.transcriptionBackend;

	logger.info(`Creating ${backendType} transcription backend for tag: ${tag}`);

	switch (backendType) {
		case 'openai':
			return new OpenAIBackend(tag, participantInfo);
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

export function getBackendConfig(): BackendConfig {
	const backendType = config.transcriptionBackend;

	switch (backendType) {
		case 'openai':
			return {
				language: null, // Will be set per-connection based on options
				prompt: config.openai.transcriptionPrompt,
				model: config.openai.model,
			};
		case 'gemini':
			return {
				language: null, // Will be set per-connection based on options
				prompt: config.gemini.transcriptionPrompt,
				model: config.gemini.model,
			};
		case 'deepgram':
			return {
				language: null, // Will be set per-connection based on options
				prompt: undefined, // Deepgram doesn't support prompts
				model: config.deepgram.model,
			};
		case 'dummy':
			return {
				language: null,
				prompt: undefined, // Dummy backend doesn't use prompts
				model: undefined,
			};
		default:
			throw new Error(`Unknown transcription backend: ${backendType}`);
	}
}
