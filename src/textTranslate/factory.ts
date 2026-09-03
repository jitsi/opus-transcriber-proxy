import { config } from '../config';
import { ChatCompletionsTextTranslator } from './ChatCompletionsTextTranslator';
import { GeminiTextTranslator } from './GeminiTextTranslator';
import { GoogleTranslateTextTranslator } from './GoogleTranslateTextTranslator';
import { StubTextTranslator } from './StubTextTranslator';
import type { TextTranslator } from './TextTranslator';

/**
 * The text-translation providers this build knows about.
 *
 * - `openai`, `xai`, `gemini` — LLM APIs. They take the conversation as context (speaker-labelled
 *   history) and are billed per token.
 * - `google` — Cloud Translation v2, dedicated neural MT. Billed per character, no context.
 * - `stub` — does not translate; for exercising the signalling path.
 *
 * Provider selection mirrors transcription: a priority list picks the default from the ones that
 * are available, and a connection can override it with a URL parameter.
 */
export type TextTranslationProvider = 'openai' | 'xai' | 'gemini' | 'google' | 'stub';

const ALL_PROVIDERS: TextTranslationProvider[] = ['openai', 'xai', 'gemini', 'google', 'stub'];

export function isValidTextTranslationProvider(provider: string): provider is TextTranslationProvider {
	return (ALL_PROVIDERS as string[]).includes(provider);
}

/** Whether `provider` has everything it needs to run (its API key, or its explicit enable flag). */
export function isTextTranslationProviderAvailable(provider: TextTranslationProvider): boolean {
	switch (provider) {
		case 'openai':
			return !!config.textTranslation.openai.apiKey;
		case 'xai':
			return !!config.textTranslation.xai.apiKey;
		case 'gemini':
			return !!config.textTranslation.gemini.apiKey;
		case 'google':
			return !!config.textTranslation.google.apiKey;
		case 'stub':
			return config.textTranslation.enableStub;
		default:
			return false;
	}
}

/** Every available provider, in the canonical order. */
export function getAvailableTextTranslationProviders(): TextTranslationProvider[] {
	return ALL_PROVIDERS.filter(isTextTranslationProviderAvailable);
}

/**
 * The default provider: the first available entry of TEXT_TRANSLATION_PROVIDERS_PRIORITY. Null when
 * none of them is available, in which case requested languages are logged and dropped.
 */
export function getDefaultTextTranslationProvider(): TextTranslationProvider | null {
	for (const provider of config.textTranslation.providersPriority) {
		if (isValidTextTranslationProvider(provider) && isTextTranslationProviderAvailable(provider)) {
			return provider;
		}
	}
	return null;
}

/** Create the translator for `provider`. */
export function createTextTranslator(provider: TextTranslationProvider): TextTranslator {
	const shared = {
		timeoutMs: config.textTranslation.timeoutMs,
		temperature: config.textTranslation.temperature,
		reasoningEffort: config.textTranslation.reasoningEffort,
		maxOutputTokens: config.textTranslation.maxOutputTokens,
	};

	switch (provider) {
		case 'openai':
			return new ChatCompletionsTextTranslator({
				name: 'openai',
				url: config.textTranslation.openai.url,
				apiKey: config.textTranslation.openai.apiKey,
				model: config.textTranslation.openai.model,
				...shared,
			});
		case 'xai':
			// xAI's API is OpenAI-shaped, so it is the same client with a different URL/key/model.
			return new ChatCompletionsTextTranslator({
				name: 'xai',
				url: config.textTranslation.xai.url,
				apiKey: config.textTranslation.xai.apiKey,
				model: config.textTranslation.xai.model,
				...shared,
			});
		case 'gemini':
			return new GeminiTextTranslator({
				baseUrl: config.textTranslation.gemini.baseUrl,
				apiKey: config.textTranslation.gemini.apiKey,
				model: config.textTranslation.gemini.model,
				timeoutMs: config.textTranslation.timeoutMs,
				temperature: config.textTranslation.temperature,
				thinkingBudget: config.textTranslation.gemini.thinkingBudget,
			});
		case 'google':
			return new GoogleTranslateTextTranslator({
				url: config.textTranslation.google.url,
				apiKey: config.textTranslation.google.apiKey,
				timeoutMs: config.textTranslation.timeoutMs,
			});
		case 'stub':
			return new StubTextTranslator();
		default: {
			// Exhaustiveness check: adding a provider to the union without a case here is a compile error.
			const unreachable: never = provider;
			throw new Error(`Unknown text translation provider: ${String(unreachable)}`);
		}
	}
}

/** Whether `provider` uses conversation history and speaker labels. */
export function usesConversationContext(provider: TextTranslationProvider): boolean {
	// Cloud Translation takes one string with no notion of a conversation, and the stub ignores it.
	return provider === 'openai' || provider === 'xai' || provider === 'gemini';
}
