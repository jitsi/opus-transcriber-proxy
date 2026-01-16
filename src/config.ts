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

export const config = {
	// Backend selection
	transcriptionBackend: (process.env.TRANSCRIPTION_BACKEND || 'openai') as 'openai' | 'gemini' | 'deepgram' | 'dummy',

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
} as const;

// Validate required config based on selected backend
if (config.transcriptionBackend === 'openai' && !config.openai.apiKey) {
	throw new Error('OPENAI_API_KEY environment variable is required when using OpenAI backend');
}

if (config.transcriptionBackend === 'gemini' && !config.gemini.apiKey) {
	throw new Error('GEMINI_API_KEY environment variable is required when using Gemini backend');
}

if (config.transcriptionBackend === 'deepgram' && !config.deepgram.apiKey) {
	throw new Error('DEEPGRAM_API_KEY environment variable is required when using Deepgram backend');
}

if (config.transcriptionBackend !== 'openai' && config.transcriptionBackend !== 'gemini' && config.transcriptionBackend !== 'deepgram' && config.transcriptionBackend !== 'dummy') {
	throw new Error(`Invalid TRANSCRIPTION_BACKEND: ${config.transcriptionBackend}. Must be 'openai', 'gemini', 'deepgram', or 'dummy'`);
}
