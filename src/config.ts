import dotenv from 'dotenv';
import { validateTags } from './utils';

// Load environment variables from .env file
dotenv.config();

function parseIntOrDefault(value: string | undefined, defaultValue: number): number {
	if (!value) return defaultValue;
	const parsed = parseInt(value, 10);
	return isNaN(parsed) ? defaultValue : parsed;
}

function parseJsonOrDefault<T>(value: string | undefined, defaultValue: T): T {
	if (!value) return defaultValue;
	try {
		return JSON.parse(value) as T;
	} catch {
		return defaultValue;
	}
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined || value === '') return undefined;
	const parsed = parseInt(value, 10);
	return isNaN(parsed) ? undefined : parsed;
}

function parseFloatOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined || value === '') return undefined;
	const parsed = parseFloat(value);
	return isNaN(parsed) ? undefined : parsed;
}

function parseAndValidateTags(value: string | undefined): string[] {
	if (!value) return [];
	const tags = value.split(',').map((t) => t.trim()).filter((t) => t);
	validateTags(tags);
	return tags;
}

export type Provider = 'openai' | 'openai_custom' | 'gemini' | 'deepgram' | 'xai' | 'dummy';

export const config = {
	// Provider priority list (comma-separated, first available is default)
	// Example: "openai,gemini,deepgram" means try openai first, then gemini, then deepgram
	providersPriority: (process.env.PROVIDERS_PRIORITY || 'openai,deepgram,gemini').split(',').map((p) => p.trim()) as Provider[],

	// Enable dummy provider (for testing/statistics only)
	enableDummyProvider: process.env.ENABLE_DUMMY_PROVIDER === 'true',

	// Enable openai_custom provider (credentials come per-request via URL param + header)
	enableOpenAICustomProvider: process.env.ENABLE_OPENAI_CUSTOM_PROVIDER === 'true',

	// Require wss:// for openai_custom provider URL (default true; set to false to allow ws://)
	openaiCustomRequireWss: process.env.OPENAI_CUSTOM_REQUIRE_WSS !== 'false',

	// Opus codec backend: 'wasm' (Emscripten, default; required when running in a Worker) or
	// 'native' (libopus N-API addon, container-only — faster, needs the compiled .node addon).
	opus: {
		backend: (process.env.OPUS_BACKEND === 'native' ? 'native' : 'wasm') as 'native' | 'wasm',
	},

	// OpenAI configuration
	openai: {
		apiKey: process.env.OPENAI_API_KEY || '',
		model: process.env.OPENAI_MODEL || 'gpt-4o-mini-transcribe',
		transcriptionPrompt: process.env.OPENAI_TRANSCRIPTION_PROMPT || undefined,
		turnDetection: parseJsonOrDefault(process.env.OPENAI_TURN_DETECTION, {
			type: 'server_vad',
			threshold: 0.5,
			prefix_padding_ms: 300,
			silence_duration_ms: 300,
		}),
	},

	// Gemini configuration
	gemini: {
		apiKey: process.env.GEMINI_API_KEY || '',
		model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp',
		transcriptionPrompt: process.env.GEMINI_TRANSCRIPTION_PROMPT || undefined,
	},

	// xAI configuration
	xai: {
		apiKey: process.env.XAI_API_KEY || '',
		sttUrl: process.env.XAI_STT_URL || 'wss://api.x.ai/v1/stt',
		language: process.env.XAI_LANGUAGE || undefined,
		diarize: process.env.XAI_DIARIZE === 'true',
		includeLanguage: process.env.XAI_INCLUDE_LANGUAGE === 'true',
		// Silence-based finalization — the right finalizer for our one-stream-per-
		// participant topology (no speaker turns to detect). Default 850ms (tuned with
		// jitsi/skynet STT); xAI's own default (10ms) is far too choppy. Overridable
		// per-connection via the `endpointing` URL param.
		endpointing: parseIntOrDefault(process.env.XAI_ENDPOINTING, 850),
		// smart_turn is end-of-turn detection for a MULTI-speaker single stream. We run
		// one WS per participant, so there are no turns — it just holds finals across
		// mid-sentence pauses, producing very long chunks. Disabled by default
		// (undefined = not sent); opt in via XAI_SMART_TURN or the `smart_turn` URL param.
		smartTurn: process.env.XAI_SMART_TURN !== undefined ? parseFloat(process.env.XAI_SMART_TURN) : undefined,
		smartTurnTimeout: parseIntOrDefault(process.env.XAI_SMART_TURN_TIMEOUT, 500),
		// Consumer-side "roll-own" granular finalization. xAI commits a final only on its
		// end-of-turn speech_final (the whole turn at once), so a long turn's text lands AFTER
		// other speakers' short acks in the stored transcript (the GT-meeting ordering bug). When
		// enabled, we instead commit a STABLE PREFIX of xAI's growing hypothesis incrementally so
		// the turn interleaves in order. Off by default — it is a behavioral change from the
		// deliberate one-final-per-turn model, so it ships behind a flag for A/B. Defaults tuned
		// live (see unreal-agents/experiments/xai-vs-deepgram-finalization): a ~1000ms stability
		// window with 3 guard words drives the word-revision cost to ~0 while first commit stays
		// ~3s (well under Deepgram's ~5s) and ordering is preserved. Overridable per-connection via
		// the `xai_granular_finals` / `xai_granular_stability_ms` / `xai_granular_guard_words`
		// URL params.
		granularFinals: process.env.XAI_GRANULAR_FINALS === 'true', // Default false
		granularStabilityMs: parseIntOrDefault(process.env.XAI_GRANULAR_STABILITY_MS, 1000),
		granularGuardWords: parseIntOrDefault(process.env.XAI_GRANULAR_GUARD_WORDS, 3),
		granularMinWords: parseIntOrDefault(process.env.XAI_GRANULAR_MIN_WORDS, 5),
	},

	// Deepgram configuration
	deepgram: {
		apiKey: process.env.DEEPGRAM_API_KEY || '',
		model: process.env.DEEPGRAM_MODEL || 'nova-2',
		language: process.env.DEEPGRAM_LANGUAGE || 'multi',
		encoding: (process.env.DEEPGRAM_ENCODING || 'opus') as 'opus' | 'linear16',
		punctuate: process.env.DEEPGRAM_PUNCTUATE === 'true',
		diarize: process.env.DEEPGRAM_DIARIZE === 'true',
		includeLanguage: process.env.DEEPGRAM_INCLUDE_LANGUAGE === 'true', // Default false
		mipOptOut: process.env.DEEPGRAM_MIP_OPT_OUT === 'true', // Default false; opt out of Model Improvement Program
		tags: parseAndValidateTags(process.env.DEEPGRAM_TAGS),
	},

	// Endpoint enablement (per container/worker). Both default true.
	enableTranscribe: process.env.ENABLE_TRANSCRIBE !== 'false',
	enableTranslate: process.env.ENABLE_TRANSLATE !== 'false',

	// Text translation: translate each final transcript into the target languages the bridge
	// requests in the `sources` control event. Distinct from the /translate endpoint, which is
	// speech-to-speech. Disabled by default; requested languages are ignored while it is off.
	textTranslation: {
		enabled: process.env.ENABLE_TEXT_TRANSLATION === 'true',

		// Priority order for choosing the translator, same semantics as PROVIDERS_PRIORITY for
		// transcription: the first entry that is available (its API key is set) becomes the default,
		// and a connection can override it with the `text_translation_provider` URL parameter.
		// LLM-first by default: those take conversation context, which a bare sentence often needs
		// for pronouns, gender and formality. `google` (dedicated MT) is cheaper per character but
		// context-free, so it is last.
		providersPriority: (process.env.TEXT_TRANSLATION_PROVIDERS_PRIORITY || 'openai,gemini,xai,google')
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p),

		// The 'stub' translator does not translate: it puts the target language before the text
		// ("hello" -> "[FR] hello") so the signalling path can be exercised with no provider. Like
		// the dummy transcription provider it is available only when explicitly enabled, so it can
		// never be picked up in a deployment that simply has no keys.
		enableStub: process.env.ENABLE_TEXT_TRANSLATION_STUB === 'true',

		// How many past finals of the session to pass as context, and a cap on their total size so
		// a long meeting cannot grow the prompt without bound. 0 turns disables context entirely.
		historyTurns: parseIntOrDefault(process.env.TEXT_TRANSLATION_HISTORY_TURNS, 6),
		historyMaxChars: parseIntOrDefault(process.env.TEXT_TRANSLATION_HISTORY_MAX_CHARS, 2000),

		// Whether to tell the translator who spoke each turn, as a synthetic per-session label
		// ("Speaker 1"). It helps the model tell a reply from a continuation. Labels are prompt-only
		// and are stripped from the output; set this to false to keep them out of the request too.
		includeSpeakers: process.env.TEXT_TRANSLATION_INCLUDE_SPEAKERS !== 'false',

		// Per-request timeout. A translation that takes longer than this is dropped: the original
		// transcript is already on the wire, and a very late subtitle is worse than none.
		timeoutMs: parseIntOrDefault(process.env.TEXT_TRANSLATION_TIMEOUT_MS, 10000),

		// LLM knobs shared by the openai/xai/gemini translators. All unset by default so each
		// model's own default applies — notably, the GPT-5 and Grok 4 families reject a
		// `temperature` other than 1, and a `max_completion_tokens` cap on a reasoning model can be
		// spent entirely on reasoning tokens, returning empty content.
		temperature: parseFloatOrUndefined(process.env.TEXT_TRANSLATION_TEMPERATURE),
		reasoningEffort: process.env.TEXT_TRANSLATION_REASONING_EFFORT || undefined,
		maxOutputTokens: parseIntOrUndefined(process.env.TEXT_TRANSLATION_MAX_OUTPUT_TOKENS),

		// Each provider's key defaults to the key that provider already uses for transcription, so a
		// deployment gets translation without new configuration. Set the dedicated variable to bill
		// translation separately or to use a key with different scopes.
		openai: {
			apiKey: process.env.TEXT_TRANSLATION_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
			url: process.env.TEXT_TRANSLATION_OPENAI_URL || 'https://api.openai.com/v1/chat/completions',
			// Measured against the real API with the production prompt: ~0.5-0.9s per translation and
			// no reasoning tokens. gpt-5-nano spends ~750 reasoning tokens on the same prompt (~6s),
			// so it is a poor default despite the lower per-token price.
			model: process.env.TEXT_TRANSLATION_OPENAI_MODEL || 'gpt-4o-mini',
		},
		xai: {
			apiKey: process.env.TEXT_TRANSLATION_XAI_API_KEY || process.env.XAI_API_KEY || '',
			url: process.env.TEXT_TRANSLATION_XAI_URL || 'https://api.x.ai/v1/chat/completions',
			// The non-reasoning variant, for the same reason: the reasoning Grok 4 models spend
			// hundreds of reasoning tokens (3-17s measured) to translate one sentence.
			model: process.env.TEXT_TRANSLATION_XAI_MODEL || 'grok-4.20-0309-non-reasoning',
		},
		gemini: {
			apiKey: process.env.TEXT_TRANSLATION_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
			baseUrl: process.env.TEXT_TRANSLATION_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
			// Measured against the live API: ~0.5-0.7s per translation with no thinking tokens. The
			// 2.5 models the API still lists are refused for new keys ("no longer available to new
			// users"), so the default has to be a 3.x one.
			model: process.env.TEXT_TRANSLATION_GEMINI_MODEL || 'gemini-3.5-flash-lite',
			// Thinking controls, both unset by default and sent only when configured, because the two
			// model generations disagree about them: the 3.x models reject `thinkingBudget` outright
			// (HTTP 400) and take `thinkingLevel` instead, while 2.x takes only `thinkingBudget`.
			// Sending neither is right for the default model, which does no thinking anyway.
			thinkingBudget: parseIntOrUndefined(process.env.TEXT_TRANSLATION_GEMINI_THINKING_BUDGET),
			thinkingLevel: process.env.TEXT_TRANSLATION_GEMINI_THINKING_LEVEL || undefined,
		},
		google: {
			// Cloud Translation v2. Deliberately NO fallback to GEMINI_API_KEY: this is a different
			// API (translation.googleapis.com) and a Gemini/AI Studio key is not valid for it, so
			// falling back would make the provider look configured and then fail every request.
			apiKey: process.env.TEXT_TRANSLATION_GOOGLE_API_KEY || '',
			// The alternative to an API key: a service-account JSON key, which v2 also accepts (as an
			// OAuth2 bearer token). Falls back to the deployment's existing GOOGLE_CREDENTIALS_JSON,
			// so a deployment that already has a service account needs no new credential. Verified
			// against the live API: v2 works with a service-account token where v3 needs an extra IAM
			// permission. With neither this nor the API key set, the provider is unavailable and the
			// priority list skips it.
			credentialsJson:
				process.env.TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON || process.env.GOOGLE_CREDENTIALS_JSON || '',
			url: process.env.TEXT_TRANSLATION_GOOGLE_URL || 'https://translation.googleapis.com/language/translate/v2',
		},
	},

	// Translation (/translate endpoint) configuration
	translation: {
		// Emit target-language transcript messages from the /translate path (to sendBack clients
		// and, when enabled, the dispatcher). Default true; set TRANSLATE_TRANSCRIPTS=false to
		// produce translated audio only.
		transcripts: process.env.TRANSLATE_TRANSCRIPTS !== 'false',
		// OpenAI speech-to-speech translation model (the /v1/realtime/translations endpoint).
		model: process.env.OPENAI_TRANSLATION_MODEL || 'gpt-realtime-translate',
		// API key for translation. Defaults to OPENAI_API_KEY; set OPENAI_TRANSLATION_API_KEY to use a
		// separate key/quota for translation (the realtime translate endpoint can be billed separately).
		apiKey: process.env.OPENAI_TRANSLATION_API_KEY || process.env.OPENAI_API_KEY || '',
		// Endpoint for live-translation audio-duration usage reports. Unset → reporting is a no-op.
		usageUrl: process.env.TRANSLATION_USAGE_URL || '',
	},

	server: {
		port: parseIntOrDefault(process.env.PORT, 8080),
		host: process.env.HOST || '0.0.0.0',
	},
	forceCommitTimeout: parseIntOrDefault(process.env.FORCE_COMMIT_TIMEOUT, 2),
	broadcastTranscripts: process.env.BROADCAST_TRANSCRIPTS === 'true',
	broadcastTranscriptsMaxSize: parseIntOrDefault(process.env.BROADCAST_TRANSCRIPTS_MAX_SIZE, 5 * 1024), // Default 5 KB
	dumpWebSocketMessages: process.env.DUMP_WEBSOCKET_MESSAGES === 'true',
	dumpTranscripts: process.env.DUMP_TRANSCRIPTS === 'true',
	dumpBasePath: process.env.DUMP_BASE_PATH || '/tmp',
	logLevel: process.env.LOG_LEVEL || 'info',
	debug: process.env.DEBUG === 'true',
	useDispatcher: process.env.USE_DISPATCHER === 'true',

	// Dispatcher WebSocket configuration (for Node.js deployment)
	dispatcher: {
		wsUrl: process.env.DISPATCHER_WS_URL || '', // e.g., wss://dispatcher.example.com/ws
		headers: parseJsonOrDefault<Record<string, string>>(process.env.DISPATCHER_HEADERS, {}), // e.g., {"Authorization": "Bearer xxx"}
	},

	// Session resumption configuration
	sessionResumeEnabled: process.env.SESSION_RESUME_ENABLED !== 'false', // Default true
	sessionResumeGracePeriod: parseIntOrDefault(process.env.SESSION_RESUME_GRACE_PERIOD, 15), // seconds

	// OpenTelemetry configuration (container only)
	// Telemetry is disabled if OTLP_ENDPOINT is not set
	otlp: {
		endpoint: process.env.OTLP_ENDPOINT || '', // OTLP HTTP endpoint
		env: process.env.OTLP_ENV || '', // Environment label (e.g., dev, staging, prod)
		exportIntervalMs: parseIntOrDefault(process.env.OTLP_EXPORT_INTERVAL_MS, 60000), // Default 60s
		// Additional resource attributes as JSON
		resourceAttributes: parseJsonOrDefault<Record<string, string>>(process.env.OTLP_RESOURCE_ATTRIBUTES, {}),
		// Custom headers for authentication (e.g., CF Zero Trust, API keys)
		headers: parseJsonOrDefault<Record<string, string>>(process.env.OTLP_HEADERS, {}),
	},
} as const;

/**
 * Check if a provider is available (has all required configuration)
 */
export function isProviderAvailable(provider: Provider): boolean {
	switch (provider) {
		case 'openai':
			return !!config.openai.apiKey;
		case 'openai_custom':
			return config.enableOpenAICustomProvider;
		case 'gemini':
			return !!config.gemini.apiKey;
		case 'deepgram':
			return !!config.deepgram.apiKey;
		case 'xai':
			return !!config.xai.apiKey;
		case 'dummy':
			return config.enableDummyProvider; // Dummy only available if explicitly enabled
		default:
			return false;
	}
}

/**
 * Get all available providers
 */
export function getAvailableProviders(): Provider[] {
	const allProviders: Provider[] = ['openai', 'openai_custom', 'gemini', 'deepgram', 'xai', 'dummy'];
	return allProviders.filter(isProviderAvailable);
}

/**
 * Get the default provider based on PROVIDERS_PRIORITY
 * Returns the first available provider from the priority list
 */
export function getDefaultProvider(): Provider | null {
	for (const provider of config.providersPriority) {
		if (isProviderAvailable(provider)) {
			return provider;
		}
	}
	return null;
}

/**
 * Validate that a provider name is valid
 */
export function isValidProvider(provider: string): provider is Provider {
	return provider === 'openai' || provider === 'openai_custom' || provider === 'gemini' || provider === 'deepgram' || provider === 'xai' || provider === 'dummy';
}
