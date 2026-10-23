/**
 * Message shapes shared between the Worker's container path and the dispatcher forwarding.
 */

/**
 * Dispatcher message format for transcription events
 */
export interface DispatcherTranscriptionMessage {
	sessionId: string;
	endpointId: string;
	text: string;
	timestamp: number;
	language?: string;
}

/**
 * TranscriptionDispatcher service interface
 */
export interface TranscriptionDispatcher {
	fetch(request: Request): Promise<Response>;
}

/**
 * Transcription message from container
 */
export interface TranscriptionMessage {
	type: 'transcription-result' | 'realtime-translation-result';
	is_interim: boolean;
	participant: {
		id?: string;
	};
	transcript: Array<{
		text: string;
	}>;
	timestamp: number;
	language?: string;
}
