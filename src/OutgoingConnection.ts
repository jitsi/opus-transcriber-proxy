import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import type { TranscriptionMessage, TranscriberProxyOptions } from './transcriberproxy';
import { getTurnDetectionConfig } from './utils';
import { writeMetric } from './metrics';

// Type definition augmentation for Uint8Array - Cloudflare Worker's JS has these methods but TypeScript doesn't have
// declarations for them as of version 5.9.3.
// These definitions are taken from https://github.com/microsoft/TypeScript/pull/61696, which should be included
// in TypeScript 6.0 and later.
declare global {
	interface Uint8ArrayConstructor {
		/**
		 * Creates a new `Uint8Array` from a base64-encoded string.
		 * @param string The base64-encoded string.
		 * @param options If provided, specifies the alphabet and handling of the last chunk.
		 * @returns A new `Uint8Array` instance.
		 * @throws {SyntaxError} If the input string contains characters outside the specified alphabet, or if the last
		 * chunk is inconsistent with the `lastChunkHandling` option.
		 */
		fromBase64(
			string: string,
			options?: {
				alphabet?: 'base64' | 'base64url' | undefined;
				lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' | undefined;
			},
		): Uint8Array<ArrayBuffer>;
	}

	interface Uint8Array<TArrayBuffer extends ArrayBufferLike> {
		/**
		 * Converts the `Uint8Array` to a base64-encoded string.
		 * @param options If provided, sets the alphabet and padding behavior used.
		 * @returns A base64-encoded string.
		 */
		toBase64(options?: { alphabet?: 'base64' | 'base64url' | undefined; omitPadding?: boolean | undefined }): string;
	}
}

const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

// The maximum number of bytes of audio OpenAI allows to be sent at a time.
// OpenAI specifies this 15 MiB of base64-encoded audio, so divide by 3/4 to get the size in raw bytes.
// It's unlikely we'll hit this limit (it's ~4 minutes of audio at 24000 Hz) but better safe than sorry
const MAX_AUDIO_BLOCK_BYTES = (15 * 1024 * 1024 * 3) / 4;

// Safely create a base64 representation of a Uint8Array.  There's a bug in current versions of the v8 engine that
// toBase64 doesn't work on an array backed by a resizable buffer.
// TODO: test whether this bug is present, and fast-path this function if not.
function safeToBase64(array: Uint8Array): string {
	if (!(array.buffer instanceof ArrayBuffer) || !array.buffer.resizable) {
		return array.toBase64();
	}
	const tmpArray = new Uint8Array(array);
	return tmpArray.toBase64();
}

const tagMatcher = /^([0-9a-fA-F]+)-([0-9]+)$/;

export class OutgoingConnection {
	private _tag!: string;
	public get tag() {
		return this._tag;
	}
	private setTag(newTag: string) {
		this._tag = newTag;
		const match = tagMatcher.exec(newTag);
		if (match !== null && match.length === 3) {
			this.participant = { id: match[1], ssrc: match[2] };
		} else {
			this.participant = { id: newTag };
		}
	}
	private participant: any;
	private pendingTags: string[] = [];
	private connectionStatus: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private opusDecoder?: OpusDecoder<24000>;
	private openaiWebSocket?: WebSocket;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingAudioDataBuffer = new ArrayBuffer(0, { maxByteLength: MAX_AUDIO_BLOCK_BYTES });
	private switchAudioBuffer = new ArrayBuffer(0, { maxByteLength: MAX_AUDIO_BLOCK_BYTES });
	private pendingAudioData: Uint8Array = new Uint8Array(this.pendingAudioDataBuffer);
	private pendingAudioFrames: string[] = [];

	private _lastMediaTime: number = -1;
	public get lastMediaTime() {
		return this._lastMediaTime;
	}

	private lastChunkNo: number = -1;
	private lastTimestamp: number = -1;
	private lastOpusFrameSize: number = -1;

	private lastTranscriptTime?: number = undefined;
	private resetting: boolean = false;
	private switchAudioData: Uint8Array = new Uint8Array(this.switchAudioBuffer);

	onInterimTranscription?: (message: TranscriptionMessage) => void = undefined;
	onCompleteTranscription?: (message: TranscriptionMessage) => void = undefined;
	onClosed?: (tag: string) => void = undefined;
	onOpenAIError?: (errorType: string, errorMessage: string) => void = undefined;
	onError?: (tag: string, error: any) => void = undefined;

	private env: Env;
	private options: TranscriberProxyOptions;

	constructor(tag: string, env: Env, options: TranscriberProxyOptions) {
		this.setTag(tag);
		this.env = env;
		this.options = options;

		this.initializeOpusDecoder();
		this.initializeOpenAIWebSocket(env);
	}

	reset(newTag: string) {
		if (this.connectionStatus == 'connected') {
			this.resetting = true;
			this.pendingTags.push(newTag);

			const commitMessage = { type: 'input_audio_buffer.commit' };
			this.openaiWebSocket?.send(JSON.stringify(commitMessage));

			const clearMessage = { type: 'input_audio_buffer.clear' };
			this.openaiWebSocket?.send(JSON.stringify(clearMessage));
		} else {
			this.setTag(newTag);
		}
		if (this.decoderStatus === 'ready') {
			this.opusDecoder?.reset();
		}
		// Reset the pending audio buffer
		this.pendingAudioFrames = [];
		this.pendingAudioDataBuffer.resize(0);
	}

	private async initializeOpusDecoder(): Promise<void> {
		try {
			console.log(`Creating Opus decoder for tag: ${this._tag}`);
			this.opusDecoder = new OpusDecoder({
				sampleRate: 24000,
				channels: 1,
			});

			await this.opusDecoder.ready;
			this.decoderStatus = 'ready';
			console.log(`Opus decoder ready for tag: ${this._tag}`);
			this.processPendingOpusFrames();
		} catch (error) {
			console.error(`Failed to create Opus decoder for tag ${this._tag}:`, error);
			this.decoderStatus = 'failed';
			this.doClose(true);
			this.onError?.(this._tag, `Error initializing Opus decoder: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private initializeOpenAIWebSocket(env: Env): void {
		try {
			const openaiWs = new WebSocket(OPENAI_WS_URL, ['realtime', `openai-insecure-api-key.${env.OPENAI_API_KEY}`]);

			console.log(`Opening OpenAI WebSocket to ${OPENAI_WS_URL} for tag: ${this._tag}`);

			this.openaiWebSocket = openaiWs;

			openaiWs.addEventListener('open', () => {
				console.log(`OpenAI WebSocket connected for tag: ${this._tag}`);
				this.connectionStatus = 'connected';

				const transcriptionConfig: { model: string; language?: string } = {
					model: env.OPENAI_MODEL || 'gpt-4o-mini-transcribe',
				};
				if (this.options.language !== null) {
					transcriptionConfig.language = this.options.language;
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
								turn_detection: getTurnDetectionConfig(env),
							},
						},
						include: ['item.input_audio_transcription.logprobs'],
					},
				};

				const configMessage = JSON.stringify(sessionConfig);
				console.log(`Initializing OpenAI config with message: ${configMessage}`);

				openaiWs.send(configMessage);

				// Process any pending audio data that was queued while waiting for connection
				this.processPendingAudioData();
			});

			openaiWs.addEventListener('message', (event) => {
				this.handleOpenAIMessage(event.data);
			});

			openaiWs.addEventListener('error', (error) => {
				console.error(`OpenAI WebSocket error for tag ${this._tag}:`, error);
				writeMetric(this.env.METRICS, {
					name: 'openai_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'websocket_error',
				});
				this.onOpenAIError?.('websocket_error', 'WebSocket connection error');
				this.doClose(true);
				this.connectionStatus = 'failed';
				this.onError?.(this._tag, `Error connecting to OpenAI service: ${error instanceof Error ? error.message : String(error)}`);
			});

			openaiWs.addEventListener('close', () => {
				console.log(`OpenAI WebSocket closed for tag: ${this._tag}`);
				this.doClose(true);
				this.connectionStatus = 'failed';
			});
		} catch (error) {
			console.error(`Failed to create OpenAI WebSocket connection for tag ${this._tag}:`, error);
			writeMetric(this.env.METRICS, {
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
			console.warn(`No media payload in event for tag: ${this._tag}`);
			return;
		}

		this._lastMediaTime = Date.now();

		let opusFrame: Uint8Array;

		try {
			// Base64 decode the media payload to binary
			opusFrame = Uint8Array.fromBase64(mediaEvent.media.payload);
		} catch (error) {
			console.error(`Failed to decode base64 media payload for tag ${this._tag}:`, error);
			return;
		}

		if (this.env.DEBUG === 'true') {
			writeMetric(this.env.METRICS, {
				name: 'opus_packet_received',
				worker: 'opus-transcriber-proxy',
			});
		}

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
			if (this.env.DEBUG === 'true') {
				writeMetric(this.env.METRICS, {
					name: 'opus_packet_queued',
					worker: 'opus-transcriber-proxy',
				});
			}
			// console.log(`Queued opus frame for tag: ${this.tag} (queue size: ${this.pendingOpusFrames.length})`);
		} else {
			console.log(`Not queueing opus frame for tag: ${this._tag}: decoder ${this.decoderStatus}`);
		}
	}

	private doConcealment(opusFrame: Uint8Array, chunkDelta: number, timestampDelta: number) {
		if (!this.opusDecoder) {
			console.error(`No opus decoder available for tag: ${this._tag}`);
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
			console.error(`Error concealing ${samplesToConceal} samples for tag ${this._tag}:`, error);
			// Don't call onError for concealment errors, as they may be transient
		}
	}

	private processOpusFrame(opusFrame: Uint8Array): void {
		if (!this.opusDecoder) {
			console.error(`No opus decoder available for tag: ${this._tag}`);
			return;
		}

		try {
			// Decode the Opus audio data
			const decodedAudio = this.opusDecoder.decodeFrame(opusFrame);
			if (decodedAudio.errors.length > 0) {
				console.error(`Opus decoding errors for tag ${this._tag}:`, decodedAudio.errors);
				writeMetric(this.env.METRICS, {
					name: 'opus_decode_failure',
					worker: 'opus-transcriber-proxy',
				});

				// Don't call onError for decoding errors, as they may be transient
				return;
			}
			if (this.env.DEBUG === 'true') {
				writeMetric(this.env.METRICS, {
					name: 'opus_packet_decoded',
					worker: 'opus-transcriber-proxy',
				});
			}
			this.lastOpusFrameSize = decodedAudio.samplesDecoded;
			this.sendOrEnqueueDecodedAudio(decodedAudio.pcmData);
		} catch (error) {
			console.error(`Error processing audio data for tag ${this._tag}:`, error);
		}
	}

	private sendOrEnqueueDecodedAudio(pcmData: Int16Array) {
		const uint8Data = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);

		if (this.connectionStatus === 'connected' && this.openaiWebSocket) {
			// If in the process of switching (after reset), buffer audio for the new participant
			if (this.resetting) {
				if (this.switchAudioData.length + uint8Data.length <= MAX_AUDIO_BLOCK_BYTES) {
					const oldLength = this.switchAudioData.length;
					this.switchAudioBuffer.resize(this.switchAudioData.byteLength + uint8Data.byteLength);
					this.switchAudioData.set(uint8Data, oldLength);
				}
				// If exceeds buffer, drop the audio (unlikely given short reset window)
				return;
			}
			const encodedAudio = uint8Data.toBase64();
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
			if (this.env.DEBUG === 'true') {
				writeMetric(this.env.METRICS, {
					name: 'openai_audio_queued',
					worker: 'opus-transcriber-proxy',
				});
			}
		} else {
			console.log(`Not queueing audio data for tag: ${this._tag}: connection ${this.connectionStatus}`);
		}
	}

	private processPendingOpusFrames(): void {
		if (this.pendingOpusFrames.length === 0) {
			return;
		}

		console.log(`Processing ${this.pendingOpusFrames.length} queued media payloads for tag: ${this._tag}`);

		// Process all queued media payloads
		const queuedPayloads = [...this.pendingOpusFrames];
		this.pendingOpusFrames = []; // Clear the queue

		for (const binaryData of queuedPayloads) {
			this.processOpusFrame(binaryData);
		}
	}

	private sendAudioToOpenAI(encodedAudio: string): void {
		if (!this.openaiWebSocket) {
			console.error(`No websocket available for for tag: ${this._tag}`);
			return;
		}

		try {
			const audioMessage = {
				type: 'input_audio_buffer.append',
				audio: encodedAudio,
			};
			const audioMessageString = JSON.stringify(audioMessage);

			this.openaiWebSocket.send(audioMessageString);
			if (this.env.DEBUG === 'true') {
				writeMetric(this.env.METRICS, {
					name: 'openai_audio_sent',
					worker: 'opus-transcriber-proxy',
				});
			}
		} catch (error) {
			console.error(`Failed to send audio to OpenAI for tag ${this._tag}`, error);
			// TODO should this call onError?
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioFrames.length === 0 && this.pendingAudioData.length === 0) {
			return;
		}

		console.log(
			`Processing ${this.pendingAudioData.length} bytes plus ${this.pendingAudioFrames.length} frames of queued audio data for tag: ${this._tag}`,
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
			console.error(`Failed to parse OpenAI message as JSON for tag ${this._tag}:`, parseError);
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
			this.onCompleteTranscription?.(transcription);
		} else if (parsedMessage.type === 'conversation.item.input_audio_transcription.failed') {
			console.error(`OpenAI failed to transcribe audio for tag ${this._tag}: ${data}`);
			writeMetric(this.env.METRICS, {
				name: 'transcription_failure',
				worker: 'opus-transcriber-proxy',
			});
		} else if (parsedMessage.type === 'input_audio_buffer.cleared') {
			// Reset completed - update state atomically
			this.lastChunkNo = -1;
			this.lastTimestamp = -1;
			this.lastOpusFrameSize = -1;
			const nextTag = this.pendingTags.shift();
			if (nextTag !== undefined) {
				this.setTag(nextTag);
			} else {
				console.error('Received cleared event but no pending tag available.');
			}
			this.resetting = false;

			// Send any audio that was buffered during the reset
			if (this.switchAudioData.length > 0) {
				const encodedAudio = safeToBase64(this.switchAudioData);
				this.sendAudioToOpenAI(encodedAudio);
				this.switchAudioBuffer.resize(0);
			}
		} else if (parsedMessage.type === 'error') {
			console.error(`OpenAI sent error message for ${this._tag}: ${data}`);
			writeMetric(this.env.METRICS, {
				name: 'openai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			this.onOpenAIError?.('api_error', parsedMessage.error?.message || data);
			this.doClose(true);
			this.onError?.(this._tag, `OpenAI service sent error message: ${data}`);
		} else if (
			parsedMessage.type !== 'session.created' &&
			parsedMessage.type !== 'session.updated' &&
			parsedMessage.type !== 'input_audio_buffer.committed'
		) {
			// Log unexpected message types that might indicate issues
			console.warn(`Unhandled OpenAI message type for ${this._tag}: ${parsedMessage.type}`);
		}
	}

	close(): void {
		this.doClose(false);
	}

	private doClose(notify: boolean): void {
		this.opusDecoder?.free();
		this.openaiWebSocket?.close();
		this.decoderStatus = 'closed';
		this.connectionStatus = 'closed';
		if (notify) {
			this.onClosed?.(this._tag);
		}
	}
}
