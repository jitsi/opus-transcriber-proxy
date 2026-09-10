import type { TranscriptionMessage } from '../transcriberproxy';

/**
 * A translated-transcript message.
 *
 * The inner `type` is `translation-result` — jigasi's long-standing text-translation type, which
 * jitsi-meet already renders in the CC panel and as on-stage subtitles
 * (react/features/subtitles/middleware.ts). The outer `event` stays `transcription-result` because
 * the JVB dispatches on `event` (via jicoco-mediajson) and forwards the payload — including the
 * inner `type` — to the clients verbatim.
 *
 * Do not confuse this with the `/translate` endpoint's `realtime-translation-result`, which is
 * deliberately a type the CC panel ignores (that stream's transcripts accompany translated audio).
 *
 * Field shapes are dictated by what the client reads for this type:
 *  - `text` is a plain string, NOT a `transcript: [{ text }]` array (that is the shape for
 *    `transcription-result`).
 *  - `message_id` is the id of the transcription this was translated from, so the CC panel can pair
 *    the two and show the translation in place of the original.
 *  - `language` is echoed verbatim from the request; the client matches it by exact equality.
 */
export interface TextTranslationMessage {
	event: 'transcription-result';
	type: 'translation-result';
	message_id: string;
	language: string;
	text: string;
	participant: { id: string; tag?: string };
	timestamp: number;
	speaker?: number;
}

/**
 * Build the translated-transcript message for `translatedText` in `targetLanguage`, derived from the
 * `transcription` it was translated from (whose `message_id`, `participant`, `timestamp` and
 * `speaker` it reuses).
 */
export function buildTextTranslationMessage(
	transcription: TranscriptionMessage,
	targetLanguage: string,
	translatedText: string,
): TextTranslationMessage {
	return {
		event: 'transcription-result',
		type: 'translation-result',
		message_id: transcription.message_id,
		language: targetLanguage,
		text: translatedText,
		participant: transcription.participant,
		timestamp: transcription.timestamp,
		...(transcription.speaker !== undefined && { speaker: transcription.speaker }),
	};
}

/** The text of a transcription message, as a single string. */
export function transcriptionText(message: TranscriptionMessage): string {
	return (message.transcript ?? []).map((segment) => segment.text ?? '').join(' ').trim();
}
