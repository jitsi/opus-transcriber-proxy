import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import type { TranscriptionMessage } from './transcriberproxy';

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

	onInterimTranscription?: (message: TranscriptionMessage) => void = undefined;
	onCompleteTranscription?: (message: TranscriptionMessage) => void = undefined;
	onClosed?: (tag: string) => void = undefined;

	constructor(tag: string, env: Env) {
		this.setTag(tag);

		this.initializeOpusDecoder();
		this.initializeOpenAIWebSocket(env);
	}

	reset(newTag: string) {
		if (this.connectionStatus == 'connected') {
			this.pendingTags.push(newTag);
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
								transcription: {
									model: 'gpt-4o-transcribe',
									language: 'en', // TODO parameterize this
								},
								turn_detection: {
									type: 'server_vad',
									threshold: 0.5,
									prefix_padding_ms: 300,
									silence_duration_ms: 500,
								},
							},
						},
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
				this.doClose(true);
				this.connectionStatus = 'failed';
			});

			openaiWs.addEventListener('close', () => {
				console.log(`OpenAI WebSocket closed for tag: ${this._tag}`);
				this.doClose(true);
				this.connectionStatus = 'failed';
			});
		} catch (error) {
			console.error(`Failed to create OpenAI WebSocket connection for tag ${this._tag}:`, error);
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

		if (Number.isInteger(mediaEvent.media?.chunk) && Number.isInteger(mediaEvent.media.timestamp)) {
			if (this.lastChunkNo != -1 && mediaEvent.media.chunk != this.lastChunkNo - 1) {
				const chunkDelta = mediaEvent.media.chunk - this.lastChunkNo;
				const timestampDelta = mediaEvent.media.timestamp - this.lastTimestamp;
				if (chunkDelta <= 0 || timestampDelta <= 0) {
					// Packets reordered, drop this packet
					return;
				}

				// Packets lost, do concealment
				if (this.decoderStatus == 'ready') {
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

		/* Make sure numbers make sense */
		const chunkDeltaInSamples = chunkDelta * this.lastOpusFrameSize;
		const timestampDeltaInSamples = (timestampDelta / 48000) * 24000;
		const maxConcealment = 120 * 24; /* 120 ms at 24 kHz */

		const samplesToConceal = Math.min(chunkDeltaInSamples, timestampDeltaInSamples, maxConcealment);

		try {
			const concealedAudio = this.opusDecoder.conceal(opusFrame, samplesToConceal);
			this.sendOrEnqueueDecodedAudio(concealedAudio.pcmData);
		} catch (error) {
			console.error(`Error concealing ${samplesToConceal} samples for tag ${this._tag}:`, error);
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
				return;
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
		} catch (error) {
			console.error(`Failed to send audio to OpenAI for tag ${this._tag}`, error);
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

	private getTranscriptionMessage(transcript: string, timestamp: number, isInterim: boolean): TranscriptionMessage {
		const message: TranscriptionMessage = {
			transcript: [{ text: transcript }],
			is_interim: isInterim,
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
			if (this.lastTranscriptTime !== undefined) {
				this.lastTranscriptTime = now;
			}
			const transcription = this.getTranscriptionMessage(parsedMessage.delta, now, true);
			this.onInterimTranscription?.(transcription);
		} else if (parsedMessage.type === 'conversation.item.input_audio_transcription.completed') {
			let transcriptTime;
			if (this.lastTranscriptTime !== undefined) {
				transcriptTime = this.lastTranscriptTime;
				this.lastTranscriptTime = undefined;
			} else {
				transcriptTime = Date.now();
			}
			const transcription = this.getTranscriptionMessage(parsedMessage.transcript, transcriptTime, false);
			this.onCompleteTranscription?.(transcription);
		} else if (parsedMessage.type === 'input_audio_buffer.cleared') {
			// Reset completed
			this.setTag(this.pendingTags.shift()!);
		} else if (parsedMessage.type === 'error') {
			console.error(`OpenAI sent error message for ${this._tag}: ${data}`);
			this.doClose(true);
		}
		// TODO: are there any other messages we care about?
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
