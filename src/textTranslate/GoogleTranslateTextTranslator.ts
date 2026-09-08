import { postJson } from './http';
import { parseServiceAccount, ServiceAccountTokenSource } from './googleAuth';
import type { TextTranslationRequest, TextTranslator } from './TextTranslator';

export interface GoogleTranslateConfig {
	/** Full Cloud Translation v2 endpoint. */
	url: string;
	/**
	 * A Google Cloud API key with the Cloud Translation API enabled. A Gemini API key does not work.
	 * Takes precedence over `credentialsJson` when both are set.
	 */
	apiKey?: string;
	/**
	 * A service-account JSON key, as an alternative to `apiKey` — the deployment already has one for
	 * other Google APIs, and it can be scoped to Cloud Translation, which an API key cannot.
	 */
	credentialsJson?: string;
	timeoutMs: number;
}

/**
 * Translator backed by Google Cloud Translation v2 (dedicated neural MT, not an LLM).
 *
 * It is the cheapest and most predictable option — billed per character, one short request per
 * translation, a fixed published language list and no chance of the model answering the line
 * instead of translating it. The trade-off is that the API takes a single string with no notion of
 * a conversation: **`request.history` and speaker labels are ignored**. Use an LLM provider
 * (`openai`, `xai`, `gemini`) when context matters for pronouns, gender or formality.
 *
 * v2 is used rather than v3 because it authenticates with an API key. v3 requires an OAuth2 access
 * token from a service account, which would mean signing JWTs (a new dependency) for no gain here.
 */
export class GoogleTranslateTextTranslator implements TextTranslator {
	private readonly config: GoogleTranslateConfig;
	/** Set when authenticating with a service account instead of an API key. */
	private readonly tokenSource?: ServiceAccountTokenSource;

	constructor(config: GoogleTranslateConfig) {
		this.config = config;
		if (!config.apiKey) {
			if (!config.credentialsJson) {
				throw new Error('google text translation needs either an API key or service-account credentials');
			}
			// Fail here rather than on the first translation: malformed credentials are a configuration
			// error, and the session should say so when the translator is created.
			this.tokenSource = new ServiceAccountTokenSource(
				parseServiceAccount(config.credentialsJson),
				config.timeoutMs,
			);
		}
	}

	async translate(request: TextTranslationRequest): Promise<string> {
		const { url, apiKey, timeoutMs } = this.config;

		const body = {
			q: [request.turn.text],
			target: request.targetLanguage,
			// Let the API detect the source when the backend did not report one. Passing the reported
			// language when we have it is both cheaper for the API and less likely to mis-detect a
			// short utterance.
			...(request.turn.language && { source: request.turn.language }),
			format: 'text',
		};

		let json: any;
		try {
			// X-Goog-Api-Key rather than ?key=, so the key cannot leak into a URL in a log or trace.
			const headers: Record<string, string> = apiKey
				? { 'X-Goog-Api-Key': apiKey }
				: { Authorization: `Bearer ${await this.tokenSource!.getToken()}` };
			json = await postJson(url, body, headers, timeoutMs);
		} catch (error) {
			throw new Error(`google translation failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		const translated = json?.data?.translations?.[0]?.translatedText;
		if (typeof translated !== 'string' || !translated.trim()) {
			throw new Error('google translation returned no text');
		}

		// v2 HTML-escapes some characters even with format=text (an apostrophe comes back as &#39;).
		const text = decodeHtmlEntities(translated).trim();
		if (!text) {
			throw new Error('google translation returned no text');
		}
		return text;
	}
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

/** Decode the named and numeric HTML entities the v2 API emits. */
function decodeHtmlEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith('#')) {
			const codePoint = entity[1] === 'x' || entity[1] === 'X'
				? parseInt(entity.slice(2), 16)
				: parseInt(entity.slice(1), 10);
			return Number.isFinite(codePoint) && codePoint > 0 ? String.fromCodePoint(codePoint) : match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}
