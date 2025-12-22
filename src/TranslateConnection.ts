import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import { OpusEncoder } from './OpusEncoder/OpusEncoder';
import { writeMetric } from './metrics';
import { MetricCache } from './MetricCache';
import { getTurnDetectionConfig } from './utils';

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

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime';

// The maximum number of bytes of audio OpenAI allows to be sent at a time.
const MAX_AUDIO_BLOCK_BYTES = (15 * 1024 * 1024 * 3) / 4;

// Safely create a base64 representation of a Uint8Array
function safeToBase64(array: Uint8Array): string {
	if (!(array.buffer instanceof ArrayBuffer) || !array.buffer.resizable) {
		return array.toBase64();
	}
	const tmpArray = new Uint8Array(array);
	return tmpArray.toBase64();
}

export interface TranslateConnectionOptions {
	instructions: string;
	targetLanguage: string;
	voice?: string;
}

export class TranslateConnection {
	private static connectionCounter = 0;
	private connectionId: string;

	private localTag!: string;
	public get tag() {
		return this.localTag;
	}

	private connectionStatus: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private encoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private opusDecoder?: OpusDecoder<24000>;
	private opusEncoder?: OpusEncoder<24000>;
	private openaiWebSocket?: WebSocket;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingAudioDataBuffer = new ArrayBuffer(0, { maxByteLength: MAX_AUDIO_BLOCK_BYTES });
	private pendingAudioData: Uint8Array = new Uint8Array(this.pendingAudioDataBuffer);

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
	private options: TranslateConnectionOptions;
	private metricCache: MetricCache;

	constructor(tag: string, env: Env, options: TranslateConnectionOptions) {
		this.connectionId = `translate-conn-${++TranslateConnection.connectionCounter}`;
		this.localTag = tag;
		this.env = env;
		this.options = options;
		this.metricCache = new MetricCache(env.METRICS);

		this.initializeOpusDecoder();
		this.initializeOpusEncoder();
		this.initializeOpenAIWebSocket(env);
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
			this.log(`Creating Opus decoder for tag: ${this.localTag}`);
			this.opusDecoder = new OpusDecoder({
				sampleRate: 24000,
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
			this.log(`Creating Opus encoder for tag: ${this.localTag}`);
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
			// Don't close connection if encoder fails, translation can still work without encoding output
		}
	}

	private initializeOpenAIWebSocket(env: Env): void {
		try {
			const openaiWs = new WebSocket(OPENAI_WS_URL, ['realtime', `openai-insecure-api-key.${env.OPENAI_API_KEY}`]);

			this.log(`Opening OpenAI WebSocket to ${OPENAI_WS_URL} for translation to ${this.options.targetLanguage}`);

			this.openaiWebSocket = openaiWs;

			openaiWs.addEventListener('open', () => {
				this.log(`OpenAI WebSocket connected for translation to ${this.options.targetLanguage}`);
				this.connectionStatus = 'connected';

				// Configure session for translation (conversational mode with instructions)
				const sessionConfig = {
					type: 'session.update',
					session: {
						instructions: this.options.instructions,
						type: 'realtime',
						//turn_detection: getTurnDetectionConfig(env),
						//modalities: ['text', 'audio'],
					},
				};
				console.log(`Config session with ${sessionConfig}`);

				const configMessage = JSON.stringify(sessionConfig);
				this.log(`Initializing translation session with config: ${configMessage}`);

				openaiWs.send(configMessage);

				// Process any pending audio data that was queued while waiting for connection
				this.processPendingAudioData();
			});

			openaiWs.addEventListener('message', (event) => {
				this.handleOpenAIMessage(event.data);
			});

			openaiWs.addEventListener('error', (event) => {
				const errorMessage = event instanceof ErrorEvent ? event.message || 'WebSocket error' : 'WebSocket error';
				this.logError(`OpenAI WebSocket error for tag ${this.localTag}: ${errorMessage}`);
				writeMetric(this.env.METRICS, {
					name: 'openai_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'websocket_error',
				});
				this.doClose(true);
				this.connectionStatus = 'failed';
				this.onError?.(this.localTag, `Error connecting to OpenAI service: ${errorMessage}`);
			});

			openaiWs.addEventListener('close', (event) => {
				this.log(
					`OpenAI WebSocket closed for tag ${this.localTag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
				);
				this.doClose(true);
				this.connectionStatus = 'failed';
			});
		} catch (error) {
			this.logError(`Failed to create OpenAI WebSocket connection for tag ${this.localTag}:`, error);
			writeMetric(this.env.METRICS, {
				name: 'openai_api_error',
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
			// Base64 decode the media payload to binary
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
					// Packets reordered or replayed, drop this packet
					writeMetric(this.env.METRICS, {
						name: 'opus_packet_discarded',
						worker: 'opus-transcriber-proxy',
					});
					return;
				}

				// Packets lost, do concealment
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
			// Queue the binary data until decoder is ready
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
		const timestampDeltaInSamples = timestampDelta > 0 ? (timestampDelta / 48000) * 24000 : Infinity;
		const maxConcealment = 120 * 24; /* 120 ms at 24 kHz */

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
			// Decode the Opus audio data
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
		const currentSecond = Math.floor(this.totalSamplesSent / 24000);
		if (currentSecond > this.lastLoggedSecond) {
			this.log(`Sent ${currentSecond} second(s) of audio for tag: ${this.localTag}`);
			this.lastLoggedSecond = currentSecond;
		}

		if (this.connectionStatus === 'connected' && this.openaiWebSocket) {
			const encodedAudio = uint8Data.toBase64();
			this.sendAudioToOpenAI(encodedAudio);
		} else if (this.connectionStatus === 'pending') {
			// Add the pending audio data for later sending
			if (this.pendingAudioData.length + uint8Data.length <= MAX_AUDIO_BLOCK_BYTES) {
				const oldLength = this.pendingAudioData.length;
				this.pendingAudioDataBuffer.resize(this.pendingAudioData.byteLength + uint8Data.byteLength);
				this.pendingAudioData.set(uint8Data, oldLength);
			} else {
				// Would exceed MAX_AUDIO_BLOCK_BYTES, encode current buffer and start new one
				const encodedAudio = safeToBase64(this.pendingAudioData);
				this.sendAudioToOpenAI(encodedAudio);
				this.pendingAudioDataBuffer.resize(uint8Data.byteLength);
				this.pendingAudioData.set(uint8Data);
			}
			this.metricCache.increment({
				name: 'openai_audio_queued',
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

	private sendAudioToOpenAI(encodedAudio: string): void {
		if (!this.openaiWebSocket) {
			this.logError(`No websocket available for tag: ${this.localTag}`);
			return;
		}

		try {
			const audioMessage = {
				type: 'input_audio_buffer.append',
				audio: encodedAudio,
			};
			const audioMessageString = JSON.stringify(audioMessage);

			this.openaiWebSocket.send(audioMessageString);
			this.metricCache.increment({
				name: 'openai_audio_sent',
				worker: 'opus-transcriber-proxy',
			});
		} catch (error) {
			this.logError(`Failed to send audio to OpenAI for tag ${this.localTag}`, error);
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioData.length === 0) {
			return;
		}

		this.log(`Processing ${this.pendingAudioData.length} bytes of queued audio data for tag: ${this.localTag}`);

		const encodedAudio = safeToBase64(this.pendingAudioData);
		this.pendingAudioDataBuffer.resize(0);

		this.sendAudioToOpenAI(encodedAudio);
	}

	private async handleOpenAIMessage(data: any): Promise<void> {
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(data);
		} catch (parseError) {
			this.logError(`Failed to parse OpenAI message as JSON for tag ${this.localTag}:`, parseError);
			return;
		}

		// Handle specific event types

		// Events to log with minimal info (just event type)
		const minimalLogEvents = [
			'response.audio_transcript.delta',
			'response.output_audio_transcript.delta',
			'input_audio_buffer.speech_started',
			'input_audio_buffer.speech_stopped',
			'conversation.item.added',
			'response.content_part.done',
			'input_audio_buffer.committed',
			'response.created',
			'response.output_item.added',
			'response.content_part.added',
			'response.output_audio_transcript.done',
			'response.output_item.done',
			'conversation.item.done',
		];

		if (minimalLogEvents.includes(parsedMessage.type)) {
			this.log(`[${this.options.targetLanguage}] Received event: ${parsedMessage.type}`);
			return;
		}

		// Special handling for audio delta - encode to Opus
		if (parsedMessage.type === 'response.output_audio.delta') {
			const delta = parsedMessage.delta;
			if (delta) {
				this.log(`[${this.options.targetLanguage}] Received audio delta, length: ${delta.length}`);

				// Feed the PCM audio to the Opus encoder
				if (this.encoderStatus === 'ready' && this.opusEncoder) {
					try {
						// delta is base64-encoded PCM16 audio at 24kHz
						const opusFrames = this.opusEncoder.encodeFrame(delta);
						if (opusFrames.length > 0) {
							this.log(`Encoded ${opusFrames.length} opus frames, total bytes: ${opusFrames.reduce((sum, f) => sum + f.length, 0)}`);

							// Send each frame back to the client
							for (const frame of opusFrames) {
								this.sendAudioFrame(frame);
							}
						}
					} catch (error) {
						this.logError(`Failed to encode audio delta:`, error);
					}
				} else {
					this.log(`Encoder not ready, status: ${this.encoderStatus}`);
				}
			}
			return;
		}

		// Special handling for response.done - extract and send back transcript
		if (parsedMessage.type === 'response.done') {
			this.log(`response.done received, full message: ${JSON.stringify(parsedMessage)}`);

			// Mark that the next audio delta will be the first frame of a new response
			this.isFirstFrameOfResponse = true;

			// Try different possible paths for the transcript
			const transcript =
				parsedMessage.response?.output?.[0]?.content?.[0]?.transcript ||
				parsedMessage.output?.[0]?.content?.[0]?.transcript ||
				'(no transcript)';

			this.log(`[${this.options.targetLanguage}] ${parsedMessage.type}: ${transcript}`);

			// Fire the onTranscription callback if set
			this.log(`onTranscription callback is ${this.onTranscription ? 'set' : 'not set'}`);
			if (transcript !== '(no transcript)') {
				this.log(`Calling onTranscription with transcript: ${transcript}`);
				this.onTranscription?.(transcript, this.options.targetLanguage);
			} else {
				this.log(`Transcript is "(no transcript)", not calling callback`);
			}
			return;
		}

		// For all other events, log the event type and full content
		this.log(`[${this.options.targetLanguage}] Received event: ${parsedMessage.type}`);
		console.log(`[${this.connectionId}] [${this.options.targetLanguage}] Full event:`, JSON.stringify(parsedMessage, null, 2));

		// Handle errors
		if (parsedMessage.type === 'error') {
			this.logError(`OpenAI sent error message for ${this.localTag}: ${data}`);
			writeMetric(this.env.METRICS, {
				name: 'openai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			this.doClose(true);
			this.onError?.(this.localTag, `OpenAI service sent error message: ${data}`);
		}
	}

	private sendAudioFrame(opusFrame: Uint8Array): void {
		// Handle timestamp logic
		if (this.startWallClockTime === undefined) {
			// First packet ever
			this.startWallClockTime = Date.now();
			this.timestamp48kHz = 0;
			this.isFirstFrameOfResponse = false;
		} else if (this.isFirstFrameOfResponse) {
			// First packet of a new response
			const now = Date.now();
			const elapsedMs = now - this.startWallClockTime;
			// Convert to 48kHz ticks (48000 ticks per second)
			this.timestamp48kHz = Math.round((elapsedMs / 1000) * 48000);
			this.currentResponseStartTime = now;
			this.isFirstFrameOfResponse = false;
		}
		// else: subsequent packets in same response, timestamp will be incremented below

		// Increment counters
		this.chunkCounter++;
		TranslateConnection.globalSequenceNumber++;

		// Base64 encode the opus frame
		const payload = opusFrame.toBase64();

		// Call the callback
		this.onAudioFrame?.(this.localTag, this.chunkCounter, this.timestamp48kHz, payload, TranslateConnection.globalSequenceNumber);

		// Increment timestamp by frame length
		// Frame is 480 samples at 24kHz = 20ms
		// At 48kHz: 20ms = 960 ticks
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

		this.openaiWebSocket?.close();
		this.openaiWebSocket = undefined;
		this.connectionStatus = 'closed';

		if (notify) {
			this.onClosed?.(this.localTag);
		}
	}
}
