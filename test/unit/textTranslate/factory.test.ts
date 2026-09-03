/**
 * Tests for text-translation provider selection: which providers count as available, which one is
 * the default, and what each one is created as.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatCompletionsTextTranslator } from '../../../src/textTranslate/ChatCompletionsTextTranslator';
import { GeminiTextTranslator } from '../../../src/textTranslate/GeminiTextTranslator';
import { GoogleTranslateTextTranslator } from '../../../src/textTranslate/GoogleTranslateTextTranslator';
import { StubTextTranslator } from '../../../src/textTranslate/StubTextTranslator';
import {
	createTextTranslator,
	getAvailableTextTranslationProviders,
	getDefaultTextTranslationProvider,
	isTextTranslationProviderAvailable,
	isValidTextTranslationProvider,
	usesConversationContext,
} from '../../../src/textTranslate/factory';

vi.mock('../../../src/config', () => ({
	config: {
		textTranslation: {
			enabled: true,
			providersPriority: ['openai', 'gemini', 'xai', 'google'],
			enableStub: false,
			historyTurns: 6,
			historyMaxChars: 2000,
			includeSpeakers: true,
			timeoutMs: 10000,
			temperature: undefined,
			reasoningEffort: undefined,
			maxOutputTokens: undefined,
			openai: { apiKey: '', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
			xai: { apiKey: '', url: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.20-0309-non-reasoning' },
			gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-lite', thinkingBudget: 0 },
			google: { apiKey: '', url: 'https://translation.googleapis.com/language/translate/v2' },
		},
	},
}));

let textTranslation: any;

beforeEach(async () => {
	textTranslation = (await import('../../../src/config')).config.textTranslation;
	textTranslation.providersPriority = ['openai', 'gemini', 'xai', 'google'];
	textTranslation.enableStub = false;
	textTranslation.openai.apiKey = '';
	textTranslation.xai.apiKey = '';
	textTranslation.gemini.apiKey = '';
	textTranslation.google.apiKey = '';
});

describe('isValidTextTranslationProvider', () => {
	it.each(['openai', 'xai', 'gemini', 'google', 'stub'])('accepts %s', (provider) => {
		expect(isValidTextTranslationProvider(provider)).toBe(true);
	});

	it.each(['deepgram', 'OpenAI', '', 'openai_custom'])('rejects %s', (provider) => {
		expect(isValidTextTranslationProvider(provider)).toBe(false);
	});
});

describe('availability', () => {
	it('needs a key per provider', () => {
		expect(isTextTranslationProviderAvailable('openai')).toBe(false);
		textTranslation.openai.apiKey = 'sk-test';
		expect(isTextTranslationProviderAvailable('openai')).toBe(true);
	});

	it('gates the stub behind its own flag, like the dummy transcription provider', () => {
		expect(isTextTranslationProviderAvailable('stub')).toBe(false);
		textTranslation.enableStub = true;
		expect(isTextTranslationProviderAvailable('stub')).toBe(true);
	});

	it('lists every available provider in the canonical order', () => {
		textTranslation.xai.apiKey = 'xai-test';
		textTranslation.openai.apiKey = 'sk-test';
		expect(getAvailableTextTranslationProviders()).toEqual(['openai', 'xai']);
	});
});

describe('getDefaultTextTranslationProvider', () => {
	it('takes the first available entry of the priority list', () => {
		textTranslation.gemini.apiKey = 'gem-test';
		textTranslation.xai.apiKey = 'xai-test';
		expect(getDefaultTextTranslationProvider()).toBe('gemini');
	});

	it('follows the configured order, not the canonical one', () => {
		textTranslation.providersPriority = ['xai', 'openai'];
		textTranslation.openai.apiKey = 'sk-test';
		textTranslation.xai.apiKey = 'xai-test';
		expect(getDefaultTextTranslationProvider()).toBe('xai');
	});

	it('skips an unknown name in the priority list', () => {
		textTranslation.providersPriority = ['deepgram', 'openai'];
		textTranslation.openai.apiKey = 'sk-test';
		expect(getDefaultTextTranslationProvider()).toBe('openai');
	});

	it('is null when nothing is available', () => {
		expect(getDefaultTextTranslationProvider()).toBeNull();
	});

	it('is null when the only available provider is not in the priority list', () => {
		textTranslation.providersPriority = ['openai'];
		textTranslation.enableStub = true;
		expect(getDefaultTextTranslationProvider()).toBeNull();
	});
});

describe('createTextTranslator', () => {
	it('creates the OpenAI-shaped client for openai and xai', () => {
		expect(createTextTranslator('openai')).toBeInstanceOf(ChatCompletionsTextTranslator);
		expect(createTextTranslator('xai')).toBeInstanceOf(ChatCompletionsTextTranslator);
	});

	it('creates the provider-specific clients for gemini, google and stub', () => {
		expect(createTextTranslator('gemini')).toBeInstanceOf(GeminiTextTranslator);
		expect(createTextTranslator('google')).toBeInstanceOf(GoogleTranslateTextTranslator);
		expect(createTextTranslator('stub')).toBeInstanceOf(StubTextTranslator);
	});
});

describe('usesConversationContext', () => {
	it('is true for the LLM providers only', () => {
		expect(usesConversationContext('openai')).toBe(true);
		expect(usesConversationContext('xai')).toBe(true);
		expect(usesConversationContext('gemini')).toBe(true);
		// Cloud Translation takes one string; the stub ignores everything.
		expect(usesConversationContext('google')).toBe(false);
		expect(usesConversationContext('stub')).toBe(false);
	});
});
