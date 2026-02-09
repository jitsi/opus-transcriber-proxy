import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import type { TranscriptionMessage, TranscriberProxyOptions } from './transcriberproxy';
import { writeMetric } from './metrics';
import { MetricCache } from './MetricCache';
import { config, getDefaultProvider } from './config';
import logger from './logger';
import { createBackend, getBackendConfig } from './backends/BackendFactory';
import type { TranscriptionBackend } from './backends/TranscriptionBackend';

// The maximum number of bytes of audio to buffer before sending.
// 15 MiB of base64-encoded audio = ~4 minutes of audio at 24000 Hz
const MAX_AUDIO_BLOCK_BYTES = (15 * 1024 * 1024 * 3) / 4;

// Convert Uint8Array to base64 string using Node.js Buffer
function safeToBase64(array: Uint8Array): string {
	return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
}

const tagMatcher = /^([0-9a-fA-F]+)-([0-9]+)$/;

export class OutgoingConnection {
	private localTag!: string;
	private serverAcknowledgedTag!: string;
	public get tag() {
		return this.localTag;
	}
	private setServerAcknowledgedTag(newTag: string) {
		this.serverAcknowledgedTag = newTag;
		const match = tagMatcher.exec(newTag);
		if (match !== null && match.length === 3) {
			this.participant = { id: match[1], ssrc: match[2] };
		} else {
			this.participant = { id: newTag };
		}
	}
	private participant: any;
	public get participantId(): string {
		return this.participant?.id || this.localTag;
	}
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private opusDecoder?: OpusDecoder<24000>;
	private backend?: TranscriptionBackend;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingAudioDataBuffer = new ArrayBuffer(0, { maxByteLength: MAX_AUDIO_BLOCK_BYTES });
	private pendingAudioData: Uint8Array = new Uint8Array(this.pendingAudioDataBuffer);
	private pendingAudioFrames: string[] = [];

	private lastChunkNo: number = -1;
	private lastTimestamp: number = -1;
	private lastOpusFrameSize: number = -1;

	// Idle commit timeout - forces transcription when audio stops
	private idleCommitTimeout: ReturnType<typeof setTimeout> | null = null;

	// Transcript history for context injection
	private transcriptHistory: string = '';

	// Flag to prevent multiple reconnection attempts
	private isReconnecting: boolean = false;

	onInterimTranscription?: (message: TranscriptionMessage) => void = undefined;
	onCompleteTranscription?: (message: TranscriptionMessage) => void = undefined;
	onClosed?: (tag: string) => void = undefined;
	onBackendError?: (errorType: string, errorMessage: string) => void = undefined;
	onError?: (tag: string, error: any) => void = undefined;

	private options: TranscriberProxyOptions;
	private metricCache: MetricCache;

	constructor(tag: string, options: TranscriberProxyOptions) {
		this.localTag = tag;
		this.setServerAcknowledgedTag(tag);
		this.options = options;
		this.metricCache = new MetricCache(undefined, NaN);

		this.initializeBackend();
		// Note: Opus decoder initialization is now done in initializeBackend
		// after we know if the backend wants raw Opus or not
	}

	private async initializeOpusDecoder(): Promise<void> {
		try {
			logger.debug(`Creating Opus decoder for tag: ${this.localTag}`);
			this.opusDecoder = new OpusDecoder({
				sampleRate: 24000,
				channels: 1,
			});

			await this.opusDecoder.ready;
			this.decoderStatus = 'ready';
			logger.debug(`Opus decoder ready for tag: ${this.localTag}`);
			this.processPendingOpusFrames();
		} catch (error) {
			logger.error(`Failed to create Opus decoder for tag ${this.localTag}:`, error);
			this.decoderStatus = 'failed';
			this.doClose(true);
			this.onError?.(this.localTag, `Error initializing Opus decoder: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async initializeBackend(): Promise<void> {
		try {
			// Create backend using factory
			// Use provider from options (URL param), or fall back to config default
			this.backend = createBackend(this.localTag, this.participant, this.options.provider);

			// Check if backend wants raw Opus frames or decoded PCM
			const wantsRawOpus = this.backend.wantsRawOpus?.(this.options.encoding) ?? false;

			if (wantsRawOpus) {
				logger.info(`Backend wants raw Opus frames for tag: ${this.localTag}, skipping Opus decoder initialization`);
				// Set decoder status to skip - we won't decode
				this.decoderStatus = 'ready'; // Mark as ready so we can process frames
			} else {
				// Initialize Opus decoder for PCM output
				this.initializeOpusDecoder();
			}

			// Set up event handlers
			this.backend.onInterimTranscription = (message) => {
				logger.info(`OutgoingConnection received interim transcription for ${this.localTag}`);
				this.onInterimTranscription?.(message);
			};

			this.backend.onCompleteTranscription = (message) => {
				logger.info(`OutgoingConnection received complete transcription for ${this.localTag}: "${message.transcript?.[0]?.text}"`);
				this.clearIdleCommitTimeout();
				this.onCompleteTranscription?.(message);
			};

			this.backend.onError = (errorType, errorMessage) => {
				this.onBackendError?.(errorType, errorMessage);
				this.doClose(true);
				this.onError?.(this.localTag, `Transcription backend error: ${errorMessage}`);
			};

			this.backend.onClosed = () => {
				logger.info(`Backend closed for tag ${this.localTag}, cleaning up OutgoingConnection`);
				// Close this OutgoingConnection and notify TranscriberProxy to remove it
				this.doClose(true);
			};

			// Get backend configuration
			const backendConfig = getBackendConfig(this.options.provider);
			backendConfig.language = this.options.language;
			backendConfig.encoding = this.options.encoding;

			// Connect the backend
			await this.backend.connect(backendConfig);

			logger.info(`Transcription backend connected for tag: ${this.localTag}`);

			// Process any pending audio data that was queued while waiting for connection
			if (wantsRawOpus) {
				// For raw Opus mode, process pending Opus frames directly
				this.processPendingOpusFrames();
			} else {
				// For PCM mode, process pending decoded audio
				this.processPendingAudioData();
			}
		} catch (error) {
			logger.error(`Failed to initialize transcription backend for tag ${this.localTag}:`, error);
			this.backend = undefined;
			this.onBackendError?.('connection_failed', error instanceof Error ? error.message : 'Unknown error');
			this.doClose(true);
			this.onError?.(this.localTag, `Error initializing transcription backend: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Attempt to reconnect a dead/stale backend connection.
	 * Queued audio will be flushed once the connection is re-established.
	 */
	private async reconnectBackend(): Promise<void> {
		if (this.isReconnecting) {
			return;
		}

		this.isReconnecting = true;
		logger.info(`Attempting to reconnect backend for tag ${this.localTag}, queued frames: ${this.pendingOpusFrames.length}`);

		try {
			// Clean up old backend if it exists
			if (this.backend) {
				try {
					this.backend.close();
				} catch (e) {
					// Ignore errors when closing stale backend
				}
				this.backend = undefined;
			}

			// Reinitialize the backend (this will also process pending frames)
			await this.initializeBackend();

			const newBackendStatus = this.backend?.getStatus();
			logger.info(
				`Backend reconnected successfully for tag ${this.localTag}, newStatus=${newBackendStatus}, ` +
					`decoderStatus=${this.decoderStatus}, remainingQueuedFrames=${this.pendingOpusFrames.length}`,
			);
		} catch (error) {
			logger.error(`Failed to reconnect backend for tag ${this.localTag}:`, error);
			// Don't close the connection entirely - let more frames queue up
			// and we'll try again on the next frame
		} finally {
			this.isReconnecting = false;
		}
	}

	handleMediaEvent(mediaEvent: any): void {
		// logger.debug(`Handling media event for tag: ${this.tag}`);

		if (mediaEvent.media?.payload === undefined) {
			logger.warn(`No media payload in event for tag: ${this.localTag}`);
			return;
		}

		if (mediaEvent.media?.tag !== this.localTag) {
			logger.warn(`Received media for tag ${mediaEvent.media.tag} on connection for tag ${this.localTag}, ignoring.`);
			return;
		}

		let opusFrame: Uint8Array;

		try {
			// Base64 decode the media payload to binary using Node.js Buffer
			opusFrame = new Uint8Array(Buffer.from(mediaEvent.media.payload, 'base64'));
		} catch (error) {
			logger.error(`Failed to decode base64 media payload for tag ${this.localTag}:`, error);
			return;
		}

		this.metricCache.increment({
			name: 'opus_packet_received',
			worker: 'opus-transcriber-proxy',
		});

		if (Number.isInteger(mediaEvent.media?.chunk) && Number.isInteger(mediaEvent.media.timestamp)) {
			if (this.lastChunkNo != -1 && mediaEvent.media.chunk != this.lastChunkNo + 1) {
				const chunkDelta = mediaEvent.media.chunk - this.lastChunkNo;
				if (chunkDelta <= 0) {
					// Packets reordered or replayed, drop this packet
					writeMetric(undefined, {
						name: 'opus_packet_discarded',
						worker: 'opus-transcriber-proxy',
					});

					return;
				}

				// Packets lost, do concealment
				if (this.decoderStatus == 'ready') {
					const timestampDelta = mediaEvent.media.timestamp - this.lastTimestamp;
					// TODO: enqueue concealment actions?  Not sure this is needed in practice.
					this.doConcealment(opusFrame, chunkDelta, timestampDelta);
				}
			}
			this.lastChunkNo = mediaEvent.media.chunk;
			this.lastTimestamp = mediaEvent.media.timestamp;
		}

		// Check if backend wants raw Opus or decoded PCM
		const wantsRawOpus = this.backend?.wantsRawOpus?.(this.options.encoding) ?? false;
		const backendStatus = this.backend?.getStatus();

		// INFO-level logging for debugging reconnection issues
		logger.info(
			`handleMediaEvent for tag ${this.localTag}: backendStatus=${backendStatus}, decoderStatus=${this.decoderStatus}, ` +
				`wantsRawOpus=${wantsRawOpus}, isReconnecting=${this.isReconnecting}, queuedFrames=${this.pendingOpusFrames.length}`,
		);

		// Check if backend is in a bad state and needs reconnection
		if (backendStatus === 'closed' || backendStatus === 'failed' || !this.backend) {
			logger.warn(`Backend not ready for tag ${this.localTag} (status: ${backendStatus}), attempting reconnect`);
			// Queue the frame while we reconnect
			this.pendingOpusFrames.push(opusFrame);
			this.metricCache.increment({
				name: 'opus_packet_queued',
				worker: 'opus-transcriber-proxy',
			});
			// Attempt to reconnect (only once, not for every frame)
			if (!this.isReconnecting) {
				this.reconnectBackend();
			}
			return;
		}

		if (wantsRawOpus && this.decoderStatus === 'ready' && backendStatus === 'connected') {
			// Send raw Opus frame directly (no decoding, backend is ready)
			logger.debug(`Sending raw Opus frame to backend for tag ${this.localTag}`);
			this.sendRawOpusToBackend(opusFrame);
		} else if (wantsRawOpus && this.decoderStatus === 'ready' && backendStatus === 'pending') {
			// Queue raw Opus frames until backend is ready
			this.pendingOpusFrames.push(opusFrame);
			this.metricCache.increment({
				name: 'opus_packet_queued',
				worker: 'opus-transcriber-proxy',
			});
		} else if (this.decoderStatus === 'ready' && this.opusDecoder) {
			// Decode Opus to PCM and send
			this.processOpusFrame(opusFrame);
		} else if (this.decoderStatus === 'pending') {
			// Queue the binary data until decoder/backend is ready
			this.pendingOpusFrames.push(opusFrame);
			this.metricCache.increment({
				name: 'opus_packet_queued',
				worker: 'opus-transcriber-proxy',
			});
			// logger.debug(`Queued opus frame for tag: ${this.tag} (queue size: ${this.pendingOpusFrames.length})`);
		} else {
			logger.debug(`Not queueing opus frame for tag: ${this.localTag}: decoder ${this.decoderStatus}, backend ${backendStatus}`);
		}
	}

	private doConcealment(opusFrame: Uint8Array, chunkDelta: number, timestampDelta: number) {
		if (!this.opusDecoder) {
			logger.error(`No opus decoder available for tag: ${this.localTag}`);
			return;
		}

		const lostFrames = chunkDelta - 1;
		if (lostFrames <= 0) {
			return;
		}
		if (this.lastOpusFrameSize <= 0) {
			// Not sure how we could have gotten here if we've never decoded anything
			return;
		}

		/* Make sure numbers make sense */
		const lostFramesInSamples = lostFrames * this.lastOpusFrameSize;
		const timestampDeltaInSamples = timestampDelta > 0 ? (timestampDelta / 48000) * 24000 : Infinity;
		const maxConcealment = 120 * 24; /* 120 ms at 24 kHz */

		const samplesToConceal = Math.min(lostFramesInSamples, timestampDeltaInSamples, maxConcealment);

		try {
			const concealedAudio = this.opusDecoder.conceal(opusFrame, samplesToConceal);
			if (concealedAudio.errors.length > 0) {
				writeMetric(undefined, {
					name: 'opus_decode_failure',
					worker: 'opus-transcriber-proxy',
				});
			} else {
				this.sendOrEnqueueDecodedAudio(concealedAudio.pcmData);
				writeMetric(undefined, {
					name: 'opus_loss_concealment',
					worker: 'opus-transcriber-proxy',
				});
			}
		} catch (error) {
			logger.error(`Error concealing ${samplesToConceal} samples for tag ${this.localTag}:`, error);
			// Don't call onError for concealment errors, as they may be transient
		}
	}

	private processOpusFrame(opusFrame: Uint8Array): void {
		if (!this.opusDecoder) {
			logger.error(`No opus decoder available for tag: ${this.localTag}`);
			return;
		}

		try {
			// Decode the Opus audio data
			const decodedAudio = this.opusDecoder.decodeFrame(opusFrame);
			if (decodedAudio.errors.length > 0) {
				logger.error(`Opus decoding errors for tag ${this.localTag}:`, decodedAudio.errors);
				writeMetric(undefined, {
					name: 'opus_decode_failure',
					worker: 'opus-transcriber-proxy',
				});

				// Don't call onError for decoding errors, as they may be transient
				return;
			}
			this.metricCache.increment({
				name: 'opus_packet_decoded',
				worker: 'opus-transcriber-proxy',
			});
			this.lastOpusFrameSize = decodedAudio.samplesDecoded;
			this.sendOrEnqueueDecodedAudio(decodedAudio.pcmData);
		} catch (error) {
			logger.error(`Error processing audio data for tag ${this.localTag}:`, error);
		}
	}

	private sendOrEnqueueDecodedAudio(pcmData: Int16Array) {
		const uint8Data = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);

		const backendStatus = this.backend?.getStatus();

		if (backendStatus === 'connected' && this.backend) {
			const encodedAudio = Buffer.from(uint8Data.buffer, uint8Data.byteOffset, uint8Data.byteLength).toString('base64');
			this.sendAudioToBackend(encodedAudio);
		} else if (backendStatus === 'pending') {
			// Add the pending audio data for later sending
			// Keep it as a Uint8Array because you can't concatenate base64 (because of the padding)
			if (this.pendingAudioData.length + uint8Data.length <= MAX_AUDIO_BLOCK_BYTES) {
				const oldLength = this.pendingAudioData.length;
				this.pendingAudioDataBuffer.resize(this.pendingAudioData.byteLength + uint8Data.byteLength);
				this.pendingAudioData.set(uint8Data, oldLength);
			} else {
				// Would exceed MAX_AUDIO_BLOCK_BYTES, break off a frame and base64-encode it.
				const encodedAudio = safeToBase64(this.pendingAudioData);
				this.pendingAudioFrames.push(encodedAudio);
				this.pendingAudioDataBuffer.resize(uint8Data.byteLength);
				this.pendingAudioData.set(uint8Data);
			}
			this.metricCache.increment({
				name: 'backend_audio_queued',
				worker: 'opus-transcriber-proxy',
			});
		} else {
			logger.debug(`Not queueing audio data for tag: ${this.localTag}: backend ${backendStatus}`);
		}
	}

	private processPendingOpusFrames(): void {
		if (this.pendingOpusFrames.length === 0) {
			logger.debug(`No queued frames to process for tag: ${this.localTag}`);
			return;
		}

		const backendStatus = this.backend?.getStatus();
		logger.info(
			`Processing ${this.pendingOpusFrames.length} queued media payloads for tag: ${this.localTag}, backendStatus=${backendStatus}`,
		);

		// Process all queued media payloads
		const queuedPayloads = [...this.pendingOpusFrames];
		this.pendingOpusFrames = []; // Clear the queue

		// Check if backend wants raw Opus or decoded PCM
		const wantsRawOpus = this.backend?.wantsRawOpus?.(this.options.encoding) ?? false;

		let sentCount = 0;
		for (const binaryData of queuedPayloads) {
			if (wantsRawOpus) {
				// Send raw Opus frame directly
				this.sendRawOpusToBackend(binaryData);
				sentCount++;
			} else {
				// Decode and send PCM
				this.processOpusFrame(binaryData);
				sentCount++;
			}
		}
		logger.info(`Finished processing queued frames for tag ${this.localTag}: sent ${sentCount} frames`);
	}

	private sendAudioToBackend(encodedAudio: string): void {
		if (!this.backend) {
			logger.error(`No backend available for tag: ${this.localTag}`);
			return;
		}

		try {
			this.backend.sendAudio(encodedAudio);
			this.resetIdleCommitTimeout();
			this.metricCache.increment({
				name: 'backend_audio_sent',
				worker: 'opus-transcriber-proxy',
			});
		} catch (error) {
			logger.error(`Failed to send audio to backend for tag ${this.localTag}`, error);
			// TODO should this call onError?
		}
	}

	private sendRawOpusToBackend(opusFrame: Uint8Array): void {
		if (!this.backend) {
			logger.error(`No backend available for tag: ${this.localTag}`);
			return;
		}

		const backendStatus = this.backend.getStatus();
		if (backendStatus !== 'connected') {
			logger.warn(`sendRawOpusToBackend called but backend status is ${backendStatus} for tag ${this.localTag}`);
		}

		try {
			// Convert raw Opus frame to base64 and send to backend
			const base64Opus = Buffer.from(opusFrame).toString('base64');
			this.backend.sendAudio(base64Opus);
			this.resetIdleCommitTimeout();
			this.metricCache.increment({
				name: 'backend_opus_sent',
				worker: 'opus-transcriber-proxy',
			});
		} catch (error) {
			logger.error(`Failed to send raw Opus to backend for tag ${this.localTag}: ${error}`);
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioFrames.length === 0 && this.pendingAudioData.length === 0) {
			return;
		}

		logger.debug(
			`Processing ${this.pendingAudioData.length} bytes plus ${this.pendingAudioFrames.length} frames of queued audio data for tag: ${this.localTag}`,
		);

		// Process all queued audio data
		const queuedAudio = [...this.pendingAudioFrames];
		this.pendingAudioFrames = []; // Clear the queue

		if (this.pendingAudioData.length !== 0) {
			queuedAudio.push(safeToBase64(this.pendingAudioData));
		}
		this.pendingAudioDataBuffer.resize(0);

		for (const encodedAudio of queuedAudio) {
			this.sendAudioToBackend(encodedAudio);
		}
	}

	private resetIdleCommitTimeout(): void {
		this.clearIdleCommitTimeout();

		const timeoutSeconds = config.forceCommitTimeout;
		if (timeoutSeconds <= 0) {
			return;
		}

		this.idleCommitTimeout = setTimeout(() => {
			this.forceCommit();
		}, timeoutSeconds * 1000);
	}

	private clearIdleCommitTimeout(): void {
		if (this.idleCommitTimeout !== null) {
			clearTimeout(this.idleCommitTimeout);
			this.idleCommitTimeout = null;
		}
	}

	private forceCommit(): void {
		if (!this.backend || this.backend.getStatus() !== 'connected') {
			return;
		}

		logger.debug(`Forcing commit for idle connection ${this.localTag}`);
		this.backend.forceCommit();
		this.idleCommitTimeout = null;
	}

	/**
	 * Add a transcript from another participant to the history and update the session prompt
	 * This adds context to the transcription by including recent transcripts in the prompt
	 * @param text - The text to add (e.g., "participantA: hello world")
	 */
	addTranscriptContext(text: string): void {
		if (!this.backend || this.backend.getStatus() !== 'connected') {
			logger.warn(`Cannot add transcript context for ${this.localTag}: backend not ready`);
			return;
		}

		try {
			// Append new transcript to history
			const newEntry = text + '\n';
			this.transcriptHistory += newEntry;

			// Clip history to max size (from the end, keeping most recent)
			const maxSize = config.broadcastTranscriptsMaxSize;
			if (this.transcriptHistory.length > maxSize) {
				// Keep the most recent part
				this.transcriptHistory = this.transcriptHistory.substring(this.transcriptHistory.length - maxSize);
				// Try to start from a complete line
				const firstNewline = this.transcriptHistory.indexOf('\n');
				if (firstNewline !== -1 && firstNewline < this.transcriptHistory.length - 1) {
					this.transcriptHistory = this.transcriptHistory.substring(firstNewline + 1);
				}
			}

			// Update the backend prompt
			this.updateBackendPrompt();

			if (config.debug) {
				logger.debug(`Added transcript context to ${this.localTag}: "${text}" (history size: ${this.transcriptHistory.length} bytes)`);
			}
		} catch (error) {
			logger.error(`Failed to add transcript context for ${this.localTag}:`, error);
		}
	}

	/**
	 * Update the backend prompt to include transcript history
	 */
	private updateBackendPrompt(): void {
		if (!this.backend || this.backend.getStatus() !== 'connected') {
			return;
		}

		try {
			// Get base prompt from config based on this connection's provider
			const backendType = this.options.provider || getDefaultProvider();
			let basePrompt = '';

			if (backendType === 'openai') {
				basePrompt = config.openai.transcriptionPrompt || '';
			} else if (backendType === 'gemini') {
				basePrompt = config.gemini.transcriptionPrompt || '';
			}

			// Construct the full prompt with base + context header + history
			let fullPrompt = basePrompt;

			if (this.transcriptHistory) {
				fullPrompt += '\n\nThe following is a transcription of what others in the conference have recently said. Use it as context when transcribing.\n';
				fullPrompt += this.transcriptHistory;
			}

			// Update the backend
			this.backend.updatePrompt(fullPrompt);

			if (config.debug) {
				logger.debug(`Updated backend prompt for ${this.localTag} (prompt size: ${fullPrompt.length} bytes)`);
			}
		} catch (error) {
			logger.error(`Failed to update backend prompt for ${this.localTag}:`, error);
		}
	}

	close(): void {
		this.doClose(false);
	}

	private doClose(notify: boolean): void {
		logger.debug(`Closing OutgoingConnection for tag: ${this.localTag}`);
		this.clearIdleCommitTimeout();
		this.metricCache.flush();
		this.opusDecoder?.free();
		this.opusDecoder = undefined;
		this.decoderStatus = 'closed';

		this.backend?.close();
		this.backend = undefined;

		if (notify) {
			this.onClosed?.(this.localTag);
		}
	}
}
