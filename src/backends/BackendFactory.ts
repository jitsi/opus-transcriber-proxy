/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
 * Factory for creating transcription backends
 */

import { config, getDefaultProvider, type Provider } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
import { OpenAIBackend } from './OpenAIBackend';
import { GeminiBackend } from './GeminiBackend';
import { DeepgramBackend } from './DeepgramBackend';
import { DummyBackend } from './DummyBackend';
import { XAIBackend } from './XAIBackend';

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
		case 'xai':
			return new XAIBackend(tag, participantInfo);
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
				language: undefined,
				prompt: undefined,
				model: config.deepgram.model,
			};
		case 'xai':
			return {
				language: undefined,
				prompt: undefined,
				model: undefined,
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
