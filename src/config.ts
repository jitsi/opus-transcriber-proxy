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
	debug: process.env.DEBUG === 'true',
} as const;

// Validate required config
if (!config.openai.apiKey) {
	throw new Error('OPENAI_API_KEY environment variable is required');
}
