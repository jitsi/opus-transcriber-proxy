import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import { OpusEncoder } from './OpusEncoder/OpusEncoder';
import { writeMetric } from './metrics';
import { MetricCache } from './MetricCache';

// Type definition augmentation for Uint8Array
declare global {
	interface Uint8ArrayConstructor {
		fromBase64(
			string: string,
			options?: {
				alphabet?: 'base64' | 'base64url' | undefined;
				lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' | undefined;
			},
		): Uint8Array<ArrayBuffer>;
	}

	interface Uint8Array<TArrayBuffer extends ArrayBufferLike> {
		toBase64(options?: { alphabet?: 'base64' | 'base64url' | undefined; omitPadding?: boolean | undefined }): string;
	}
}

// Gemini uses 16kHz sample rate
const GEMINI_SAMPLE_RATE = 16000;

// Safely create a base64 representation of a Uint8Array
function safeToBase64(array: Uint8Array): string {
	if (!(array.buffer instanceof ArrayBuffer) || !array.buffer.resizable) {
		return array.toBase64();
	}
	const tmpArray = new Uint8Array(array);
	return tmpArray.toBase64();
}

export interface GeminiTranslateConnectionOptions {
	instructions: string;
	targetLanguage: string;
	model?: string;
}

export class GeminiTranslateConnection {
	private static connectionCounter = 0;
	private connectionId: string;

	private localTag!: string;
	public get tag() {
		return this.localTag;
	}

	private connectionStatus: 'pending' | 'connected' | 'setup_complete' | 'failed' | 'closed' = 'pending';
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private encoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private opusDecoder?: OpusDecoder<16000>;
	private opusEncoder?: OpusEncoder<24000>;
	private geminiWebSocket?: WebSocket;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingPCMChunks: Uint8Array[] = [];

	private _lastMediaTime: number = -1;
	public get lastMediaTime() {
		return this._lastMediaTime;
	}

	private lastChunkNo: number = -1;
	private lastTimestamp: number = -1;
	private lastOpusFrameSize: number = -1;

	// Audio tracking for logging
	private totalSamplesSent: number = 0;
	private lastLoggedSecond: number = 0;

	// Audio packet counters and timestamps
	private static globalSequenceNumber: number = 0;
	private chunkCounter: number = 0;
	private timestamp48kHz: number = 0;
	private startWallClockTime?: number = undefined;
	private currentResponseStartTime?: number = undefined;
	private isFirstFrameOfResponse: boolean = true;

	onError?: (tag: string, error: any) => void = undefined;
	onClosed?: (tag: string) => void = undefined;
	onTranscription?: (transcript: string, targetLanguage: string) => void = undefined;
	onAudioFrame?: (tag: string, chunk: number, timestamp: number, payload: string, sequenceNumber: number) => void = undefined;

	private env: Env;
	private options: GeminiTranslateConnectionOptions;
	private metricCache: MetricCache;

	constructor(tag: string, env: Env, options: GeminiTranslateConnectionOptions) {
		this.connectionId = `gemini-conn-${++GeminiTranslateConnection.connectionCounter}`;
		this.localTag = tag;
		this.env = env;
		this.options = {
			model: 'gemini-2.5-flash-native-audio-preview-12-2025',
			...options,
		};
		this.metricCache = new MetricCache(env.METRICS);

		this.initializeOpusDecoder();
		this.initializeOpusEncoder();
		this.initializeGeminiWebSocket(env);
	}

	private getTimeString(): string {
		const now = new Date();
		return now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0');
	}

	private log(message: string): void {
		console.log(`[${this.getTimeString()}] [${this.connectionId}] ${message}`);
	}

	private logError(message: string, error?: any): void {
		if (error !== undefined) {
			console.error(`[${this.getTimeString()}] [${this.connectionId}] ${message}`, error);
		} else {
			console.error(`[${this.getTimeString()}] [${this.connectionId}] ${message}`);
		}
	}

	private async initializeOpusDecoder(): Promise<void> {
		try {
			this.log(`Creating Opus decoder (16kHz) for tag: ${this.localTag}`);
			this.opusDecoder = new OpusDecoder({
				sampleRate: GEMINI_SAMPLE_RATE,
				channels: 1,
			});

			await this.opusDecoder.ready;
			this.decoderStatus = 'ready';
			this.log(`Opus decoder ready for tag: ${this.localTag}`);
			this.processPendingOpusFrames();
		} catch (error) {
			this.logError(`Failed to create Opus decoder for tag ${this.localTag}:`, error);
			this.decoderStatus = 'failed';
			this.doClose(true);
			this.onError?.(this.localTag, `Error initializing Opus decoder: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async initializeOpusEncoder(): Promise<void> {
		try {
			this.log(`Creating Opus encoder (24kHz) for tag: ${this.localTag}`);
			this.opusEncoder = new OpusEncoder({
				sampleRate: 24000,
				channels: 1,
				application: 'voip',
				bitrate: 64000,
				complexity: 5,
			});

			await this.opusEncoder.ready;
			this.encoderStatus = 'ready';
			this.log(`Opus encoder ready for tag: ${this.localTag}`);
		} catch (error) {
			this.logError(`Failed to create Opus encoder for tag ${this.localTag}:`, error);
			this.encoderStatus = 'failed';
		}
	}

	private initializeGeminiWebSocket(env: Env): void {
		try {
			const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${env.GEMINI_API_KEY}`;
			const geminiWs = new WebSocket(geminiUrl);

			this.log(`Opening Gemini WebSocket for translation to ${this.options.targetLanguage}`);

			this.geminiWebSocket = geminiWs;

			geminiWs.addEventListener('open', () => {
				this.log(`Gemini WebSocket connected for translation to ${this.options.targetLanguage}`);
				this.connectionStatus = 'connected';

				// Send setup message to configure the model
				const setupMessage = {
					setup: {
						model: `models/${this.options.model}`,
						generation_config: {
							response_modalities: ['AUDIO'],
						},
						system_instruction: {
							parts: [
								{
									text: this.options.instructions,
								},
							],
						},
					},
				};

				const setupString = JSON.stringify(setupMessage);
				this.log(`Sending setup message: ${setupString}`);
				geminiWs.send(setupString);
			});

			geminiWs.addEventListener('message', (event) => {
				this.handleGeminiMessage(event.data);
			});

			geminiWs.addEventListener('error', (event) => {
				const errorMessage = event instanceof ErrorEvent ? event.message || 'WebSocket error' : 'WebSocket error';
				this.logError(`Gemini WebSocket error for tag ${this.localTag}: ${errorMessage}`);
				writeMetric(this.env.METRICS, {
					name: 'gemini_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'websocket_error',
				});
				this.doClose(true);
				this.connectionStatus = 'failed';
				this.onError?.(this.localTag, `Error connecting to Gemini service: ${errorMessage}`);
			});

			geminiWs.addEventListener('close', (event) => {
				this.log(
					`Gemini WebSocket closed for tag ${this.localTag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
				);
				this.doClose(true);
				this.connectionStatus = 'failed';
			});
		} catch (error) {
			this.logError(`Failed to create Gemini WebSocket connection for tag ${this.localTag}:`, error);
			writeMetric(this.env.METRICS, {
				name: 'gemini_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'connection_failed',
			});
			this.connectionStatus = 'failed';
		}
	}

	handleMediaEvent(mediaEvent: any): void {
		if (mediaEvent.media?.payload === undefined) {
			this.log(`No media payload in event for tag: ${this.localTag}`);
			return;
		}

		if (mediaEvent.media?.tag !== this.localTag) {
			this.log(`Received media for tag ${mediaEvent.media.tag} on connection for tag ${this.localTag}, ignoring.`);
			return;
		}

		this._lastMediaTime = Date.now();

		let opusFrame: Uint8Array;

		try {
			opusFrame = Uint8Array.fromBase64(mediaEvent.media.payload);
		} catch (error) {
			this.logError(`Failed to decode base64 media payload for tag ${this.localTag}:`, error);
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
					writeMetric(this.env.METRICS, {
						name: 'opus_packet_discarded',
						worker: 'opus-transcriber-proxy',
					});
					return;
				}

				if (this.decoderStatus == 'ready') {
					const timestampDelta = mediaEvent.media.timestamp - this.lastTimestamp;
					this.doConcealment(opusFrame, chunkDelta, timestampDelta);
				}
			}
			this.lastChunkNo = mediaEvent.media.chunk;
			this.lastTimestamp = mediaEvent.media.timestamp;
		}

		if (this.decoderStatus === 'ready' && this.opusDecoder) {
			this.processOpusFrame(opusFrame);
		} else if (this.decoderStatus === 'pending') {
			this.pendingOpusFrames.push(opusFrame);
			this.metricCache.increment({
				name: 'opus_packet_queued',
				worker: 'opus-transcriber-proxy',
			});
		} else {
			this.log(`Not queueing opus frame for tag: ${this.localTag}: decoder ${this.decoderStatus}`);
		}
	}

	private doConcealment(opusFrame: Uint8Array, chunkDelta: number, timestampDelta: number) {
		if (!this.opusDecoder) {
			this.logError(`No opus decoder available for tag: ${this.localTag}`);
			return;
		}

		const lostFrames = chunkDelta - 1;
		if (lostFrames <= 0) {
			return;
		}
		if (this.lastOpusFrameSize <= 0) {
			return;
		}

		const lostFramesInSamples = lostFrames * this.lastOpusFrameSize;
		const timestampDeltaInSamples = timestampDelta > 0 ? (timestampDelta / 48000) * GEMINI_SAMPLE_RATE : Infinity;
		const maxConcealment = 120 * (GEMINI_SAMPLE_RATE / 1000); /* 120 ms */

		const samplesToConceal = Math.min(lostFramesInSamples, timestampDeltaInSamples, maxConcealment);

		try {
			const concealedAudio = this.opusDecoder.conceal(opusFrame, samplesToConceal);
			if (concealedAudio.errors.length > 0) {
				writeMetric(this.env.METRICS, {
					name: 'opus_decode_failure',
					worker: 'opus-transcriber-proxy',
				});
			} else {
				this.sendOrEnqueueDecodedAudio(concealedAudio.pcmData);
				writeMetric(this.env.METRICS, {
					name: 'opus_loss_concealment',
					worker: 'opus-transcriber-proxy',
				});
			}
		} catch (error) {
			this.logError(`Error concealing ${samplesToConceal} samples for tag ${this.localTag}:`, error);
		}
	}

	private processOpusFrame(opusFrame: Uint8Array): void {
		if (!this.opusDecoder) {
			this.logError(`No opus decoder available for tag: ${this.localTag}`);
			return;
		}

		try {
			const decodedAudio = this.opusDecoder.decodeFrame(opusFrame);
			if (decodedAudio.errors.length > 0) {
				this.logError(`Opus decoding errors for tag ${this.localTag}:`, decodedAudio.errors);
				writeMetric(this.env.METRICS, {
					name: 'opus_decode_failure',
					worker: 'opus-transcriber-proxy',
				});
				return;
			}
			this.metricCache.increment({
				name: 'opus_packet_decoded',
				worker: 'opus-transcriber-proxy',
			});
			this.lastOpusFrameSize = decodedAudio.samplesDecoded;
			this.sendOrEnqueueDecodedAudio(decodedAudio.pcmData);
		} catch (error) {
			this.logError(`Error processing audio data for tag ${this.localTag}:`, error);
		}
	}

	private sendOrEnqueueDecodedAudio(pcmData: Int16Array) {
		const uint8Data = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);

		// Track audio samples for logging
		const samplesSent = pcmData.length;
		this.totalSamplesSent += samplesSent;
		const currentSecond = Math.floor(this.totalSamplesSent / GEMINI_SAMPLE_RATE);
		if (currentSecond > this.lastLoggedSecond) {
			this.log(`Sent ${currentSecond} second(s) of audio for tag: ${this.localTag}`);
			this.lastLoggedSecond = currentSecond;
		}

		if (this.connectionStatus === 'setup_complete' && this.geminiWebSocket) {
			this.sendPCMToGemini(uint8Data);
		} else if (this.connectionStatus === 'pending' || this.connectionStatus === 'connected') {
			this.pendingPCMChunks.push(uint8Data);
			this.metricCache.increment({
				name: 'gemini_audio_queued',
				worker: 'opus-transcriber-proxy',
			});
		} else {
			this.log(`Not queueing audio data for tag: ${this.localTag}: connection ${this.connectionStatus}`);
		}
	}

	private processPendingOpusFrames(): void {
		if (this.pendingOpusFrames.length === 0) {
			return;
		}

		this.log(`Processing ${this.pendingOpusFrames.length} queued media payloads for tag: ${this.localTag}`);

		const queuedPayloads = [...this.pendingOpusFrames];
		this.pendingOpusFrames = [];

		for (const binaryData of queuedPayloads) {
			this.processOpusFrame(binaryData);
		}
	}

	private processPendingPCMChunks(): void {
		if (this.pendingPCMChunks.length === 0) {
			return;
		}

		this.log(`Processing ${this.pendingPCMChunks.length} queued PCM chunks for tag: ${this.localTag}`);

		const queuedChunks = [...this.pendingPCMChunks];
		this.pendingPCMChunks = [];

		for (const chunk of queuedChunks) {
			this.sendPCMToGemini(chunk);
		}
	}

	private sendPCMToGemini(pcmData: Uint8Array): void {
		if (!this.geminiWebSocket) {
			this.logError(`No websocket available for tag: ${this.localTag}`);
			return;
		}

		try {
			const encodedAudio = pcmData.toBase64();
			const realtimeInput = {
				realtime_input: {
					media_chunks: [
						{
							mime_type: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
							data: encodedAudio,
						},
					],
				},
			};

			this.geminiWebSocket.send(JSON.stringify(realtimeInput));
			this.metricCache.increment({
				name: 'gemini_audio_sent',
				worker: 'opus-transcriber-proxy',
			});
		} catch (error) {
			this.logError(`Failed to send audio to Gemini for tag ${this.localTag}`, error);
		}
	}

	private async handleGeminiMessage(data: any): Promise<void> {
		let parsedMessage;
		try {
			// Handle different message formats (string, ArrayBuffer, Blob)
			let messageText: string;
			if (typeof data === 'string') {
				messageText = data;
			} else if (data instanceof ArrayBuffer) {
				const decoder = new TextDecoder();
				messageText = decoder.decode(data);
			} else {
				this.logError(`Unsupported message data type for tag ${this.localTag}: ${typeof data}`);
				return;
			}

			parsedMessage = JSON.parse(messageText);

			// Log the event received from Gemini (excluding base64 audio data)
			const sanitizedMessage = JSON.parse(JSON.stringify(parsedMessage, (key, value) => {
				// Replace base64 audio data with a placeholder
				if (key === 'data' && typeof value === 'string' && value.length > 100) {
					return `[BASE64 DATA - ${value.length} chars]`;
				}
				return value;
			}));
			this.log(`Gemini event received: ${JSON.stringify(sanitizedMessage, null, 2)}`);
		} catch (parseError) {
			this.logError(`Failed to parse Gemini message as JSON for tag ${this.localTag}:`, parseError);
			return;
		}

		// Handle setup complete
		if (parsedMessage.setupComplete !== undefined) {
			this.log(`Setup complete received from Gemini`);
			this.connectionStatus = 'setup_complete';
			// Process any pending PCM chunks
			this.processPendingPCMChunks();
			return;
		}

		// Handle server content (audio responses)
		if (parsedMessage.serverContent) {
			this.log(`Received serverContent from Gemini`);

			// Check for audio parts in the response
			const parts = parsedMessage.serverContent.modelTurn?.parts || [];

			for (const part of parts) {
				// Handle inline audio data
				if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData?.data) {
					this.log(`Received audio response, data length: ${part.inlineData.data.length}`);

					// The audio is base64-encoded PCM at 24kHz
					if (this.encoderStatus === 'ready' && this.opusEncoder) {
						try {
							// Encode to Opus
							const opusFrames = this.opusEncoder.encodeFrame(part.inlineData.data);
							if (opusFrames.length > 0) {
								this.log(`Encoded ${opusFrames.length} opus frames from Gemini audio`);

								for (const frame of opusFrames) {
									this.sendAudioFrame(frame);
								}
							}
						} catch (error) {
							this.logError(`Failed to encode Gemini audio:`, error);
						}
					}
				}

				// Handle text transcript
				if (part.text) {
					this.log(`Received text transcript from Gemini: ${part.text}`);
					this.onTranscription?.(part.text, this.options.targetLanguage);
				}
			}

			// Mark as first frame of next response
			this.isFirstFrameOfResponse = true;
			return;
		}

		// Log any other message types
		this.log(`Received Gemini message: ${JSON.stringify(parsedMessage)}`);
	}

	private sendAudioFrame(opusFrame: Uint8Array): void {
		// Handle timestamp logic
		if (this.startWallClockTime === undefined) {
			this.startWallClockTime = Date.now();
			this.timestamp48kHz = 0;
			this.isFirstFrameOfResponse = false;
		} else if (this.isFirstFrameOfResponse) {
			const now = Date.now();
			const elapsedMs = now - this.startWallClockTime;
			this.timestamp48kHz = Math.round((elapsedMs / 1000) * 48000);
			this.currentResponseStartTime = now;
			this.isFirstFrameOfResponse = false;
		}

		this.chunkCounter++;
		GeminiTranslateConnection.globalSequenceNumber++;

		const payload = opusFrame.toBase64();

		this.onAudioFrame?.(this.localTag, this.chunkCounter, this.timestamp48kHz, payload, GeminiTranslateConnection.globalSequenceNumber);

		// Increment timestamp by frame length (20ms at 48kHz = 960 ticks)
		this.timestamp48kHz += 960;
	}

	close(): void {
		this.doClose(false);
	}

	private doClose(notify: boolean): void {
		this.metricCache.flush();
		this.opusDecoder?.free();
		this.opusDecoder = undefined;
		this.decoderStatus = 'closed';

		this.opusEncoder?.free();
		this.opusEncoder = undefined;
		this.encoderStatus = 'closed';

		this.geminiWebSocket?.close();
		this.geminiWebSocket = undefined;
		this.connectionStatus = 'closed';

		if (notify) {
			this.onClosed?.(this.localTag);
		}
	}
}
