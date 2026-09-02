/**
 * Text translation: the transcriber's text is translated into a set of target languages and sent
 * back to the bridge alongside the original transcript. This is distinct from the `/translate`
 * endpoint, which is speech-to-speech (audio in, translated audio out).
 *
 * The target languages arrive on the `/transcribe` WebSocket in the `sources` control event's
 * `requests` list (see TranscriberProxy.handleSourcesEvent).
 */

/** Translates one piece of transcript text into one target language. */
export interface TextTranslator {
	/**
	 * Translate `text` into `targetLanguage`. `sourceLanguage` is the language the backend detected
	 * for the transcript, when it reported one.
	 *
	 * Implementations must not throw for ordinary failures; reject the returned promise instead. The
	 * caller logs and drops a rejected translation, leaving the original transcript unaffected.
	 */
	translate(text: string, targetLanguage: string, sourceLanguage?: string): Promise<string>;

	/** Release any backend resources. Optional; must be idempotent when present. */
	close?(): void;
}

/**
 * Language codes as jitsi-meet sends them (the keys of `lang/translation-languages.json`): a 2- or
 * 3-letter primary subtag, optionally with a region/script subtag, e.g. "fr", "ceb", "zh-CN".
 *
 * Codes are echoed back verbatim in the translated message, because the client matches them by
 * exact string equality against the language it selected (subtitles/middleware.ts and
 * AbstractClosedCaptions.tsx). Do not normalise them.
 */
const LANGUAGE_CODE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Whether `language` looks like a target language code we can accept. */
export function isValidTargetLanguage(language: unknown): language is string {
	return typeof language === 'string' && LANGUAGE_CODE_RE.test(language);
}

/**
 * Whether a transcript already in `sourceLanguage` needs translating into `targetLanguage`.
 *
 * Compares the primary subtag only, so a transcript reported as "en-US" is not translated into
 * "en" (jigasi's TranslationManager skips the speaker's own language the same way). An unknown
 * source language means we cannot rule it out, so we translate.
 */
export function needsTranslation(targetLanguage: string, sourceLanguage?: string): boolean {
	if (!sourceLanguage) {
		return true;
	}
	return primarySubtag(targetLanguage) !== primarySubtag(sourceLanguage);
}

function primarySubtag(language: string): string {
	return language.split(/[-_]/)[0].toLowerCase();
}
