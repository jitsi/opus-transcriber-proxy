import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import type { TranscriptionMessage, TranscriberProxyOptions } from './transcriberproxy';
import { getTurnDetectionConfig } from './utils';
import { writeMetric } from './metrics';
import { MetricCache } from './MetricCache';
import { config } from './config';

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

// The maximum number of bytes of audio OpenAI allows to be sent at a time.
// OpenAI specifies this 15 MiB of base64-encoded audio, so divide by 3/4 to get the size in raw bytes.
// It's unlikely we'll hit this limit (it's ~4 minutes of audio at 24000 Hz) but better safe than sorry
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
	private connectionStatus: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private opusDecoder?: OpusDecoder<24000>;
	private openaiWebSocket?: WebSocket;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingAudioDataBuffer = new ArrayBuffer(0, { maxByteLength: MAX_AUDIO_BLOCK_BYTES });
	private pendingAudioData: Uint8Array = new Uint8Array(this.pendingAudioDataBuffer);
	private pendingAudioFrames: string[] = [];

	private lastChunkNo: number = -1;
	private lastTimestamp: number = -1;
	private lastOpusFrameSize: number = -1;

	private lastTranscriptTime?: number = undefined;

	// Idle commit timeout - forces transcription when audio stops
	private idleCommitTimeout: ReturnType<typeof setTimeout> | null = null;

	// Transcript history for context injection
	private transcriptHistory: string = '';

	onInterimTranscription?: (message: TranscriptionMessage) => void = undefined;
	onCompleteTranscription?: (message: TranscriptionMessage) => void = undefined;
	onClosed?: (tag: string) => void = undefined;
	onOpenAIError?: (errorType: string, errorMessage: string) => void = undefined;
	onError?: (tag: string, error: any) => void = undefined;

	private options: TranscriberProxyOptions;
	private metricCache: MetricCache;

	constructor(tag: string, options: TranscriberProxyOptions) {
		this.localTag = tag;
		this.setServerAcknowledgedTag(tag);
		this.options = options;
		this.metricCache = new MetricCache(undefined, NaN);

		this.initializeOpusDecoder();
		this.initializeOpenAIWebSocket();
	}

	private async initializeOpusDecoder(): Promise<void> {
		try {
			console.log(`Creating Opus decoder for tag: ${this.localTag}`);
			this.opusDecoder = new OpusDecoder({
				sampleRate: 24000,
				channels: 1,
			});

			await this.opusDecoder.ready;
			this.decoderStatus = 'ready';
			console.log(`Opus decoder ready for tag: ${this.localTag}`);
			this.processPendingOpusFrames();
		} catch (error) {
			console.error(`Failed to create Opus decoder for tag ${this.localTag}:`, error);
			this.decoderStatus = 'failed';
			this.doClose(true);
			this.onError?.(this.localTag, `Error initializing Opus decoder: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private initializeOpenAIWebSocket(): void {
		try {
			const openaiWs = new WebSocket(OPENAI_WS_URL, ['realtime', `openai-insecure-api-key.${config.openai.apiKey}`]);

			console.log(`Opening OpenAI WebSocket to ${OPENAI_WS_URL} for tag: ${this.localTag}`);

			this.openaiWebSocket = openaiWs;

			openaiWs.addEventListener('open', () => {
				console.log(`OpenAI WebSocket connected for tag: ${this.localTag}`);
				this.connectionStatus = 'connected';

				const transcriptionConfig: { model: string; language?: string; prompt?: string } = {
					model: config.openai.model,
				};
				if (this.options.language !== null) {
					transcriptionConfig.language = this.options.language;
				}
				if (config.openai.transcriptionPrompt) {
					transcriptionConfig.prompt = config.openai.transcriptionPrompt;
				}

				const sessionConfig = {
					type: 'session.update',
					session: {
						type: 'transcription',
						audio: {
							input: {
								format: {
									type: 'audio/pcm',
									rate: 24000,
								},
								noise_reduction: {
									type: 'near_field',
								},
								transcription: transcriptionConfig,
								turn_detection: getTurnDetectionConfig(),
							},
						},
						include: ['item.input_audio_transcription.logprobs'],
					},
				};

				const sessionConfigMessage = JSON.stringify(sessionConfig);
				console.log(`Sending session.update for tag ${this.localTag}:`, sessionConfigMessage);
				openaiWs.send(sessionConfigMessage);

				// Process any pending audio data that was queued while waiting for connection
				this.processPendingAudioData();
			});

			openaiWs.addEventListener('message', (event) => {
				this.handleOpenAIMessage(event.data);
			});

			openaiWs.addEventListener('error', (event) => {
				// Extract useful info from ErrorEvent (event.message is often empty for WebSocket errors)
				const errorMessage = event instanceof ErrorEvent ? event.message || 'WebSocket error' : 'WebSocket error';
				console.error(`OpenAI WebSocket error for tag ${this.serverAcknowledgedTag}: ${errorMessage}`);
				writeMetric(undefined, {
					name: 'openai_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'websocket_error',
				});
				this.onOpenAIError?.('websocket_error', 'WebSocket connection error');
				this.doClose(true);
				this.connectionStatus = 'failed';
				this.onError?.(this.localTag, `Error connecting to OpenAI service: ${errorMessage}`);
			});

			openaiWs.addEventListener('close', (event) => {
				console.log(
					`OpenAI WebSocket closed for tag ${this.localTag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
				);
				this.doClose(true);
				this.connectionStatus = 'failed';
			});
		} catch (error) {
			console.error(`Failed to create OpenAI WebSocket connection for tag ${this.localTag}:`, error);
			writeMetric(undefined, {
				name: 'openai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'connection_failed',
			});
			this.onOpenAIError?.('connection_failed', error instanceof Error ? error.message : 'Unknown error');
			this.connectionStatus = 'failed';
		}
	}

	handleMediaEvent(mediaEvent: any): void {
		// console.log(`Handling media event for tag: ${this.tag}`);

		if (mediaEvent.media?.payload === undefined) {
			console.warn(`No media payload in event for tag: ${this.localTag}`);
			return;
		}

		if (mediaEvent.media?.tag !== this.localTag) {
			console.warn(`Received media for tag ${mediaEvent.media.tag} on connection for tag ${this.localTag}, ignoring.`);
			return;
		}

		let opusFrame: Uint8Array;

		try {
			// Base64 decode the media payload to binary using Node.js Buffer
			opusFrame = new Uint8Array(Buffer.from(mediaEvent.media.payload, 'base64'));
		} catch (error) {
			console.error(`Failed to decode base64 media payload for tag ${this.localTag}:`, error);
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

		if (this.decoderStatus === 'ready' && this.opusDecoder) {
			this.processOpusFrame(opusFrame);
		} else if (this.decoderStatus === 'pending') {
			// Queue the binary data until decoder is ready
			this.pendingOpusFrames.push(opusFrame);
			this.metricCache.increment({
				name: 'opus_packet_queued',
				worker: 'opus-transcriber-proxy',
			});
			// console.log(`Queued opus frame for tag: ${this.tag} (queue size: ${this.pendingOpusFrames.length})`);
		} else {
			console.log(`Not queueing opus frame for tag: ${this.localTag}: decoder ${this.decoderStatus}`);
		}
	}

	private doConcealment(opusFrame: Uint8Array, chunkDelta: number, timestampDelta: number) {
		if (!this.opusDecoder) {
			console.error(`No opus decoder available for tag: ${this.localTag}`);
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
			console.error(`Error concealing ${samplesToConceal} samples for tag ${this.localTag}:`, error);
			// Don't call onError for concealment errors, as they may be transient
		}
	}

	private processOpusFrame(opusFrame: Uint8Array): void {
		if (!this.opusDecoder) {
			console.error(`No opus decoder available for tag: ${this.localTag}`);
			return;
		}

		try {
			// Decode the Opus audio data
			const decodedAudio = this.opusDecoder.decodeFrame(opusFrame);
			if (decodedAudio.errors.length > 0) {
				console.error(`Opus decoding errors for tag ${this.localTag}:`, decodedAudio.errors);
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
			console.error(`Error processing audio data for tag ${this.localTag}:`, error);
		}
	}

	private sendOrEnqueueDecodedAudio(pcmData: Int16Array) {
		const uint8Data = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);

		if (this.connectionStatus === 'connected' && this.openaiWebSocket) {
			const encodedAudio = Buffer.from(uint8Data.buffer, uint8Data.byteOffset, uint8Data.byteLength).toString('base64');
			this.sendAudioToOpenAI(encodedAudio);
		} else if (this.connectionStatus === 'pending') {
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
				name: 'openai_audio_queued',
				worker: 'opus-transcriber-proxy',
			});
		} else {
			console.log(`Not queueing audio data for tag: ${this.localTag}: connection ${this.connectionStatus}`);
		}
	}

	private processPendingOpusFrames(): void {
		if (this.pendingOpusFrames.length === 0) {
			return;
		}

		console.log(`Processing ${this.pendingOpusFrames.length} queued media payloads for tag: ${this.localTag}`);

		// Process all queued media payloads
		const queuedPayloads = [...this.pendingOpusFrames];
		this.pendingOpusFrames = []; // Clear the queue

		for (const binaryData of queuedPayloads) {
			this.processOpusFrame(binaryData);
		}
	}

	private sendAudioToOpenAI(encodedAudio: string): void {
		if (!this.openaiWebSocket) {
			console.error(`No websocket available for tag: ${this.localTag}`);
			return;
		}

		try {
			const audioMessage = {
				type: 'input_audio_buffer.append',
				audio: encodedAudio,
			};

			this.openaiWebSocket.send(JSON.stringify(audioMessage));
			this.resetIdleCommitTimeout();
			this.metricCache.increment({
				name: 'openai_audio_sent',
				worker: 'opus-transcriber-proxy',
			});
		} catch (error) {
			console.error(`Failed to send audio to OpenAI for tag ${this.localTag}`, error);
			// TODO should this call onError?
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioFrames.length === 0 && this.pendingAudioData.length === 0) {
			return;
		}

		console.log(
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
			this.sendAudioToOpenAI(encodedAudio);
		}
	}

	private getTranscriptionMessage(
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
			participant: this.participant,
			timestamp,
		};
		return message;
	}

	private async handleOpenAIMessage(data: any): Promise<void> {
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(data);
		} catch (parseError) {
			console.error(`Failed to parse OpenAI message as JSON for tag ${this.serverAcknowledgedTag}:`, parseError);
			// TODO: close this connection?
			return;
		}
		if (parsedMessage.type === 'conversation.item.input_audio_transcription.delta') {
			const now = Date.now();
			if (this.lastTranscriptTime === undefined) {
				this.lastTranscriptTime = now;
			}
			const confidence = parsedMessage.logprobs?.[0]?.logprob !== undefined ? Math.exp(parsedMessage.logprobs[0].logprob) : undefined;
			const transcription = this.getTranscriptionMessage(parsedMessage.delta, confidence, now, parsedMessage.item_id, true);
			this.onInterimTranscription?.(transcription);
		} else if (parsedMessage.type === 'conversation.item.input_audio_transcription.completed') {
			let transcriptTime;
			if (this.lastTranscriptTime !== undefined) {
				transcriptTime = this.lastTranscriptTime;
				this.lastTranscriptTime = undefined;
			} else {
				transcriptTime = Date.now();
			}
			const confidence = parsedMessage.logprobs?.[0]?.logprob !== undefined ? Math.exp(parsedMessage.logprobs[0].logprob) : undefined;
			const transcription = this.getTranscriptionMessage(
				parsedMessage.transcript,
				confidence,
				transcriptTime,
				parsedMessage.item_id,
				false,
			);
			this.clearIdleCommitTimeout();
			this.onCompleteTranscription?.(transcription);
		} else if (parsedMessage.type === 'conversation.item.input_audio_transcription.failed') {
			console.error(`OpenAI failed to transcribe audio for tag ${this.serverAcknowledgedTag}: ${data}`);
			writeMetric(undefined, {
				name: 'transcription_failure',
				worker: 'opus-transcriber-proxy',
			});
		} else if (parsedMessage.type === 'session.created') {
			console.log(`Received session.created for tag ${this.serverAcknowledgedTag}:`, data);
		} else if (parsedMessage.type === 'session.updated') {
			console.log(`Received session.updated for tag ${this.serverAcknowledgedTag}:`, data);
		} else if (parsedMessage.type === 'error') {
			if (parsedMessage.error?.type === 'invalid_request_error' && parsedMessage.error?.code === 'input_audio_buffer_commit_empty') {
				// This error indicates that we tried to commit an empty audio buffer, which can happen
				// if the VAD detected speech stopped just before we did a manual commit.  Ignore.
				// TODO should we log this at all?
				console.log(`OpenAI reported empty audio buffer commit for ${this.serverAcknowledgedTag}, ignoring.`);
				return;
			}
			console.error(`OpenAI sent error message for ${this.serverAcknowledgedTag}: ${data}`);
			writeMetric(undefined, {
				name: 'openai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			this.onOpenAIError?.('api_error', parsedMessage.error?.message || data);
			this.doClose(true);
			this.onError?.(this.serverAcknowledgedTag, `OpenAI service sent error message: ${data}`);
		} else if (
			parsedMessage.type !== 'input_audio_buffer.committed' &&
			parsedMessage.type !== 'input_audio_buffer.speech_started' &&
			parsedMessage.type !== 'input_audio_buffer.speech_stopped' &&
			parsedMessage.type !== 'conversation.item.added' &&
			parsedMessage.type !== 'conversation.item.done'
		) {
			// Log unexpected message types that might indicate issues
			console.warn(`Unhandled OpenAI message type for ${this.serverAcknowledgedTag}: ${parsedMessage.type}`);
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
		if (this.connectionStatus !== 'connected' || !this.openaiWebSocket) {
			return;
		}

		console.log(`Forcing commit for idle connection ${this.localTag}`);
		const commitMessage = { type: 'input_audio_buffer.commit' };
		this.openaiWebSocket.send(JSON.stringify(commitMessage));
		this.idleCommitTimeout = null;
	}

	/**
	 * Add a transcript from another participant to the history and update the session prompt
	 * This adds context to the transcription by including recent transcripts in the prompt
	 * @param text - The text to add (e.g., "participantA: hello world")
	 */
	addTranscriptContext(text: string): void {
		if (this.connectionStatus !== 'connected' || !this.openaiWebSocket) {
			console.warn(`Cannot add transcript context for ${this.localTag}: connection not ready`);
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

			// Update the session with the new prompt
			this.updateSessionPrompt();

			if (config.debug) {
				console.log(`Added transcript context to ${this.localTag}: "${text}" (history size: ${this.transcriptHistory.length} bytes)`);
			}
		} catch (error) {
			console.error(`Failed to add transcript context for ${this.localTag}:`, error);
		}
	}

	/**
	 * Update the session prompt to include transcript history
	 */
	private updateSessionPrompt(): void {
		if (this.connectionStatus !== 'connected' || !this.openaiWebSocket) {
			return;
		}

		try {
			// Construct the full prompt with base + context header + history
			let fullPrompt = config.openai.transcriptionPrompt || '';

			if (this.transcriptHistory) {
				fullPrompt += '\n\nThe following is a transcription of what others in the conference have recently said. Use it as context when transcribing.\n';
				fullPrompt += this.transcriptHistory;
			}

			// Build transcription config with updated prompt
			const transcriptionConfig: { model: string; language?: string; prompt?: string } = {
				model: config.openai.model,
			};
			if (this.options.language !== null) {
				transcriptionConfig.language = this.options.language;
			}
			transcriptionConfig.prompt = fullPrompt;

			// Send session update
			const sessionUpdate = {
				type: 'session.update',
				session: {
					type: 'transcription',
					audio: {
						input: {
							transcription: transcriptionConfig,
						},
					},
				},
			};

			this.openaiWebSocket.send(JSON.stringify(sessionUpdate));

			if (config.debug) {
				console.log(`Updated session prompt for ${this.localTag} (prompt size: ${fullPrompt.length} bytes)`);
			}
		} catch (error) {
			console.error(`Failed to update session prompt for ${this.localTag}:`, error);
		}
	}

	close(): void {
		this.doClose(false);
	}

	private doClose(notify: boolean): void {
		console.log(`Closing OutgoingConnection for tag: ${this.localTag}`);
		this.clearIdleCommitTimeout();
		this.metricCache.flush();
		this.opusDecoder?.free();
		this.opusDecoder = undefined;
		this.decoderStatus = 'closed';

		this.openaiWebSocket?.close();
		this.openaiWebSocket = undefined;
		this.connectionStatus = 'closed';

		if (notify) {
			this.onClosed?.(this.localTag);
		}
	}
}
