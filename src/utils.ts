export interface ISessionParameters {
	url: URL;
	sessionId: string | null;
	transcribe: boolean;
	connect: string | null;
	useTranscriptionator: boolean;
	useDispatcher: boolean;
	sendBack: boolean;
	sendBackInterim: boolean;
	language: string | null;
	provider: string | null;
}

export function extractSessionParameters(url: string): ISessionParameters {
	const parsedUrl = new URL(url);
	const sessionId = parsedUrl.searchParams.get('sessionId');
	const transcribe = parsedUrl.pathname.endsWith('/transcribe');
	const connect = parsedUrl.searchParams.get('connect');
	const useTranscriptionator = parsedUrl.searchParams.get('useTranscriptionator');
	const useDispatcher = parsedUrl.searchParams.get('useDispatcher');
	const sendBack = parsedUrl.searchParams.get('sendBack');
	const sendBackInterim = parsedUrl.searchParams.get('sendBackInterim');
	const lang = parsedUrl.searchParams.get('lang');
	const provider = parsedUrl.searchParams.get('provider');

	return {
		url: parsedUrl,
		sessionId,
		transcribe,
		connect,
		useTranscriptionator: useTranscriptionator === 'true',
		useDispatcher: useDispatcher === 'true',
		sendBack: sendBack === 'true',
		sendBackInterim: sendBackInterim === 'true',
		language: lang,
		provider,
	};
}

export function getTurnDetectionConfig() {
	// Configuration is loaded from environment variables in config.ts
	// Import dynamically to avoid circular dependencies
	const { config } = require('./config');
	return config.openai.turnDetection;
}
