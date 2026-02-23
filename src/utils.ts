export type AudioEncoding = 'opus' | 'ogg-opus';

export interface ISessionParameters {
	url: URL;
	sessionId: string | null;
	connect: string | null;
	useDispatcher: boolean;
	sendBack: boolean;
	sendBackInterim: boolean;
	language: string | null;
	provider: string | null;
	encoding: AudioEncoding;
	tags: string[];
}

/**
 * Validates tags according to Deepgram requirements.
 * Tags must be ≤ 128 characters per tag.
 * @see https://developers.deepgram.com/docs/stt-tagging
 * @throws Error if any tag is invalid
 */
export function validateTags(tags: string[]): void {
	const maxTagLength = 128;

	for (const tag of tags) {
		if (tag.length > maxTagLength) {
			throw new Error(
				`Invalid tag: "${tag.substring(0, 50)}..." exceeds maximum length of ${maxTagLength} characters (actual: ${tag.length})`
			);
		}
	}
}

export function extractSessionParameters(url: string): ISessionParameters {
	const parsedUrl = new URL(url);
	const sessionId = parsedUrl.searchParams.get('sessionId');
	const connect = parsedUrl.searchParams.get('connect');
	const useDispatcher = parsedUrl.searchParams.get('useDispatcher');
	const sendBack = parsedUrl.searchParams.get('sendBack');
	const sendBackInterim = parsedUrl.searchParams.get('sendBackInterim');
	const lang = parsedUrl.searchParams.get('lang');
	const provider = parsedUrl.searchParams.get('provider');
	const encodingParam = parsedUrl.searchParams.get('encoding');
	// Default to 'opus' (raw opus frames) for backwards compatibility
	const encoding: AudioEncoding = encodingParam === 'ogg-opus' ? 'ogg-opus' : 'opus';
	// Parse tags as multiple tag= parameters (like Deepgram API)
	const tags = parsedUrl.searchParams.getAll('tag');

	// Validate tags according to provider requirements (Deepgram: ≤ 128 chars)
	validateTags(tags);

	return {
		url: parsedUrl,
		sessionId,
		connect,
		useDispatcher: useDispatcher === 'true',
		sendBack: sendBack === 'true',
		sendBackInterim: sendBackInterim === 'true',
		language: lang,
		provider,
		encoding,
		tags,
	};
}

export function getTurnDetectionConfig() {
	// Configuration is loaded from environment variables in config.ts
	// Import dynamically to avoid circular dependencies
	const { config } = require('./config');
	return config.openai.turnDetection;
}
