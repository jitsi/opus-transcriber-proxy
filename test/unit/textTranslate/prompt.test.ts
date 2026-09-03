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
	it('has no context block for the first turn', () => {
		const prompt = buildUserPrompt(request());
		expect(prompt).not.toContain('CONTEXT');
		expect(prompt).toBe('TRANSLATE (spoken by Speaker 2) into French (fr):\nshe said it was fine');
	});

	it('lists the history oldest first, labelled, before the line to translate', () => {
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
				'TRANSLATE (spoken by Speaker 2) into French (fr):',
				'she said it was fine',
			].join('\n'),
		);
	});

	it('omits every speaker mention when the turns carry no label', () => {
		const prompt = buildUserPrompt({
			turn: { text: 'she said it was fine' },
			targetLanguage: 'fr',
			history: [{ text: 'did you check the encoder' }],
		});
		expect(prompt).not.toContain('Speaker');
		expect(prompt).not.toContain('spoken by');
		expect(prompt).toContain('did you check the encoder');
	});
});

describe('sanitizeTranslation', () => {
	it('returns plain text unchanged', () => {
		expect(sanitizeTranslation('elle a dit que tout allait bien', request())).toBe('elle a dit que tout allait bien');
	});

	it('trims surrounding whitespace and quotes', () => {
		expect(sanitizeTranslation('  "bonjour"  ', request())).toBe('bonjour');
		expect(sanitizeTranslation('« bonjour »', request())).toBe('bonjour');
	});

	it('removes an answer label', () => {
		expect(sanitizeTranslation('Translation: bonjour', request())).toBe('bonjour');
		expect(sanitizeTranslation('Translated text: bonjour', request())).toBe('bonjour');
	});

	it('removes a code fence', () => {
		expect(sanitizeTranslation('```\nbonjour\n```', request())).toBe('bonjour');
		expect(sanitizeTranslation('```text\nbonjour\n```', request())).toBe('bonjour');
	});

	it('removes a speaker label the model copied from the prompt', () => {
		expect(sanitizeTranslation('Speaker 2: bonjour', request())).toBe('bonjour');
		expect(sanitizeTranslation('Sprecher 2: guten Tag', request())).toBe('guten Tag');
	});

	it('keeps a colon that belongs to the sentence', () => {
		expect(sanitizeTranslation('trois choses : un, deux, trois', request())).toBe('trois choses : un, deux, trois');
	});

	it('throws when nothing usable is left', () => {
		expect(() => sanitizeTranslation('', request())).toThrow(/empty/);
		expect(() => sanitizeTranslation('   ', request())).toThrow(/empty/);
		expect(() => sanitizeTranslation('Speaker 2:', request())).toThrow(/empty/);
	});
});
