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

import type { AudioFormat } from '../AudioFormat';
export type { AudioFormat };

export interface BackendConfig {
	/** Language hint for transcription (undefined = auto-detect) */
	language?: string;
	/** Custom prompt/instructions for the transcription model */
	prompt?: string;
	/** Model to use for transcription */
	model?: string;
	/** Tags to be sent to the backend (e.g., for Deepgram) */
	tags?: string[];
	/**
	 * Per-connection override for Deepgram's Model Improvement Program opt-out.
	 * undefined = use global config (DEEPGRAM_MIP_OPT_OUT); true/false overrides it.
	 */
	deepgramMipOptOut?: boolean;
	/**
	 * Per-endpoint override for speaker diarization, set from the `start` event's
	 * `diarize` field. undefined = use global config (DEEPGRAM_DIARIZE / XAI_DIARIZE);
	 * true/false overrides it for this connection. Enable only for streams that
	 * genuinely carry multiple speakers (e.g. room systems, dial-in legs) — on a
	 * single-speaker stream diarization can spuriously split one talker.
	 */
	diarize?: boolean;
	/**
	 * Per-connection xAI segmentation overrides (undefined = use global config).
	 * `xaiEndpointing`: silence ms before a final. `xaiSmartTurn`: end-of-turn
	 * confidence (0–1); when set, enables smart_turn. `xaiSmartTurnTimeout`: max
	 * silence ms before forcing speech_final (only used when smart_turn is enabled).
	 */
	xaiEndpointing?: number;
	xaiSmartTurn?: number;
	xaiSmartTurnTimeout?: number;
	/**
	 * Per-connection overrides for xAI consumer-side roll-own granular finalization
	 * (undefined = use global config). `xaiGranularFinals`: commit a stable prefix of the growing
	 * hypothesis incrementally instead of only on end-of-turn speech_final (fixes long-turn vs
	 * acks ordering). `xaiGranularStabilityMs`: debounce window before a word freezes.
	 * `xaiGranularGuardWords`: volatile words held back at the growing edge.
	 */
	xaiGranularFinals?: boolean;
	xaiGranularStabilityMs?: number;
	xaiGranularGuardWords?: number;
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
	 * Audio format is determined by getDesiredAudioFormat(): PCM (l16) or raw Opus/Ogg
	 * @param audioBase64 - Base64-encoded audio
	 */
	sendAudio(audioBase64: string): Promise<void>;

	/**
	 * Returns the audio format this backend wants to receive for a given input format.
	 * Backends that support raw Opus will mirror the input encoding ('opus' or 'ogg').
	 * All other backends request decoded PCM: encoding 'l16' at 24000 Hz.
	 * @param inputFormat - The audio format being provided by the client
	 * @returns The audio format this backend wants to receive
	 */
	getDesiredAudioFormat(inputFormat: AudioFormat): AudioFormat;

	/**
	 * Force the backend to commit/finalize pending audio and generate transcription.
	 * Used when audio stream goes idle.
	 * @returns seconds of synthetic silence injected into the provider's audio stream (0 if none).
	 *   The xAI backend injects idle silence to flush a trailing utterance; the caller mirrors that
	 *   into the identity PCM ring so its media clock stays aligned with what the backend received.
	 */
	forceCommit(): number;

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
	/**
	 * Reports a backend error.
	 * @param recoverable - When true, the error is a transient stream-level
	 *   condition (e.g. xAI's "ASR stream timed out" on silence) and the
	 *   participant is still active; OutgoingConnection reconnects the backend
	 *   in place instead of tearing down the whole connection. Defaults to false
	 *   (fatal — close the connection).
	 */
	onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
	onClosed?: () => void;
}
