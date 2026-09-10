/**
 * Tests for the shared LLM prompt: what goes into it, and how a model's answer is cleaned up before
 * it can be rendered as a subtitle.
 */

import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildUserPrompt, languageName, sanitizeTranslation } from '../../../src/textTranslate/prompt';
import type { TextTranslationRequest } from '../../../src/textTranslate/TextTranslator';

function request(overrides: Partial<TextTranslationRequest> = {}): TextTranslationRequest {
	return {
		turn: { speaker: 'Speaker 2', text: 'she said it was fine', language: 'en' },
		targetLanguage: 'fr',
		history: [],
		...overrides,
	};
}

describe('languageName', () => {
	it('names a known code', () => {
		expect(languageName('fr')).toBe('French');
		expect(languageName('zh-CN')).toContain('Chinese');
	});

	it('falls back to the code itself', () => {
		expect(languageName('zzz')).toBe('zzz');
	});
});

describe('buildSystemPrompt', () => {
	it('names the target language and forbids labels, quotes and commentary', () => {
		const prompt = buildSystemPrompt('fr');
		expect(prompt).toContain('French (fr)');
		expect(prompt).toContain('No speaker label');
		expect(prompt).toContain('Never translate or repeat them');
	});

	it('uses the bare code when the language has no name', () => {
		expect(buildSystemPrompt('zzz')).toContain('into zzz');
	});
});

describe('buildUserPrompt', () => {
	it('is just the bare header and the text for the first turn', () => {
		const prompt = buildUserPrompt(request());

		expect(prompt).not.toContain('CONTEXT');
		// No attribution: with no earlier turns there is nobody to contrast the speaker with. No
		// target language either: the system prompt already names it.
		expect(prompt).toBe('TRANSLATE:\nshe said it was fine');
	});

	it('lists the history oldest first, then attributes the turn in prose', () => {
		const prompt = buildUserPrompt(
			request({
				history: [
					{ speaker: 'Speaker 1', text: 'did you check the encoder' },
					{ speaker: 'Speaker 2', text: 'yes I did' },
				],
			}),
		);
		expect(prompt).toBe(
			[
				'CONTEXT (earlier turns, do not translate):',
				'Speaker 1: did you check the encoder',
				'Speaker 2: yes I did',
				'',
				'The text you will be asked to translate next is coming from Speaker 2.',
				'',
				'TRANSLATE:',
				'she said it was fine',
			].join('\n'),
		);
	});

	it('never puts a label on the line being translated', () => {
		const prompt = buildUserPrompt(
			request({ history: [{ speaker: 'Speaker 1', text: 'did you check the encoder' }] }),
		);

		// The one shape that reproducibly makes a model echo the label is a label sharing a line with
		// the target text (measured 12/12 on openai and xai). The last two lines must stay clean.
		const lines = prompt.split('\n');
		expect(lines[lines.length - 2]).toBe('TRANSLATE:');
		expect(lines[lines.length - 1]).toBe('she said it was fine');
	});

	it('omits every speaker mention when the turns carry no label', () => {
		const prompt = buildUserPrompt({
			turn: { text: 'she said it was fine' },
			targetLanguage: 'fr',
			history: [{ text: 'did you check the encoder' }],
		});
		expect(prompt).not.toContain('Speaker');
		expect(prompt).not.toContain('coming from');
		expect(prompt).toContain('did you check the encoder');
	});

	it('names the target language only in the system prompt, never twice', () => {
		const prompt = buildUserPrompt(request({ history: [{ speaker: 'Speaker 1', text: 'earlier' }] }));

		expect(prompt).not.toContain('French');
		expect(prompt).not.toContain('(fr)');
		expect(buildSystemPrompt('fr')).toContain('French (fr)');
	});
});

describe('sanitizeTranslation', () => {
	it('returns plain text unchanged', () => {
		expect(sanitizeTranslation('elle a dit que tout allait bien')).toBe('elle a dit que tout allait bien');
	});

	it('trims surrounding whitespace and quotes', () => {
		expect(sanitizeTranslation('  "bonjour"  ')).toBe('bonjour');
		expect(sanitizeTranslation('« bonjour »')).toBe('bonjour');
	});

	it('removes an answer label', () => {
		expect(sanitizeTranslation('Translation: bonjour')).toBe('bonjour');
		expect(sanitizeTranslation('Translated text: bonjour')).toBe('bonjour');
	});

	it('removes a code fence', () => {
		expect(sanitizeTranslation('```\nbonjour\n```')).toBe('bonjour');
		expect(sanitizeTranslation('```text\nbonjour\n```')).toBe('bonjour');
	});

	it('leaves anything that is not a chat-formatting artefact alone', () => {
		// No speaker-label removal: recognising a label in an arbitrary language means guessing, and a
		// guess that fires on real text corrupts a subtitle silently. Labels are kept out by prompt
		// construction instead, and a leaked one is logged by TranscriberProxy rather than edited.
		expect(sanitizeTranslation('Sprecher 2: guten Tag')).toBe('Sprecher 2: guten Tag');
		expect(sanitizeTranslation('Room 12: it is booked')).toBe('Room 12: it is booked');
		expect(sanitizeTranslation('trois choses : un, deux, trois')).toBe('trois choses : un, deux, trois');
	});

	it('throws when nothing usable is left', () => {
		expect(() => sanitizeTranslation('')).toThrow(/empty/);
		expect(() => sanitizeTranslation('   ')).toThrow(/empty/);
		expect(() => sanitizeTranslation('""')).toThrow(/empty/);
	});
});
