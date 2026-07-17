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

	// Speaker-identity feature (single-mic multi-speaker attribution via the identity sidecar).
	// Master kill switch: when disabled, transcription behaviour is unchanged.
	identity: {
		enabled: process.env.IDENTITY_ENABLED === 'true', // Default false — feature flag
		sidecarUrl: process.env.IDENTITY_SIDECAR_URL || '', // e.g. http://identity-sidecar:8090
		sidecarToken: process.env.IDENTITY_SIDECAR_TOKEN || '',
		// Tenant scoping for enroll/identify. Placeholder default until per-customer identity
		// is resolved from the WEBHOOK_EVENTS KV (a later step); fine for single-tenant testing.
		tenant: process.env.IDENTITY_TENANT || 'default',
		// /analyze runs offline diarization (several seconds) — the timeout must exceed it.
		timeoutMs: parseIntOrDefault(process.env.IDENTITY_TIMEOUT_MS, 30000),
		maxInFlight: parseIntOrDefault(process.env.IDENTITY_MAX_INFLIGHT, 8),
		holdMs: parseIntOrDefault(process.env.IDENTITY_HOLD_MS, 3000), // hold a room final until identity resolves
		analyzeIntervalMs: parseIntOrDefault(process.env.IDENTITY_ANALYZE_INTERVAL_MS, 4000),
		// Rolling context sent to /analyze per final (seconds ending at the utterance end).
		// Larger = more consistent diarization/clustering across utterances (stable handles), but slower.
		analyzeWindowSec: parseIntOrDefault(process.env.IDENTITY_ANALYZE_WINDOW_SEC, 45),
		// Real per-customer identity + tenant from the WEBHOOK_EVENTS KV (via CF KV REST API).
		// Unset → no source: falls back to the `tenant` default above and skips auto-enroll.
		kvAccountId: process.env.IDENTITY_KV_ACCOUNT_ID || '',
		kvNamespaceId: process.env.IDENTITY_KV_NAMESPACE_ID || '',
		kvApiToken: process.env.IDENTITY_KV_API_TOKEN || '',
		// Auto-enrollment from normal (single-speaker) streams — quality-gated + rate-limited.
		enrollMinSpeechSec: parseIntOrDefault(process.env.IDENTITY_ENROLL_MIN_SPEECH_SEC, 8),
		enrollCooldownMs: parseIntOrDefault(process.env.IDENTITY_ENROLL_COOLDOWN_MS, 20000),
		maxEnrollsPerSession: parseIntOrDefault(process.env.IDENTITY_MAX_ENROLLS_PER_SESSION, 10),
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
