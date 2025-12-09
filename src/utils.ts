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

	return {
		url: parsedUrl,
		sessionId,
		transcribe,
		connect,
		useTranscriptionator: useTranscriptionator === 'true',
		useDispatcher: useDispatcher === 'true',
		sendBack: sendBack === 'true',
		sendBackInterim: sendBackInterim === 'true',
		language: lang
	};
}

export function getTurnDetectionConfig(env: Env) {
	const defaultTurnDetection = {
		type: 'server_vad',
		threshold: 0.5,
		prefix_padding_ms: 300,
		silence_duration_ms: 500,
	};

	if (env.OPENAI_TURN_DETECTION) {
		try {
			return JSON.parse(env.OPENAI_TURN_DETECTION);
		} catch (error) {
			console.warn(`Invalid OPENAI_TURN_DETECTION JSON, using defaults: ${error}`);
			return defaultTurnDetection;
		}
	}

	return defaultTurnDetection;
}
