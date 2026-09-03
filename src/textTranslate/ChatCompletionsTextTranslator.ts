import { postJson } from './http';
import { buildSystemPrompt, buildUserPrompt, sanitizeTranslation } from './prompt';
import type { TextTranslationRequest, TextTranslator } from './TextTranslator';

export interface ChatCompletionsConfig {
	/** Provider name, for log messages only. */
	name: string;
	/** Full chat-completions URL, e.g. https://api.openai.com/v1/chat/completions. */
	url: string;
	apiKey: string;
	model: string;
	timeoutMs: number;
	/**
	 * Sent only when set. Left unset by default so each model's own default applies: the GPT-5 and
	 * Grok 4 families reject a `temperature` other than 1.
	 */
	temperature?: number;
	/**
	 * Sent as `reasoning_effort` only when set. A reasoning model spends latency and tokens on a
	 * task that needs none, so 'low' (OpenAI also accepts 'minimal') is worth setting when the
	 * configured model reasons by default.
	 */
	reasoningEffort?: string;
	/**
	 * Sent as `max_completion_tokens` only when set. Deliberately unset by default: on a reasoning
	 * model a small cap is spent on reasoning tokens and the call returns empty content.
	 */
	maxOutputTokens?: number;
}

/**
 * Translator for any OpenAI-shaped `/chat/completions` API — used for both `openai` and `xai`,
 * which differ only in URL, key and model.
 */
export class ChatCompletionsTextTranslator implements TextTranslator {
	private readonly config: ChatCompletionsConfig;

	constructor(config: ChatCompletionsConfig) {
		this.config = config;
	}

	async translate(request: TextTranslationRequest): Promise<string> {
		const { name, url, apiKey, model, timeoutMs, temperature, reasoningEffort, maxOutputTokens } = this.config;

		const body: Record<string, unknown> = {
			model,
			messages: [
				{ role: 'system', content: buildSystemPrompt(request.targetLanguage) },
				{ role: 'user', content: buildUserPrompt(request) },
			],
			...(temperature !== undefined && { temperature }),
			...(reasoningEffort !== undefined && { reasoning_effort: reasoningEffort }),
			...(maxOutputTokens !== undefined && { max_completion_tokens: maxOutputTokens }),
		};

		let json: any;
		try {
			json = await postJson(url, body, { Authorization: `Bearer ${apiKey}` }, timeoutMs);
		} catch (error) {
			throw new Error(`${name} translation failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		const content = messageContent(json?.choices?.[0]?.message?.content);
		if (!content) {
			const finishReason = json?.choices?.[0]?.finish_reason;
			throw new Error(
				`${name} translation returned no content${finishReason ? ` (finish_reason=${finishReason})` : ''}`,
			);
		}
		return sanitizeTranslation(content, request);
	}
}

/**
 * The content of an assistant message as a string.
 *
 * `content` is a string on OpenAI and xAI today, but the same field is specified as an array of
 * typed parts, and a reasoning model can put its answer in a later part, so handle both.
 */
function messageContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
			.join('');
	}
	return '';
}
