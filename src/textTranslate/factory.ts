import { StubTextTranslator } from './StubTextTranslator';
import type { TextTranslator } from './TextTranslator';

/** The text-translation providers this build knows about. */
export type TextTranslationProvider = 'stub';

export function isValidTextTranslationProvider(provider: string): provider is TextTranslationProvider {
	return provider === 'stub';
}

/** Create the translator for `provider`. */
export function createTextTranslator(provider: TextTranslationProvider): TextTranslator {
	switch (provider) {
		case 'stub':
			return new StubTextTranslator();
		default: {
			// Exhaustiveness check: adding a provider to the union without a case here is a compile error.
			const unreachable: never = provider;
			throw new Error(`Unknown text translation provider: ${String(unreachable)}`);
		}
	}
}
