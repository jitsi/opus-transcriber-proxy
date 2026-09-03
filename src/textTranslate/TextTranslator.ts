/**
 * Text translation: the transcriber's text is translated into a set of target languages and sent
 * back to the bridge alongside the original transcript. This is distinct from the `/translate`
 * endpoint, which is speech-to-speech (audio in, translated audio out).
 *
 * The target languages arrive on the `/transcribe` WebSocket in the `sources` control event's
 * `requests` list (see TranscriberProxy.handleSourcesEvent).
 */

/**
 * One final transcript in the conversation: who said it, what they said, and the language the
 * backend detected for it (when it reported one).
 *
 * `speaker` is a short synthetic label ("Speaker 1"), not a display name — the proxy never sees
 * display names. It is only a hint for the translator, and must never appear in translated output
 * (see {@link stripSpeakerLabel}). It is omitted entirely when `TEXT_TRANSLATION_INCLUDE_SPEAKERS`
 * is off.
 */
export interface TranslationTurn {
	speaker?: string;
	text: string;
	language?: string;
}

/** One translation job: a turn, a target language, and the conversation so far as context. */
export interface TextTranslationRequest {
	/** The turn to translate. */
	turn: TranslationTurn;
	/** The language to translate into, verbatim as the client requested it. */
	targetLanguage: string;
	/**
	 * Earlier turns of the same session, oldest first. Context only — a translator must never
	 * translate or echo these. Empty when history is disabled or this is the first turn.
	 */
	history: TranslationTurn[];
}

/** Translates one piece of transcript text into one target language. */
export interface TextTranslator {
	/**
	 * Translate `request.turn.text` into `request.targetLanguage`.
	 *
	 * Implementations must not throw for ordinary failures; reject the returned promise instead. The
	 * caller logs and drops a rejected translation, leaving the original transcript unaffected.
	 * Implementations must return the translated text only: no speaker label, no quoting, no
	 * commentary (see {@link stripSpeakerLabel} and `sanitizeTranslation` in ./prompt).
	 */
	translate(request: TextTranslationRequest): Promise<string>;

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

/** Matches a leading English speaker label the model may have copied from the prompt, e.g. "Speaker 2: ". */
const SPEAKER_LABEL_PREFIX_RE = /^\s*speaker\s*\d+\s*[:：]\s*/i;

/**
 * Remove a speaker label the translator prefixed to its output.
 *
 * The prompt tells the model to translate the line only, but a labelled line is an inviting pattern
 * to continue, and a label in a subtitle is worse than no translation at all: the client renders
 * the text verbatim. So the label is stripped unconditionally from every provider's output rather
 * than only asked for in the prompt.
 *
 * Two shapes are removed: the English label we generate ("Speaker 2:"), and — when `speaker` is
 * given — a translated label that kept the same number ("Sprecher 2:", "话者 2："). Requiring the
 * number to match the turn's own label keeps this from eating a real sentence that starts the same
 * way ("Room 12: it's booked").
 */
export function stripSpeakerLabel(text: string, speaker?: string): string {
	const stripped = text.replace(SPEAKER_LABEL_PREFIX_RE, '');
	const speakerNumber = speaker?.match(/\d+/)?.[0];
	if (!speakerNumber) {
		return stripped;
	}
	// A translated label keeps the shape "<one or two words> <same number><colon>".
	const translatedLabel = new RegExp(`^\\s*\\p{L}+(\\s+\\p{L}+)?\\s*${speakerNumber}\\s*[:：]\\s*`, 'u');
	return stripped.replace(translatedLabel, '');
}
