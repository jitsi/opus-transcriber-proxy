export type AudioEncoding = 'opus' | 'ogg-opus';

export interface ISessionParameters {
	url: URL;
	sessionId: string | null;
	connect: string | null;
	useTranscriptionator: boolean;
	useDispatcher: boolean;
	sendBack: boolean;
	sendBackInterim: boolean;
	language: string | null;
	provider: string | null;
	encoding: AudioEncoding;
}

export function extractSessionParameters(url: string): ISessionParameters {
	const parsedUrl = new URL(url);
	const sessionId = parsedUrl.searchParams.get('sessionId');
	const connect = parsedUrl.searchParams.get('connect');
	const useTranscriptionator = parsedUrl.searchParams.get('useTranscriptionator');
	const useDispatcher = parsedUrl.searchParams.get('useDispatcher');
	const sendBack = parsedUrl.searchParams.get('sendBack');
	const sendBackInterim = parsedUrl.searchParams.get('sendBackInterim');
	const lang = parsedUrl.searchParams.get('lang');
	const provider = parsedUrl.searchParams.get('provider');
	const encodingParam = parsedUrl.searchParams.get('encoding');
	// Default to 'opus' (raw opus frames) for backwards compatibility
	const encoding: AudioEncoding = encodingParam === 'ogg-opus' ? 'ogg-opus' : 'opus';

	return {
		url: parsedUrl,
		sessionId,
		connect,
		useTranscriptionator: useTranscriptionator === 'true',
		useDispatcher: useDispatcher === 'true',
		sendBack: sendBack === 'true',
		sendBackInterim: sendBackInterim === 'true',
		language: lang,
		provider,
		encoding,
	};
}

export function getTurnDetectionConfig() {
	// Configuration is loaded from environment variables in config.ts
	// Import dynamically to avoid circular dependencies
	const { config } = require('./config');
	return config.openai.turnDetection;
}
