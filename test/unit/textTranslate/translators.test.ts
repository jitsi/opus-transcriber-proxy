/**
 * Tests for the four real text translators. `fetch` is stubbed, so these check the request each
 * provider builds, how it reads the response, and how it fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatCompletionsTextTranslator } from '../../../src/textTranslate/ChatCompletionsTextTranslator';
import { GeminiTextTranslator } from '../../../src/textTranslate/GeminiTextTranslator';
import { GoogleTranslateTextTranslator } from '../../../src/textTranslate/GoogleTranslateTextTranslator';
import type { TextTranslationRequest } from '../../../src/textTranslate/TextTranslator';

const REQUEST: TextTranslationRequest = {
	turn: { speaker: 'Speaker 2', text: 'she said it was fine', language: 'en' },
	targetLanguage: 'fr',
	history: [{ speaker: 'Speaker 1', text: 'did you check the encoder' }],
};

let fetchMock: ReturnType<typeof vi.fn>;

/** A fetch that answers with `body` as JSON. */
function respondJson(body: unknown, status = 200) {
	fetchMock.mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	});
}

/** The parsed body of the single request the translator made. */
function sentBody(): any {
	return JSON.parse(fetchMock.mock.calls[0][1].body);
}

function sentHeaders(): Record<string, string> {
	return fetchMock.mock.calls[0][1].headers;
}

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('ChatCompletionsTextTranslator', () => {
	function translator(overrides: Record<string, unknown> = {}) {
		return new ChatCompletionsTextTranslator({
			name: 'openai',
			url: 'https://api.openai.com/v1/chat/completions',
			apiKey: 'sk-test',
			model: 'gpt-4o-mini',
			timeoutMs: 1000,
			...overrides,
		});
	}

	it('posts the model, the system prompt and the context-carrying user prompt', async () => {
		respondJson({ choices: [{ message: { content: 'elle a dit que tout allait bien' } }] });

		await expect(translator().translate(REQUEST)).resolves.toBe('elle a dit que tout allait bien');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
		expect(sentHeaders().Authorization).toBe('Bearer sk-test');
		const body = sentBody();
		expect(body.model).toBe('gpt-4o-mini');
		expect(body.messages[0].role).toBe('system');
		expect(body.messages[0].content).toContain('French (fr)');
		expect(body.messages[1].content).toContain('did you check the encoder');
		expect(body.messages[1].content).toContain('she said it was fine');
	});

	it('omits the tuning knobs that are not configured', async () => {
		respondJson({ choices: [{ message: { content: 'bonjour' } }] });

		await translator().translate(REQUEST);

		const body = sentBody();
		// The GPT-5 and Grok 4 families reject a temperature other than 1, and a small token cap on a
		// reasoning model returns empty content — so unset must mean "not sent".
		expect(body).not.toHaveProperty('temperature');
		expect(body).not.toHaveProperty('reasoning_effort');
		expect(body).not.toHaveProperty('max_completion_tokens');
	});

	it('sends the tuning knobs that are configured', async () => {
		respondJson({ choices: [{ message: { content: 'bonjour' } }] });

		await translator({ temperature: 0, reasoningEffort: 'low', maxOutputTokens: 200 }).translate(REQUEST);

		expect(sentBody()).toMatchObject({ temperature: 0, reasoning_effort: 'low', max_completion_tokens: 200 });
	});

	it('unwraps chat formatting but does not touch the words themselves', async () => {
		respondJson({ choices: [{ message: { content: '"elle a dit que tout allait bien"' } }] });

		await expect(translator().translate(REQUEST)).resolves.toBe('elle a dit que tout allait bien');
	});

	it('reads content that arrives as an array of parts', async () => {
		respondJson({ choices: [{ message: { content: [{ text: 'elle a ' }, { text: 'dit' }] } }] });

		await expect(translator().translate(REQUEST)).resolves.toBe('elle a dit');
	});

	it('rejects on a non-2xx response, naming the provider and the status', async () => {
		respondJson({ error: { message: 'model not found' } }, 404);

		await expect(translator().translate(REQUEST)).rejects.toThrow(/openai translation failed.*HTTP 404/);
	});

	it('rejects when the answer has no content, reporting finish_reason', async () => {
		respondJson({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });

		await expect(translator().translate(REQUEST)).rejects.toThrow(/no content \(finish_reason=length\)/);
	});

	it('rejects on a timeout', async () => {
		const timeout = new Error('The operation was aborted due to timeout');
		timeout.name = 'TimeoutError';
		fetchMock.mockRejectedValue(timeout);

		await expect(translator().translate(REQUEST)).rejects.toThrow(/timed out after 1000ms/);
	});

	it('works for xai with the same client', async () => {
		respondJson({ choices: [{ message: { content: 'bonjour' } }] });

		const xai = translator({
			name: 'xai',
			url: 'https://api.x.ai/v1/chat/completions',
			apiKey: 'xai-test',
			model: 'grok-4.20-0309-non-reasoning',
		});
		await expect(xai.translate(REQUEST)).resolves.toBe('bonjour');
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
		expect(sentBody().model).toBe('grok-4.20-0309-non-reasoning');
	});
});

describe('GeminiTextTranslator', () => {
	function translator(overrides: Record<string, unknown> = {}) {
		return new GeminiTextTranslator({
			baseUrl: 'https://generativelanguage.googleapis.com',
			apiKey: 'gem-test',
			model: 'gemini-3.5-flash-lite',
			timeoutMs: 1000,
			...overrides,
		});
	}

	it('posts to generateContent with the key in a header, not the URL', async () => {
		respondJson({ candidates: [{ content: { parts: [{ text: 'elle a dit que tout allait bien' }] } }] });

		await expect(translator().translate(REQUEST)).resolves.toBe('elle a dit que tout allait bien');

		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
		);
		expect(sentHeaders()['x-goog-api-key']).toBe('gem-test');
		const body = sentBody();
		expect(body.systemInstruction.parts[0].text).toContain('French (fr)');
		expect(body.contents[0].parts[0].text).toContain('did you check the encoder');
	});

	it('sends no thinking config unless one is set', async () => {
		respondJson({ candidates: [{ content: { parts: [{ text: 'bonjour' }] } }] });

		await translator().translate(REQUEST);

		// The 3.x models reject `thinkingBudget` outright and take `thinkingLevel`, so neither can be
		// sent by default. The default model does no thinking anyway.
		expect(sentBody().generationConfig).not.toHaveProperty('thinkingConfig');
	});

	it('sends thinkingBudget (2.x) or thinkingLevel (3.x) when configured', async () => {
		respondJson({ candidates: [{ content: { parts: [{ text: 'bonjour' }] } }] });
		await translator({ thinkingBudget: 0 }).translate(REQUEST);
		expect(sentBody().generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });

		fetchMock.mockClear();
		respondJson({ candidates: [{ content: { parts: [{ text: 'bonjour' }] } }] });
		await translator({ thinkingLevel: 'low' }).translate(REQUEST);
		expect(sentBody().generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });

		fetchMock.mockClear();
		respondJson({ candidates: [{ content: { parts: [{ text: 'bonjour' }] } }] });
		await translator({ thinkingBudget: -1 }).translate(REQUEST);
		expect(sentBody().generationConfig).not.toHaveProperty('thinkingConfig');
	});

	it('joins multi-part answers', async () => {
		respondJson({ candidates: [{ content: { parts: [{ text: 'elle a ' }, { text: 'dit' }] } }] });

		await expect(translator().translate(REQUEST)).resolves.toBe('elle a dit');
	});

	it('rejects a blocked prompt, reporting the reason', async () => {
		respondJson({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } });

		await expect(translator().translate(REQUEST)).rejects.toThrow(/no content \(SAFETY\)/);
	});

	it('rejects on a non-2xx response', async () => {
		respondJson({ error: { message: 'API key not valid' } }, 400);

		await expect(translator().translate(REQUEST)).rejects.toThrow(/gemini translation failed.*HTTP 400/);
	});
});

describe('GoogleTranslateTextTranslator', () => {
	function translator() {
		return new GoogleTranslateTextTranslator({
			url: 'https://translation.googleapis.com/language/translate/v2',
			apiKey: 'goog-test',
			timeoutMs: 1000,
		});
	}

	it('sends the text, the target and the reported source language', async () => {
		respondJson({ data: { translations: [{ translatedText: 'elle a dit que tout allait bien' }] } });

		await expect(translator().translate(REQUEST)).resolves.toBe('elle a dit que tout allait bien');

		expect(sentHeaders()['X-Goog-Api-Key']).toBe('goog-test');
		expect(sentBody()).toEqual({ q: ['she said it was fine'], target: 'fr', source: 'en', format: 'text' });
	});

	it('omits the source when the backend reported none, so the API detects it', async () => {
		respondJson({ data: { translations: [{ translatedText: 'bonjour' }] } });

		await translator().translate({ ...REQUEST, turn: { text: 'hello' } });

		expect(sentBody()).not.toHaveProperty('source');
	});

	it('sends no history or speaker: the API has no notion of a conversation', async () => {
		respondJson({ data: { translations: [{ translatedText: 'bonjour' }] } });

		await translator().translate(REQUEST);

		const body = JSON.stringify(sentBody());
		expect(body).not.toContain('Speaker');
		expect(body).not.toContain('did you check the encoder');
	});

	it('decodes the HTML entities the v2 API returns', async () => {
		respondJson({ data: { translations: [{ translatedText: 'elle a dit que c&#39;était bien &amp; fini' }] } });

		await expect(translator().translate(REQUEST)).resolves.toBe("elle a dit que c'était bien & fini");
	});

	it('rejects an empty translation', async () => {
		respondJson({ data: { translations: [{ translatedText: '   ' }] } });

		await expect(translator().translate(REQUEST)).rejects.toThrow(/no text/);
	});

	it('rejects on a non-2xx response', async () => {
		respondJson({ error: { message: 'API key not valid' } }, 403);

		await expect(translator().translate(REQUEST)).rejects.toThrow(/google translation failed.*HTTP 403/);
	});

	describe('service-account credentials', () => {
		/** A key that really signs, so the JWT path runs instead of being mocked out. */
		async function credentialsJson() {
			const pair = await crypto.subtle.generateKey(
				{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
				true,
				['sign', 'verify'],
			);
			const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
			let binary = '';
			for (const byte of pkcs8) binary += String.fromCharCode(byte);
			return JSON.stringify({
				type: 'service_account',
				client_email: 'translator@jitsi-test.iam.gserviceaccount.com',
				private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`,
				token_uri: 'https://oauth2.googleapis.com/token',
			});
		}

		it('gets a bearer token and uses it instead of an API key', async () => {
			const credentials = await credentialsJson();
			fetchMock
				.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }) })
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({ data: { translations: [{ translatedText: 'bonjour' }] } }),
					text: async () => '',
				});

			const google = new GoogleTranslateTextTranslator({
				url: 'https://translation.googleapis.com/language/translate/v2',
				credentialsJson: credentials,
				timeoutMs: 1000,
			});
			await expect(google.translate(REQUEST)).resolves.toBe('bonjour');

			expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
			const translateHeaders = fetchMock.mock.calls[1][1].headers;
			expect(translateHeaders.Authorization).toBe('Bearer tok');
			expect(translateHeaders).not.toHaveProperty('X-Goog-Api-Key');
		});

		it('prefers an API key when both are configured, and mints no token', async () => {
			respondJson({ data: { translations: [{ translatedText: 'bonjour' }] } });

			const google = new GoogleTranslateTextTranslator({
				url: 'https://translation.googleapis.com/language/translate/v2',
				apiKey: 'goog-test',
				credentialsJson: await credentialsJson(),
				timeoutMs: 1000,
			});
			await google.translate(REQUEST);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(sentHeaders()['X-Goog-Api-Key']).toBe('goog-test');
		});

		it('fails at construction on malformed credentials, not on the first translation', async () => {
			expect(
				() =>
					new GoogleTranslateTextTranslator({
						url: 'https://translation.googleapis.com/language/translate/v2',
						credentialsJson: 'not json',
						timeoutMs: 1000,
					}),
			).toThrow(/not valid JSON/);
		});

		it('fails at construction when neither credential is configured', () => {
			expect(
				() =>
					new GoogleTranslateTextTranslator({
						url: 'https://translation.googleapis.com/language/translate/v2',
						timeoutMs: 1000,
					}),
			).toThrow(/API key or service-account credentials/);
		});
	});
});
