import { createAudioDecoder } from './AudioDecoderFactory';
import type { AudioDecoder } from './AudioDecoder';
import { NO_CHUNK_INFO } from './AudioDecoder';
import type { TranscriptionMessage, TranscriberProxyOptions } from './transcriberproxy';
import { writeMetric } from './metrics';
import { MetricCache } from './MetricCache';
import { config, getDefaultProvider } from './config';
import logger from './logger';
import { createBackend, getBackendConfig } from './backends/BackendFactory';
import type { TranscriptionBackend, AudioFormat } from './backends/TranscriptionBackend';
import { getInstruments } from './telemetry/instruments';


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
	private decoder?: AudioDecoder;
	private reinitGeneration = 0;
	private backend?: TranscriptionBackend;
	private pendingInputFrames: Array<{ frame: Uint8Array; chunkNo: number; timestamp: number }> = [];
	private pendingAudioFrames: string[] = [];

	// Idle commit timeout - forces transcription when audio stops
	private idleCommitTimeout: ReturnType<typeof setTimeout> | null = null;

	// Transcript history for context injection
	private transcriptHistory: string = '';

	onInterimTranscription?: (message: TranscriptionMessage) => void = undefined;
	onCompleteTranscription?: (message: TranscriptionMessage) => void = undefined;
	onClosed?: (tag: string) => void = undefined;
	onBackendError?: (errorType: string, errorMessage: string) => void = undefined;
	onError?: (tag: string, error: any) => void = undefined;

	private options: TranscriberProxyOptions;
	private metricCache: MetricCache;
	private inputAudioFormat!: AudioFormat;

	constructor(tag: string, inputFormat: any, options: TranscriberProxyOptions) {
		this.localTag = tag;
		this.setServerAcknowledgedTag(tag);
		this.options = options;
		this.metricCache = new MetricCache(undefined, NaN);

		// Validate input format before initializing backend
		this.updateInputFormat(inputFormat);

		// Only initialize backend if input format is valid (not failed or closed)
		if (this.decoderStatus !== 'failed' && this.decoderStatus !== 'closed') {
			this.initializeBackend();
		}
		// Note: decoder initialization is done in initializeBackend
		// after we know the desired output format from the backend
	}

	updateInputFormat(inputFormat: any): void {
		const encoding = inputFormat?.encoding;
		if (encoding === 'ogg-opus') {
			this.inputAudioFormat = { encoding: 'ogg' };
		} else {
			this.inputAudioFormat = {
				encoding: encoding ?? '',
				...(inputFormat?.sampleRate !== undefined && { sampleRate: inputFormat.sampleRate }),
				...(inputFormat?.channels !== undefined && { channels: inputFormat.channels }),
			};
		}

		if (this.backend) {
			this.reinitializeDecoder().catch((error) => {
				logger.error(`Failed to reinitialize decoder for tag ${this.localTag}:`, error);
				this.onError?.(this.localTag, error instanceof Error ? error.message : String(error));
				this.doClose(true);
			});
		}
	}

	private async initializeBackend(): Promise<void> {
		try {
			// Create backend using factory
			// Use provider from options (URL param), or fall back to config default
			this.backend = createBackend(this.localTag, this.participant, this.options.provider);

			await this.reinitializeDecoder();

			// Set up event handlers
			this.backend.onInterimTranscription = (message) => {
				// OTel metrics: track interim transcription received
				getInstruments().transcriptionsReceivedTotal.add(1, { provider: this.options.provider || 'unknown', is_interim: 'true' });
				this.onInterimTranscription?.(message);
			};

			this.backend.onCompleteTranscription = (message) => {
				// OTel metrics: track final transcription received
				getInstruments().transcriptionsReceivedTotal.add(1, { provider: this.options.provider || 'unknown', is_interim: 'false' });
				this.clearIdleCommitTimeout();
				this.onCompleteTranscription?.(message);
			};

			this.backend.onError = (errorType, errorMessage) => {
				// OTel metrics: track backend errors
				getInstruments().backendErrorsTotal.add(1, { provider: this.options.provider || 'unknown', type: errorType });
				this.onBackendError?.(errorType, errorMessage);
				this.doClose(true);
				this.onError?.(this.localTag, `Transcription backend error: ${errorMessage}`);
			};

			this.backend.onClosed = () => {
				logger.info(`Backend closed for tag ${this.localTag}, cleaning up OutgoingConnection`);
				// OTel metrics: decrement backend connection count
				getInstruments().backendConnectionsActive.add(-1);
				// Close this OutgoingConnection and notify TranscriberProxy to remove it
				this.doClose(true);
			};

			// Get backend configuration
			const backendConfig = getBackendConfig(this.options.provider);
			backendConfig.language = this.options.language;
			backendConfig.encoding = this.options.encoding;
			backendConfig.tags = this.options.tags;

			// Connect the backend
			const connectStartTime = Date.now();
			await this.backend.connect(backendConfig);
			const connectDurationSec = (Date.now() - connectStartTime) / 1000;

			// OTel metrics: track backend connection
			const instruments = getInstruments();
			instruments.backendConnectionsActive.add(1);
			instruments.backendConnectionDurationSeconds.record(connectDurationSec, { provider: this.options.provider || 'unknown' });

			logger.info(`Transcription backend connected for tag: ${this.localTag}`);

			// Process any pending audio data that was queued while waiting for connection
			// First process any raw frames through the decoder
			this.processPendingInputFrames();
			// Then flush any already-decoded audio that was queued
			this.processPendingAudioData();
		} catch (error) {
			logger.error(`Failed to initialize transcription backend for tag ${this.localTag}:`, error);
			this.backend = undefined;
			this.onBackendError?.('connection_failed', error instanceof Error ? error.message : 'Unknown error');
			this.doClose(true);
			this.onError?.(this.localTag, `Error initializing transcription backend: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async reinitializeDecoder(): Promise<void> {
		if (!this.backend) {
			throw new Error('Cannot initialize decoder without a backend');
		}

		// Capture a generation token before the await. If another reinitializeDecoder
		// call starts while we're awaiting, it will increment reinitGeneration, and we
		// will discard our result rather than overwriting the newer decoder.
		const generation = ++this.reinitGeneration;

		this.decoder?.free();
		this.decoder = undefined;
		this.decoderStatus = 'pending';

		const desiredFormat = this.backend.getDesiredAudioFormat(this.inputAudioFormat);
		const newDecoder = createAudioDecoder(this.inputAudioFormat, desiredFormat);
		await newDecoder.ready;

		if (generation !== this.reinitGeneration) {
			// A newer reinitializeDecoder call has taken over; discard this result.
			newDecoder.free();
			return;
		}

		this.decoder = newDecoder;
		this.decoderStatus = 'ready';
		logger.info(`Audio decoder ready for tag: ${this.localTag} (output: ${desiredFormat.encoding})`);

		if (this.backend.getStatus() === 'connected') {
			this.processPendingInputFrames();
		}
	}

	handleMediaEvent(mediaEvent: any): void {
		if (mediaEvent.media?.payload === undefined) {
			logger.warn(`No media payload in event for tag: ${this.localTag}`);
			return;
		}

		if (mediaEvent.media?.tag !== this.localTag) {
			logger.warn(`Received media for tag ${mediaEvent.media.tag} on connection for tag ${this.localTag}, ignoring.`);
			return;
		}

		let audioFrame: Uint8Array;

		try {
			// Base64 decode the media payload to binary using Node.js Buffer
			audioFrame = new Uint8Array(Buffer.from(mediaEvent.media.payload, 'base64'));
		} catch (error) {
			logger.error(`Failed to decode base64 media payload for tag ${this.localTag}:`, error);
			return;
		}

		this.metricCache.increment({
			name: 'audio_packet_received',
			worker: 'opus-transcriber-proxy',
		});

		// OTel metrics: track audio received from client
		const instruments = getInstruments();
		instruments.clientAudioChunksTotal.add(1);
		instruments.clientAudioBytesTotal.add(audioFrame.length);

		const chunkNo = Number.isInteger(mediaEvent.media?.chunk) ? (mediaEvent.media.chunk as number) : NO_CHUNK_INFO;
		const timestamp = Number.isInteger(mediaEvent.media?.timestamp) ? (mediaEvent.media.timestamp as number) : NO_CHUNK_INFO;

		const backendStatus = this.backend?.getStatus();

		if (this.decoderStatus === 'ready' && this.decoder) {
			this.decodeAndSend(audioFrame, chunkNo, timestamp);
		} else if (this.decoderStatus === 'pending') {
			// Queue with chunk info so the decoder can perform gap detection when flushed
			this.pendingInputFrames.push({ frame: audioFrame, chunkNo, timestamp });
			this.metricCache.increment({
				name: 'audio_packet_queued',
				worker: 'opus-transcriber-proxy',
			});
		} else {
			logger.debug(`Not queueing audio frame for tag: ${this.localTag}: decoder ${this.decoderStatus}, backend ${backendStatus}`);
		}
	}

	private decodeAndSend(frame: Uint8Array, chunkNo: number, timestamp: number): void {
		if (!this.decoder) {
			logger.error(`No decoder available for tag: ${this.localTag}`);
			return;
		}

		try {
			const results = this.decoder.decodeChunk(frame, chunkNo, timestamp);

			if (results === null) {
				// Out-of-order packet — discard
				writeMetric(undefined, {
					name: 'audio_packet_discarded',
					worker: 'opus-transcriber-proxy',
				});
				return;
			}

			for (const decoded of results) {
				if (decoded.errors.length > 0) {
					logger.error(`Audio decoding errors for tag ${this.localTag}:`, decoded.errors);
					writeMetric(undefined, {
						name: 'audio_decode_failure',
						worker: 'opus-transcriber-proxy',
					});
					continue;
				}

				if (decoded.kind === 'concealment') {
					writeMetric(undefined, {
						name: 'audio_loss_concealment',
						worker: 'opus-transcriber-proxy',
					});
				} else {
					this.metricCache.increment({
						name: 'audio_packet_decoded',
						worker: 'opus-transcriber-proxy',
					});
				}

				this.sendOrEnqueueDecodedAudio(decoded.audioData);
			}
		} catch (error) {
			logger.error(`Error processing audio data for tag ${this.localTag}:`, error);
		}
	}

	private sendOrEnqueueDecodedAudio(audioData: Uint8Array) {
		const backendStatus = this.backend?.getStatus();

		if (backendStatus === 'connected' && this.backend) {
			const encodedAudio = Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength).toString('base64');
			this.sendAudioToBackend(encodedAudio);
		} else if (backendStatus === 'pending') {
			const encodedAudio = Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength).toString('base64');
			this.pendingAudioFrames.push(encodedAudio);
			this.metricCache.increment({
				name: 'backend_audio_queued',
				worker: 'opus-transcriber-proxy',
			});
		} else {
			logger.debug(`Not queueing audio data for tag: ${this.localTag}: backend ${backendStatus}`);
		}
	}

	private processPendingInputFrames(): void {
		if (this.pendingInputFrames.length === 0) {
			return;
		}

		logger.debug(`Processing ${this.pendingInputFrames.length} queued media payloads for tag: ${this.localTag}`);

		const queuedPayloads = [...this.pendingInputFrames];
		this.pendingInputFrames = [];

		for (const { frame, chunkNo, timestamp } of queuedPayloads) {
			this.decodeAndSend(frame, chunkNo, timestamp);
		}
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

			// OTel metrics: estimate raw bytes from base64 length
			// Base64 encodes 3 bytes as 4 chars, so rawBytes ≈ base64Length * 3/4
			const estimatedRawBytes = Math.floor((encodedAudio.length * 3) / 4);
			getInstruments().backendAudioSentBytesTotal.add(estimatedRawBytes, { provider: this.options.provider || 'unknown' });
		} catch (error) {
			logger.error(`Failed to send audio to backend for tag ${this.localTag}`, error);
			// TODO should this call onError?
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioFrames.length === 0) {
			return;
		}

		logger.debug(`Processing ${this.pendingAudioFrames.length} frames of queued audio data for tag: ${this.localTag}`);

		const queuedAudio = [...this.pendingAudioFrames];
		this.pendingAudioFrames = [];

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

	/**
	 * Reset chunk tracking state. Call this when the session is reattached to a new WebSocket
	 * to prevent frames from being discarded as "reordered" when chunk numbers restart from 0.
	 */
	resetChunkTracking(): void {
		logger.info(`Resetting chunk tracking for tag ${this.localTag}`);
		this.decoder?.reset();
	}

	close(): void {
		this.doClose(false);
	}

	private doClose(notify: boolean): void {
		logger.debug(`Closing OutgoingConnection for tag: ${this.localTag}`);
		this.clearIdleCommitTimeout();
		this.metricCache.flush();
		this.decoder?.free();
		this.decoder = undefined;
		this.decoderStatus = 'closed';

		this.backend?.close();
		this.backend = undefined;

		if (notify) {
			this.onClosed?.(this.localTag);
		}
	}
}
