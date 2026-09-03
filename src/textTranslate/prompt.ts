import { stripSpeakerLabel, type TextTranslationRequest, type TranslationTurn } from './TextTranslator';

/**
 * Prompt construction and output cleanup shared by every LLM-backed translator (OpenAI, xAI,
 * Gemini). The dedicated-MT provider (Google Cloud Translation) does not use any of this: it takes
 * a source and target language and nothing else.
 */

/** The English name of a language code, for prompts ("fr" -> "French"). Falls back to the code. */
export function languageName(code: string): string {
	try {
		const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
		// DisplayNames echoes an unknown code back; that is the fallback we want anyway.
		return name || code;
	} catch {
		return code;
	}
}

/** How a target language is named in a prompt: the name plus the code the client asked for. */
function targetDescription(code: string): string {
	const name = languageName(code);
	return name === code ? code : `${name} (${code})`;
}

/**
 * The instruction half of the prompt.
 *
 * The rules earn their place: transcripts are ASR output, so they arrive truncated and
 * mis-punctuated, and a chat model's default reaction to a fragment is to complete or answer it.
 * The label rules matter because a labelled context block invites the model to label its own
 * output, and a label rendered into a subtitle is worse than no translation at all — `stripSpeakerLabel`
 * enforces this, the prompt just makes it unlikely.
 */
export function buildSystemPrompt(targetLanguage: string): string {
	const target = targetDescription(targetLanguage);
	return [
		'You are a translation engine in a live meeting captioning system.',
		`Translate the line marked TRANSLATE into ${target}.`,
		'Rules:',
		`- Output only the translation, in ${target}. No speaker label, no quotes, no notes, no explanation, no original text.`,
		'- Keep the meaning, tone and register. Keep names, numbers and technical terms.',
		'- The text is speech-to-text output. It can be broken, mis-punctuated or cut off mid-sentence. Translate what is there. Do not complete it, answer it or comment on it.',
		'- The CONTEXT lines are earlier turns of the same conversation. Use them only to resolve pronouns, gender, formality and terminology. Never translate or repeat them.',
		`- If the line is already in ${target}, output it unchanged.`,
		'- If you cannot translate the line, output it unchanged.',
	].join('\n');
}

/** One context or target line: "Speaker 1: text" when labelled, "text" when not. */
function formatTurn(turn: TranslationTurn): string {
	return turn.speaker ? `${turn.speaker}: ${turn.text}` : turn.text;
}

/** The data half of the prompt: the context block (when any) and the line to translate. */
export function buildUserPrompt(request: TextTranslationRequest): string {
	const parts: string[] = [];
	if (request.history.length > 0) {
		parts.push('CONTEXT (earlier turns, do not translate):');
		parts.push(request.history.map(formatTurn).join('\n'));
		parts.push('');
	}
	const speaker = request.turn.speaker;
	parts.push(
		`TRANSLATE${speaker ? ` (spoken by ${speaker})` : ''} into ${targetDescription(request.targetLanguage)}:`,
	);
	parts.push(request.turn.text);
	return parts.join('\n');
}

/** Wraps a code fence the model may have added around its answer. */
const CODE_FENCE_RE = /^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/;
/** A label the model may have put in front of its answer. */
const ANSWER_LABEL_RE = /^\s*(translation|translated text|translated)\s*[:：]\s*/i;
/** Matching quotes around the whole answer. */
const QUOTED_RE = /^(["'“”„«»])([\s\S]*)(["'“”„«»])$/;

/**
 * Turn a model's raw answer into text that can be rendered as a subtitle.
 *
 * Throws when nothing usable is left, so the caller rejects and drops that one language for that
 * one transcript — an empty or refusal-shaped answer must not be published as a translation.
 */
export function sanitizeTranslation(raw: string, request: TextTranslationRequest): string {
	let text = (raw ?? '').trim();

	const fenced = CODE_FENCE_RE.exec(text);
	if (fenced) {
		text = fenced[1].trim();
	}
	text = text.replace(ANSWER_LABEL_RE, '').trim();

	const quoted = QUOTED_RE.exec(text);
	if (quoted) {
		text = quoted[2].trim();
	}

	text = stripSpeakerLabel(text, request.turn.speaker).trim();

	if (!text) {
		throw new Error('translator returned an empty translation');
	}
	return text;
}
