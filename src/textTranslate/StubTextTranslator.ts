import type { TextTranslationRequest, TextTranslator } from './TextTranslator';

/**
 * A translator that does no translation: it prefixes the text with the upper-cased target language,
 * e.g. "hello" -> "[FR] hello".
 *
 * This exists to exercise the full signalling path (client language selection -> jicofo aggregation
 * -> colibri2 connect `requests` -> bridge `sources` event -> here -> back to the client) without a
 * translation provider. Real providers implement the same {@link TextTranslator} interface.
 *
 * It deliberately ignores `history` and the speaker label, exactly as a real provider must never
 * put them in its output.
 */
export class StubTextTranslator implements TextTranslator {
	async translate(request: TextTranslationRequest): Promise<string> {
		return `[${request.targetLanguage.toUpperCase()}] ${request.turn.text}`;
	}
}
