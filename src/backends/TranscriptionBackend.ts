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
	sampleRate?: number;
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
	 * Audio format depends on wantsRawOpus():
	 * - If false (default): 24kHz, 16-bit, mono PCM
	 * - If true: Raw Opus frames at 48kHz
	 * @param audioBase64 - Base64-encoded audio (PCM or Opus)
	 */
	sendAudio(audioBase64: string): Promise<void>;

	/**
	 * Optional: Indicates if this backend wants raw audio instead of decoded PCM
	 * If true, sendAudio will receive base64-encoded raw audio (Opus frames or Ogg-Opus container)
	 * If false/undefined (default), sendAudio receives base64-encoded PCM
	 * @param encoding - The audio encoding format being used (opus or ogg-opus)
	 * @returns true if backend prefers raw audio in this encoding
	 */
	wantsRawOpus?(encoding?: AudioEncoding): boolean;

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
