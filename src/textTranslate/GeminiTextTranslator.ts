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
	 * `generationConfig.thinkingConfig.thinkingBudget`, sent only when >= 0. Defaults to 0
	 * (thinking off) at the config layer: translation needs no reasoning, and thinking costs
	 * latency and output tokens. Set it to -1 to omit the field — required for models that cannot
	 * turn thinking off (the Pro tier), which reject a budget of 0.
	 */
	thinkingBudget?: number;
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
		const { baseUrl, apiKey, model, timeoutMs, temperature, thinkingBudget } = this.config;
		const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

		const generationConfig: Record<string, unknown> = {
			candidateCount: 1,
			...(temperature !== undefined && { temperature }),
			...(thinkingBudget !== undefined && thinkingBudget >= 0 && { thinkingConfig: { thinkingBudget } }),
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
