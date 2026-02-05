/**
 * Mistral Voxtral Realtime API backend for transcription
 *
 * Uses Mistral's RealtimeTranscription SDK for low-latency transcription.
 * Supports streaming audio input and receives interim/final transcription results.
 *
 * Based on Mistral's official SDK example.
 * Documentation: https://docs.mistral.ai/capabilities/audio/
 */

import { randomUUID } from 'crypto';
import { config } from '../config';
import { writeMetric } from '../metrics';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';
import { RealtimeTranscription, AudioEncoding } from '@mistralai/mistralai/extra/realtime/index.js';

// Mistral Voxtral uses 16kHz sample rate for audio
const MISTRAL_SAMPLE_RATE = 16000;

/**
 * AsyncGenerator wrapper that allows pushing audio chunks from sendAudio() calls
 */
class AudioStreamQueue {
	private queue: Uint8Array[] = [];
	private closed = false;
	private resolveNext?: (value: IteratorResult<Uint8Array>) => void;

	push(chunk: Uint8Array): void {
		if (this.closed) {
			logger.warn('[MistralBackend] Attempted to push audio to closed stream');
			return;
		}

		if (this.resolveNext) {
			// Consumer is waiting, resolve immediately
			this.resolveNext({ value: chunk, done: false });
			this.resolveNext = undefined;
		} else {
			// Queue for later
			this.queue.push(chunk);
		}
	}

	close(): void {
		this.closed = true;
		if (this.resolveNext) {
			this.resolveNext({ value: undefined as any, done: true });
			this.resolveNext = undefined;
		}
	}

	async *getStream(): AsyncGenerator<Uint8Array, void, unknown> {
		while (!this.closed || this.queue.length > 0) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (!this.closed) {
				// Wait for next chunk
				const result = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
					this.resolveNext = resolve;
				});

				if (!result.done && result.value) {
					yield result.value;
				}
			}
		}
	}
}

// Timeout after which we consider a transcription "final" if no new deltas arrive
const MISTRAL_FINALIZE_TIMEOUT_MS = 5000;

export class MistralBackend implements TranscriptionBackend {
	private client?: RealtimeTranscription;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	private audioQueue?: AudioStreamQueue;
	private transcriptionPromise?: Promise<void>;
	private currentTranscriptText: string = '';
	private finalizeTimer?: NodeJS.Timeout;

	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage) => void;
	onError?: (errorType: string, errorMessage: string) => void;
	onClosed?: () => void;

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		this.backendConfig = backendConfig;

		if (!config.mistral?.apiKey) {
			throw new Error('MISTRAL_API_KEY not configured');
		}

		logger.info(`[Mistral ${this.tag}] Starting connection to Mistral Voxtral Realtime API`);
		logger.debug(
			`[Mistral ${this.tag}] Config: model=${backendConfig.model || config.mistral.model}, language=${backendConfig.language || 'auto'}`,
		);

		try {
			// Create the RealtimeTranscription client
			this.client = new RealtimeTranscription({
				apiKey: config.mistral.apiKey,
				serverURL: 'wss://api.mistral.ai',
			});

			// Create audio stream queue
			this.audioQueue = new AudioStreamQueue();

			// Start the transcription stream in the background
			const model = backendConfig.model || config.mistral.model || 'voxtral-mini-transcribe-realtime-2602';
			const audioStream = this.audioQueue.getStream();

			logger.debug(`[Mistral ${this.tag}] Starting transcribeStream with model: ${model}`);

			this.transcriptionPromise = this.consumeTranscriptionStream(audioStream, model);

			// Mark as connected immediately - the SDK handles the actual connection
			this.status = 'connected';
			logger.info(`[Mistral ${this.tag}] Backend connected and ready`);
		} catch (error) {
			logger.error(`[Mistral ${this.tag}] Failed to initialize:`, error);
			writeMetric(undefined, {
				name: 'mistral_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'connection_failed',
			});
			this.status = 'failed';
			throw error;
		}
	}

	private async consumeTranscriptionStream(audioStream: AsyncGenerator<Uint8Array, void, unknown>, model: string): Promise<void> {
		if (!this.client) {
			throw new Error('Client not initialized');
		}

		try {
			logger.debug(`[Mistral ${this.tag}] Calling transcribeStream()`);

			const eventStream = this.client.transcribeStream(audioStream, model, {
				audioFormat: {
					encoding: AudioEncoding.PcmS16le,
					sampleRate: MISTRAL_SAMPLE_RATE,
				},
			});

			logger.debug(`[Mistral ${this.tag}] Consuming transcription events`);

			for await (const event of eventStream) {
				logger.debug(`[Mistral ${this.tag}] Received event: ${JSON.stringify(event)}`);

				if (event.type === 'transcription.text.delta') {
					// Mistral only sends deltas, no "done" event
					// Accumulate deltas and use a timeout from the FIRST delta to finalize
					const delta = event.text || '';

					// If this is the first delta (buffer empty), start the timer
					const isFirstDelta = this.currentTranscriptText.length === 0;

					this.currentTranscriptText += delta;

					if (this.currentTranscriptText) {
						// Send interim transcription
						const transcription = this.createTranscriptionMessage(
							this.currentTranscriptText,
							undefined,
							Date.now(),
							randomUUID(),
							true,
						);
						this.onInterimTranscription?.(transcription);

						// Only start timer on the FIRST delta
						if (isFirstDelta && !this.finalizeTimer) {
							logger.debug(`[Mistral ${this.tag}] First delta received, starting ${MISTRAL_FINALIZE_TIMEOUT_MS}ms finalize timer`);
							this.finalizeTimer = setTimeout(() => {
								this.finalizeCurrentTranscription();
							}, MISTRAL_FINALIZE_TIMEOUT_MS);
						}
					}
				} else if (event.type === 'transcription.done') {
					// Final transcription complete - send final message with accumulated text
					logger.debug(`[Mistral ${this.tag}] Transcription completed`);
					this.finalizeCurrentTranscription();
				} else if (event.type === 'session.updated' || event.type === 'session.created') {
					// Session events - just log at debug level
					logger.debug(`[Mistral ${this.tag}] Session event: ${event.type}`);
				} else if (event.type === 'error') {
					const errorMessage =
						typeof event.error.message === 'string' ? event.error.message : JSON.stringify(event.error.message);
					logger.error(`[Mistral ${this.tag}] Transcription error: ${errorMessage}`);
					writeMetric(undefined, {
						name: 'mistral_api_error',
						worker: 'opus-transcriber-proxy',
						errorType: 'api_error',
					});
					this.onError?.('api_error', errorMessage);
					this.status = 'failed';
					break;
				} else {
					logger.debug(`[Mistral ${this.tag}] Unhandled event type: ${event.type}`);
				}
			}

			logger.info(`[Mistral ${this.tag}] Transcription stream ended`);
		} catch (error) {
			logger.error(`[Mistral ${this.tag}] Error in transcription stream:`, error);
			writeMetric(undefined, {
				name: 'mistral_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'stream_error',
			});
			this.status = 'failed';
			this.onError?.('stream_error', error instanceof Error ? error.message : 'Unknown error');
		}
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (!this.audioQueue || this.status !== 'connected') {
			throw new Error(`Cannot send audio: connection not ready (status: ${this.status})`);
		}

		try {
			// Convert base64 to Uint8Array
			const audioBuffer = Buffer.from(audioBase64, 'base64');
			const audioChunk = new Uint8Array(audioBuffer);

			// Push to the queue
			this.audioQueue.push(audioChunk);
		} catch (error) {
			logger.error(`[Mistral ${this.tag}] Failed to send audio:`, error);
			throw error;
		}
	}

	forceCommit(): void {
		// The Mistral SDK handles audio processing internally
		// We don't need to send explicit commit messages
		logger.debug(`[Mistral ${this.tag}] forceCommit called (no-op for SDK-based backend)`);
	}

	updatePrompt(prompt: string): void {
		// Mistral's Voxtral Realtime doesn't support mid-stream prompt updates
		// Would need to reconnect to change configuration
		logger.warn(`[Mistral ${this.tag}] Cannot update prompt: Mistral Voxtral requires reconnection to change prompts`);
	}

	close(): void {
		if (this.status === 'closed') {
			logger.debug(`[Mistral ${this.tag}] close() called but already closed, skipping`);
			return; // Already closed, prevent re-entrancy
		}

		logger.debug(`[Mistral ${this.tag}] Closing backend, current status: ${this.status}`);
		this.status = 'closed';

		// Clear finalize timer
		if (this.finalizeTimer) {
			clearTimeout(this.finalizeTimer);
			this.finalizeTimer = undefined;
		}

		// Close the audio queue to signal end of stream
		if (this.audioQueue) {
			logger.debug(`[Mistral ${this.tag}] Closing audio queue`);
			this.audioQueue.close();
			this.audioQueue = undefined;
		}

		// Wait for transcription to complete (don't await, just log)
		if (this.transcriptionPromise) {
			this.transcriptionPromise
				.then(() => {
					logger.debug(`[Mistral ${this.tag}] Transcription stream completed`);
				})
				.catch((error) => {
					logger.debug(`[Mistral ${this.tag}] Transcription stream error during close:`, error);
				});
			this.transcriptionPromise = undefined;
		}

		this.client = undefined;
		logger.debug(`[Mistral ${this.tag}] Backend closed`);
	}

	private finalizeCurrentTranscription(): void {
		// Clear the timer
		if (this.finalizeTimer) {
			clearTimeout(this.finalizeTimer);
			this.finalizeTimer = undefined;
		}

		// Send final transcription if we have accumulated text
		if (this.currentTranscriptText) {
			logger.debug(
				`[Mistral ${this.tag}] Finalizing transcription after timeout (${MISTRAL_FINALIZE_TIMEOUT_MS}ms), text length: ${this.currentTranscriptText.length}`,
			);

			const transcription = this.createTranscriptionMessage(
				this.currentTranscriptText,
				undefined,
				Date.now(),
				randomUUID(),
				false,
			);
			this.onCompleteTranscription?.(transcription);

			// Reset for next transcription
			this.currentTranscriptText = '';
		}
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getPreferredSampleRate(): 16000 {
		return MISTRAL_SAMPLE_RATE; // Mistral Voxtral uses 16kHz PCM
	}

	private createTranscriptionMessage(
		transcript: string,
		confidence: number | undefined,
		timestamp: number,
		message_id: string,
		isInterim: boolean,
	): TranscriptionMessage {
		const message: TranscriptionMessage = {
			transcript: [
				{
					...(confidence !== undefined && { confidence }),
					text: transcript,
				},
			],
			is_interim: isInterim,
			message_id,
			type: 'transcription-result',
			event: 'transcription-result',
			participant: this.participantInfo,
			timestamp,
		};
		return message;
	}
}
