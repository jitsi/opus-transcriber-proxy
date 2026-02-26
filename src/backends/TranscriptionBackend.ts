/**
 * Abstract interface for transcription backends
 *
 * This interface defines the contract that all transcription backends must implement.
 * Backends are responsible for:
 * - Establishing a connection to the transcription service
 * - Sending audio data for transcription
 * - Receiving transcription results (interim and final)
 * - Managing the connection lifecycle
 */

import type { TranscriptionMessage } from '../transcriberproxy';
import type { AudioEncoding } from '../utils';

export interface AudioFormat {
	encoding: string;
	channels?: number;
	sampleRate?: number;
}

const VALID_INPUT_ENCODINGS = ['opus', 'ogg-opus', 'L16'] as const;

/**
 * Validates that an unknown value is a well-formed AudioFormat suitable for use
 * as a client-supplied input format (i.e. the mediaFormat field of a start event).
 * Throws a descriptive Error if validation fails.
 */
export function validateAudioFormat(format: unknown): AudioFormat {
	if (format === null || typeof format !== 'object') {
		throw new Error(`mediaFormat must be an object, got: ${JSON.stringify(format)}`);
	}

	const { encoding, channels, sampleRate } = format as Record<string, unknown>;

	if (typeof encoding !== 'string' || encoding === '') {
		throw new Error(`mediaFormat.encoding must be a non-empty string, got: ${JSON.stringify(encoding)}`);
	}

	if (!(VALID_INPUT_ENCODINGS as readonly string[]).includes(encoding)) {
		throw new Error(`mediaFormat.encoding must be one of [${VALID_INPUT_ENCODINGS.join(', ')}], got: ${JSON.stringify(encoding)}`);
	}

	if (channels !== undefined && (!Number.isInteger(channels) || (channels as number) <= 0)) {
		throw new Error(`mediaFormat.channels must be a positive integer, got: ${JSON.stringify(channels)}`);
	}

	if (sampleRate !== undefined && (typeof sampleRate !== 'number' || sampleRate <= 0)) {
		throw new Error(`mediaFormat.sampleRate must be a positive number, got: ${JSON.stringify(sampleRate)}`);
	}

	return format as AudioFormat;
}

export interface BackendConfig {
	/** Language hint for transcription (null = auto-detect) */
	language: string | null;
	/** Custom prompt/instructions for the transcription model */
	prompt?: string;
	/** Model to use for transcription */
	model?: string;
	/** Audio encoding format ('opus' for raw frames, 'ogg-opus' for containerized) */
	encoding?: AudioEncoding;
	/** Tags to be sent to the backend (e.g., for Deepgram) */
	tags?: string[];
}

export interface TranscriptionBackend {
	/**
	 * Initialize the backend connection
	 * @param config - Backend-specific configuration
	 * @returns Promise that resolves when connection is established
	 */
	connect(config: BackendConfig): Promise<void>;

	/**
	 * Send base64-encoded audio data to the backend
	 * Audio format is determined by getDesiredAudioFormat(): PCM (L16) or raw Opus/Ogg
	 * @param audioBase64 - Base64-encoded audio
	 */
	sendAudio(audioBase64: string): Promise<void>;

	/**
	 * Returns the audio format this backend wants to receive for a given input format.
	 * Backends that support raw Opus will mirror the input encoding ('opus' or 'ogg').
	 * All other backends request decoded PCM: encoding 'L16' at 24000 Hz.
	 * @param inputFormat - The audio format being provided by the client
	 * @returns The audio format this backend wants to receive
	 */
	getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat;

	/**
	 * Force the backend to commit/finalize pending audio and generate transcription
	 * Used when audio stream goes idle
	 */
	forceCommit(): void;

	/**
	 * Update the transcription prompt with additional context
	 * @param prompt - New prompt text (may include transcript history)
	 */
	updatePrompt(prompt: string): void;

	/**
	 * Close the backend connection
	 */
	close(): void;

	/**
	 * Get the current connection status
	 */
	getStatus(): 'pending' | 'connected' | 'failed' | 'closed';

	// Event callbacks - set by OutgoingConnection
	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string) => void;
	onClosed?: () => void;
}
