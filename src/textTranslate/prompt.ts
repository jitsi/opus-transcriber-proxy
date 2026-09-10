import type { TextTranslationRequest, TranslationTurn } from './TextTranslator';

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
 * The label rule is here because a label rendered into a subtitle is worse than no translation at
 * all. It is the prompt's job alone: nothing downstream tries to detect a label in the output, since
 * that means guessing at names in an arbitrary language. What actually keeps labels out is
 * {@link buildUserPrompt} never putting one on the line being translated.
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

/**
 * The data half of the prompt: the context block (when any) and the line to translate.
 *
 * Two deliberate omissions from the TRANSLATE header, which is a bare `TRANSLATE:`.
 *
 * The **target language** is not repeated here. The system prompt already names it, and saying it
 * twice is redundant, not reinforcing.
 *
 * The **speaker** is named in a sentence at the end of the context block rather than in the header.
 * Measured against the live APIs: attribution in the header never produced an echoed label (0/24
 * across three providers, even with the "no speaker label" rule removed from the system prompt),
 * but a label placed on the same line as the text to translate produced one every single time
 * (12/12 on openai and xai). So the invariant that matters is that no label may share a line with
 * the target text — and keeping attribution out of the imperative header, in prose, is the shape
 * that makes that invariant obvious and keeps it true as model defaults churn.
 *
 * The attribution is only worth sending alongside context: with no earlier turns there is nobody to
 * contrast the speaker with, so it would be tokens spent on nothing.
 */
export function buildUserPrompt(request: TextTranslationRequest): string {
	const parts: string[] = [];
	const speaker = request.turn.speaker;
	if (request.history.length > 0) {
		parts.push('CONTEXT (earlier turns, do not translate):');
		parts.push(request.history.map(formatTurn).join('\n'));
		if (speaker) {
			parts.push('');
			parts.push(`The text you will be asked to translate next is coming from ${speaker}.`);
		}
		parts.push('');
	}
	parts.push('TRANSLATE:');
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
 * Every rule here matches a literal artefact of chat formatting — a fence, an English answer label,
 * a pair of quotes — so unwrapping one cannot eat content. This deliberately does **not** try to
 * remove a speaker label: doing so meant pattern-matching a name in an arbitrary human language,
 * which silently corrupts real sentences ("Room 12: it's booked") in exchange for a failure that
 * measurement could not produce. Labels are kept out of the output by prompt construction instead —
 * see {@link buildUserPrompt} — and `TranscriberProxy` logs the case if one ever appears anyway.
 *
 * Throws when nothing usable is left, so the caller rejects and drops that one language for that
 * one transcript — an empty or refusal-shaped answer must not be published as a translation.
 */
export function sanitizeTranslation(raw: string): string {
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

	if (!text) {
		throw new Error('translator returned an empty translation');
	}
	return text;
}
