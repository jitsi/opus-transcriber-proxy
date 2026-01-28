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

export interface BackendConfig {
	/** Language hint for transcription (null = auto-detect) */
	language: string | null;
	/** Custom prompt/instructions for the transcription model */
	prompt?: string;
	/** Model to use for transcription */
	model?: string;
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
	 * Optional: Indicates if this backend wants raw Opus frames instead of decoded PCM
	 * If true, sendAudio will receive base64-encoded Opus frames
	 * If false/undefined (default), sendAudio receives base64-encoded PCM
	 * @returns true if backend prefers raw Opus frames
	 */
	wantsRawOpus?(): boolean;

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
