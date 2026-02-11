import dotenv from 'dotenv';

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

export type Provider = 'openai' | 'gemini' | 'deepgram' | 'dummy';

export const config = {
	// Provider priority list (comma-separated, first available is default)
	// Example: "openai,gemini,deepgram" means try openai first, then gemini, then deepgram
	providersPriority: (process.env.PROVIDERS_PRIORITY || 'openai,deepgram,gemini').split(',').map((p) => p.trim()) as Provider[],

	// Enable dummy provider (for testing/statistics only)
	enableDummyProvider: process.env.ENABLE_DUMMY_PROVIDER === 'true',

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

	// Deepgram configuration
	deepgram: {
		apiKey: process.env.DEEPGRAM_API_KEY || '',
		model: process.env.DEEPGRAM_MODEL || 'nova-2',
		language: process.env.DEEPGRAM_LANGUAGE || 'multi',
		encoding: (process.env.DEEPGRAM_ENCODING || 'linear16') as 'opus' | 'linear16',
		punctuate: process.env.DEEPGRAM_PUNCTUATE === 'true',
		diarize: process.env.DEEPGRAM_DIARIZE === 'true',
		includeLanguage: process.env.DEEPGRAM_INCLUDE_LANGUAGE === 'true', // Default false
		tags: process.env.DEEPGRAM_TAGS ? process.env.DEEPGRAM_TAGS.split(',').map((t) => t.trim()).filter((t) => t) : [],
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
	},
} as const;

/**
 * Check if a provider is available (has all required configuration)
 */
export function isProviderAvailable(provider: Provider): boolean {
	switch (provider) {
		case 'openai':
			return !!config.openai.apiKey;
		case 'gemini':
			return !!config.gemini.apiKey;
		case 'deepgram':
			return !!config.deepgram.apiKey;
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
	const allProviders: Provider[] = ['openai', 'gemini', 'deepgram', 'dummy'];
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
	return provider === 'openai' || provider === 'gemini' || provider === 'deepgram' || provider === 'dummy';
}
