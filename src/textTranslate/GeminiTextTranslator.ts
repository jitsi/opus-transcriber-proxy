import { postJson } from './http';
import { buildSystemPrompt, buildUserPrompt, sanitizeTranslation } from './prompt';
import type { TextTranslationRequest, TextTranslator } from './TextTranslator';

export interface GeminiTextTranslationConfig {
	/** Base URL of the Generative Language API, without a trailing slash. */
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	/** Sent in `generationConfig` only when set. */
	temperature?: number;
	/**
	 * `generationConfig.thinkingConfig.thinkingBudget`, sent only when set and >= 0.
	 *
	 * This is the 2.x-era control. The 3.x models reject it with HTTP 400 and take
	 * {@link thinkingLevel} instead, so neither is sent unless configured.
	 */
	thinkingBudget?: number;
	/** `generationConfig.thinkingConfig.thinkingLevel` (the 3.x control), sent only when set. */
	thinkingLevel?: string;
}

/**
 * Translator backed by the Gemini API (`generateContent`).
 *
 * Google offers two very different translation paths and this is the LLM one, which takes
 * conversation context. The dedicated-MT one is `GoogleTranslateTextTranslator` (no context, but
 * cheaper per character and with a fixed language list).
 */
export class GeminiTextTranslator implements TextTranslator {
	private readonly config: GeminiTextTranslationConfig;

	constructor(config: GeminiTextTranslationConfig) {
		this.config = config;
	}

	async translate(request: TextTranslationRequest): Promise<string> {
		const { baseUrl, apiKey, model, timeoutMs, temperature, thinkingBudget, thinkingLevel } = this.config;
		const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

		const thinkingConfig: Record<string, unknown> = {
			...(thinkingBudget !== undefined && thinkingBudget >= 0 && { thinkingBudget }),
			...(thinkingLevel !== undefined && { thinkingLevel }),
		};
		const generationConfig: Record<string, unknown> = {
			candidateCount: 1,
			...(temperature !== undefined && { temperature }),
			...(Object.keys(thinkingConfig).length > 0 && { thinkingConfig }),
		};

		const body = {
			systemInstruction: { parts: [{ text: buildSystemPrompt(request.targetLanguage) }] },
			contents: [{ role: 'user', parts: [{ text: buildUserPrompt(request) }] }],
			generationConfig,
		};

		let json: any;
		try {
			// The key goes in a header, not the query string, so it cannot end up in a URL log.
			json = await postJson(url, body, { 'x-goog-api-key': apiKey }, timeoutMs);
		} catch (error) {
			throw new Error(`gemini translation failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		const candidate = json?.candidates?.[0];
		const text: string = (candidate?.content?.parts ?? [])
			.map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
			.join('');

		if (!text) {
			// A blocked prompt or an exhausted token budget both land here; report which.
			const reason = json?.promptFeedback?.blockReason ?? candidate?.finishReason;
			throw new Error(`gemini translation returned no content${reason ? ` (${reason})` : ''}`);
		}
		return sanitizeTranslation(text, request);
	}
}
