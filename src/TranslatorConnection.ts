import { OpusDecoder } from './OpusDecoder/OpusDecoder';
import { OpusEncoder } from './OpusEncoder/OpusEncoder';
import { RtpTimestamper } from './RtpTimestamper';
import { writeMetric } from './metrics';
import { MetricCache } from './MetricCache';
import { config } from './config';
import logger from './logger';

// gpt-realtime-translate is the dedicated speech-to-speech translation model.
// Lives at the /v1/realtime/translations endpoint.
// Returns translated audio plus transcript deltas. Requires tier 1+ access.
// Docs: https://developers.openai.com/api/docs/models/gpt-realtime-translate
const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';

// The maximum number of bytes of audio OpenAI allows to be sent at a time.
const MAX_AUDIO_BLOCK_BYTES = (15 * 1024 * 1024 * 3) / 4;

function safeToBase64(array: Uint8Array): string {
	if (!(array.buffer instanceof ArrayBuffer) || !(array.buffer as any).resizable) {
		return Buffer.from(array).toString('base64');
	}
	const tmpArray = new Uint8Array(array);
	return Buffer.from(tmpArray).toString('base64');
}

function fromBase64(str: string): Uint8Array {
	return Buffer.from(str, 'base64');
}

// Threshold for "this PCM chunk contains speech, not silence". Int16 PCM
// samples are in [-32768, 32767]; speech RMS is typically >500, room silence
// is <50. We use 250 as a conservative gate that ignores low-level background
// noise but accepts even quiet speech.
const SPEECH_RMS_THRESHOLD = 250;

function pcmContainsSpeech(pcmBytes: Uint8Array): boolean {
	const sampleCount = pcmBytes.byteLength >> 1;
	if (sampleCount === 0) return false;
	const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
	let sumSquares = 0;
	for (let i = 0; i < sampleCount; i++) {
		const s = view.getInt16(i << 1, true);
		sumSquares += s * s;
	}
	const rms = Math.sqrt(sumSquares / sampleCount);
	return rms > SPEECH_RMS_THRESHOLD;
}

// Supported target languages for the gpt-realtime-translate endpoint.
// From https://github.com/openai/openai-cookbook examples/voice_solutions/realtime_translation_guide/.
const SUPPORTED_TARGET_LANGUAGES = new Set([
	'en', 'es', 'pt', 'fr', 'ja', 'ru', 'zh', 'de', 'ko', 'hi', 'id', 'vi', 'it',
]);

const LANGUAGE_NAME_TO_ISO: Record<string, string> = {
	english: 'en',
	spanish: 'es',
	portuguese: 'pt',
	french: 'fr',
	japanese: 'ja',
	russian: 'ru',
	chinese: 'zh',
	mandarin: 'zh',
	german: 'de',
	korean: 'ko',
	hindi: 'hi',
	indonesian: 'id',
	vietnamese: 'vi',
	italian: 'it',
};

/**
 * Normalise a `?lang=` URL parameter to the 2-letter ISO code the
 * /v1/realtime/translations endpoint expects. Accepts both ISO codes
 * ("en", "es") and full English names ("english", "spanish").
 */
export function normalizeTargetLanguage(input: string): string {
	const lower = input.trim().toLowerCase();
	if (SUPPORTED_TARGET_LANGUAGES.has(lower)) return lower;
	const mapped = LANGUAGE_NAME_TO_ISO[lower];
	if (mapped && SUPPORTED_TARGET_LANGUAGES.has(mapped)) return mapped;
	throw new Error(
		`Unsupported target language "${input}". Supported: ${Array.from(SUPPORTED_TARGET_LANGUAGES).join(', ')}`,
	);
}

export interface TranslatorConnectionOptions {
	/** ISO 2-letter target language code (e.g. "en", "es"). */
	targetLanguage: string;
}

export class TranslatorConnection {
	private static connectionCounter = 0;
	private connectionId: string;

	private localTag!: string;
	public get tag() {
		return this.localTag;
	}

	private connectionStatus: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private encoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	// Guards doClose so teardown + onClosed run exactly once (a WS error is always followed by a close event).
	private isClosed = false;
	private opusDecoder?: OpusDecoder<24000>;
	private opusEncoder?: OpusEncoder;
	private openaiWebSocket?: WebSocket;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingAudioData: Uint8Array = new Uint8Array(0);

	private _lastMediaTime: number = -1;
	public get lastMediaTime() {
		return this._lastMediaTime;
	}

	private lastChunkNo: number = -1;
	private lastTimestamp: number = -1;
	private lastOpusFrameSize: number = -1;

	private totalSamplesSent: number = 0;
	private lastLoggedSecond: number = 0;

	private static globalSequenceNumber: number = 0;
	private readonly rtpTimestamper = new RtpTimestamper();

	onError?: (tag: string, error: any) => void = undefined;
	onClosed?: (tag: string) => void = undefined;
	onTranscription?: (transcript: string, targetLanguage: string) => void = undefined;
	onAudioFrame?: (tag: string, chunk: number, timestamp: number, payload: string, sequenceNumber: number) => void = undefined;

	// Per-response latency measurement.
	// firstInputToFirstOutput (TTFA — "time to first audio") = wall-clock from
	//   the FIRST speech chunk we forwarded to OpenAI to the first translated
	//   audio frame returned. The headline number — how long the listener waits
	//   after the speaker starts before hearing translation begin.
	//
	// lastInputToFirstOutput = wall-clock from the MOST RECENT speech chunk we
	//   forwarded to the first translated audio frame. For a simultaneous
	//   translator this approaches ~0 because both streams are concurrent.
	//   Useful as "ongoing interpreter lag" if you sample it mid-response.
	//
	// firstInputAt / lastInputAppendAt update only on PCM chunks with RMS
	// above SPEECH_RMS_THRESHOLD — silence-padding chunks are ignored.
	// All reset to null on session.output_audio.done so each response window
	// is measured independently.
	private firstInputAt: number | null = null;
	private lastInputAppendAt: number | null = null;
	private firstOutputAt: number | null = null;
	private responseIndex: number = 0;

	private options: TranslatorConnectionOptions;
	private metricCache: MetricCache;

	constructor(tag: string, options: TranslatorConnectionOptions) {
		this.connectionId = `translator-conn-${++TranslatorConnection.connectionCounter}`;
		this.localTag = tag;
		this.options = options;
		this.metricCache = new MetricCache(undefined);

		this.initializeOpusDecoder();
		this.initializeOpusEncoder();
		this.initializeOpenAIWebSocket();
	}

	private log(message: string): void {
		logger.debug(`[${this.connectionId}] ${message}`);
	}

	private logError(message: string, error?: any): void {
		if (error !== undefined) {
			logger.error(`[${this.connectionId}] ${message}`, error);
		} else {
			logger.error(`[${this.connectionId}] ${message}`);
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
			// Notify before doClose() detaches the callbacks.
			this.onError?.(this.localTag, `Error initializing Opus decoder: ${error instanceof Error ? error.message : String(error)}`);
			this.doClose(true);
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
			// Notify before doClose() detaches the callbacks. Without the encoder the return path can't produce
			// translated audio, so tear the connection down (matching the decoder path) instead of leaving it
			// open and silently dropping every translated frame.
			this.onError?.(this.localTag, `Error initializing Opus encoder: ${error instanceof Error ? error.message : String(error)}`);
			this.doClose(true);
		}
	}

	private initializeOpenAIWebSocket(): void {
		try {
			const apiKey = config.openai.apiKey;
			const openaiWs = new WebSocket(OPENAI_WS_URL, ['realtime', `openai-insecure-api-key.${apiKey}`]);

			this.log(`Opening OpenAI WebSocket for translation to ${this.options.targetLanguage}`);

			this.openaiWebSocket = openaiWs;

			openaiWs.addEventListener('open', () => {
				this.log(`OpenAI WebSocket connected for translation to ${this.options.targetLanguage}`);
				this.connectionStatus = 'connected';

				// Canonical session schema for /v1/realtime/translations, per
				// openai/openai-cookbook examples/voice_solutions/realtime_translation_guide/.
				// Target language goes under audio.output.language as a 2-letter
				// ISO code. The endpoint deliberately rejects session.instructions,
				// session.type, session.output_modalities, voice, etc. — the model
				// is purpose-built and intentionally unprompt-able to keep it
				// translation-only (per the cookbook guide).
				const sessionConfig = {
					type: 'session.update',
					session: {
						audio: {
							output: {
								language: this.options.targetLanguage,
							},
						},
					},
				};

				openaiWs.send(JSON.stringify(sessionConfig));
				this.processPendingAudioData();
			});

			openaiWs.addEventListener('message', (event) => {
				this.handleOpenAIMessage(event.data);
			});

			openaiWs.addEventListener('error', (event) => {
				const errorMessage = (event as { message?: string; }).message ?? 'WebSocket error';
				this.logError(`OpenAI WebSocket error for tag ${this.localTag}: ${errorMessage}`);
				writeMetric(undefined, {
					name: 'openai_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'websocket_error',
				});
				// Notify before doClose() detaches the callbacks. doClose() is idempotent, so the close event
				// that always follows an error is a no-op.
				this.onError?.(this.localTag, `Error connecting to OpenAI service: ${errorMessage}`);
				this.doClose(true);
			});

			openaiWs.addEventListener('close', (event) => {
				this.log(
					`OpenAI WebSocket closed for tag ${this.localTag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
				);
				this.doClose(true);
			});
		} catch (error) {
			this.logError(`Failed to create OpenAI WebSocket for tag ${this.localTag}:`, error);
			writeMetric(undefined, {
				name: 'openai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'connection_failed',
			});
			this.connectionStatus = 'failed';
			this.onError?.(this.localTag, `Failed to connect to OpenAI service: ${error instanceof Error ? error.message : String(error)}`);
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
			opusFrame = fromBase64(mediaEvent.media.payload);
		} catch (error) {
			this.logError(`Failed to decode base64 media payload for tag ${this.localTag}:`, error);
			return;
		}

		this.metricCache.increment({
			name: 'audio_packet_received',
			worker: 'opus-transcriber-proxy',
		});

		if (Number.isInteger(mediaEvent.media?.chunk) && Number.isInteger(mediaEvent.media.timestamp)) {
			if (this.lastChunkNo != -1 && mediaEvent.media.chunk != this.lastChunkNo + 1) {
				const chunkDelta = mediaEvent.media.chunk - this.lastChunkNo;
				if (chunkDelta <= 0) {
					writeMetric(undefined, {
						name: 'audio_packet_discarded',
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
		} else {
			this.log(`Not queueing opus frame for tag: ${this.localTag}: decoder ${this.decoderStatus}`);
		}
	}

	private doConcealment(opusFrame: Uint8Array, chunkDelta: number, timestampDelta: number) {
		if (!this.opusDecoder) return;

		const lostFrames = chunkDelta - 1;
		if (lostFrames <= 0 || this.lastOpusFrameSize <= 0) return;

		const lostFramesInSamples = lostFrames * this.lastOpusFrameSize;
		const timestampDeltaInSamples = timestampDelta > 0 ? (timestampDelta / 48000) * 24000 : Infinity;
		const maxConcealment = 120 * 24; /* 120 ms at 24 kHz */

		const samplesToConceal = Math.min(lostFramesInSamples, timestampDeltaInSamples, maxConcealment);

		try {
			const concealedAudio = this.opusDecoder.conceal(opusFrame, samplesToConceal);
			if (concealedAudio.errors.length > 0) {
				writeMetric(undefined, {
					name: 'audio_decode_failure',
					worker: 'opus-transcriber-proxy',
				});
			} else {
				this.sendOrEnqueueDecodedAudio(concealedAudio.audioData);
				writeMetric(undefined, {
					name: 'audio_loss_concealment',
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
				writeMetric(undefined, {
					name: 'audio_decode_failure',
					worker: 'opus-transcriber-proxy',
				});
				return;
			}
			this.metricCache.increment({
				name: 'audio_packet_decoded',
				worker: 'opus-transcriber-proxy',
			});
			this.lastOpusFrameSize = decodedAudio.samplesDecoded;
			this.sendOrEnqueueDecodedAudio(decodedAudio.audioData);
		} catch (error) {
			this.logError(`Error processing audio data for tag ${this.localTag}:`, error);
		}
	}

	private sendOrEnqueueDecodedAudio(audioData: Uint8Array) {
		const samplesSent = audioData.length / 2; // 16-bit samples
		this.totalSamplesSent += samplesSent;
		const currentSecond = Math.floor(this.totalSamplesSent / 24000);
		if (currentSecond > this.lastLoggedSecond) {
			this.log(`Sent ${currentSecond} second(s) of audio for tag: ${this.localTag}`);
			this.lastLoggedSecond = currentSecond;
		}

		// Latency measurement: only update timestamps on speech chunks (RMS
		// gate). Silence padding doesn't count.
		if (pcmContainsSpeech(audioData)) {
			const now = Date.now();
			if (this.firstInputAt === null) {
				this.firstInputAt = now;
			}
			this.lastInputAppendAt = now;
		}

		if (this.connectionStatus === 'connected' && this.openaiWebSocket) {
			const encodedAudio = safeToBase64(audioData);
			this.sendAudioToOpenAI(encodedAudio);
		} else if (this.connectionStatus === 'pending') {
			if (this.pendingAudioData.length + audioData.length <= MAX_AUDIO_BLOCK_BYTES) {
				const merged = new Uint8Array(this.pendingAudioData.length + audioData.length);
				merged.set(this.pendingAudioData);
				merged.set(audioData, this.pendingAudioData.length);
				this.pendingAudioData = merged;
			} else {
				// Connection still pending and the buffer is full (~234 s of audio) — drop the accumulated
				// audio rather than send on a socket that has not opened yet. processPendingAudioData flushes
				// the buffer once the connection opens.
				this.log(`Dropping buffered audio for tag ${this.localTag}: pending buffer full before connect`);
				this.pendingAudioData = new Uint8Array(audioData);
			}
		} else {
			this.log(`Not queueing audio data for tag: ${this.localTag}: connection ${this.connectionStatus}`);
		}
	}

	private processPendingOpusFrames(): void {
		if (this.pendingOpusFrames.length === 0) return;

		this.log(`Processing ${this.pendingOpusFrames.length} queued media payloads for tag: ${this.localTag}`);

		const queued = [...this.pendingOpusFrames];
		this.pendingOpusFrames = [];

		for (const frame of queued) {
			this.processOpusFrame(frame);
		}
	}

	private sendAudioToOpenAI(encodedAudio: string): void {
		if (!this.openaiWebSocket) {
			this.logError(`No websocket available for tag: ${this.localTag}`);
			return;
		}

		try {
			// The /v1/realtime/translations endpoint requires the "session."
			// prefix on client message types. Only session.update,
			// session.input_audio_buffer.append, and session.close are accepted.
			// VAD and response triggering are handled server-side automatically.
			this.openaiWebSocket.send(JSON.stringify({
				type: 'session.input_audio_buffer.append',
				audio: encodedAudio,
			}));
			this.metricCache.increment({
				name: 'backend_audio_sent',
				worker: 'opus-transcriber-proxy',
			});
		} catch (error) {
			this.logError(`Failed to send audio to OpenAI for tag ${this.localTag}`, error);
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioData.length === 0) return;

		this.log(`Processing ${this.pendingAudioData.length} bytes of queued audio for tag: ${this.localTag}`);

		const encodedAudio = safeToBase64(this.pendingAudioData);
		this.pendingAudioData = new Uint8Array(0);

		this.sendAudioToOpenAI(encodedAudio);
	}

	private handleOpenAIMessage(data: any): void {
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(data);
		} catch (parseError) {
			this.logError(`Failed to parse OpenAI message as JSON for tag ${this.localTag}:`, parseError);
			return;
		}

		// JSON.parse can succeed and still yield null (e.g. data was null, a
		// non-text frame, or the literal "null"). Guard against it so the WS
		// message listener never throws and crashes the process.
		if (parsedMessage === null || typeof parsedMessage !== 'object' || typeof parsedMessage.type !== 'string') {
			this.log(`Ignoring non-object/typeless OpenAI message for tag ${this.localTag}`);
			return;
		}

		// Note: the response.output_audio_transcript.delta/done events are intentionally NOT listed here — they
		// are real transcript events for the general /v1/realtime endpoint and are handled below (the early
		// return for minimalLogEvents would otherwise make those handlers dead code).
		const minimalLogEvents = [
			'response.audio_transcript.delta',
			'input_audio_buffer.speech_started',
			'input_audio_buffer.speech_stopped',
			'conversation.item.added',
			'response.content_part.done',
			'input_audio_buffer.committed',
			'response.created',
			'response.output_item.added',
			'response.content_part.added',
			'response.output_item.done',
			'conversation.item.done',
		];

		if (minimalLogEvents.includes(parsedMessage.type)) {
			this.log(`[${this.options.targetLanguage}] Received event: ${parsedMessage.type}`);
			return;
		}

		// The /v1/realtime/translations endpoint emits "session.output_*"
		// event names; the general /v1/realtime endpoint emits "response.output_*".
		// Accept both so this class works against either endpoint.
		if (
			parsedMessage.type === 'response.output_audio.delta'
			|| parsedMessage.type === 'session.output_audio.delta'
		) {
			const delta = parsedMessage.delta;
			if (delta) {
				// Latency: capture both TTFA and ongoing-lag on the first
				// audio.delta of this response window. For a simultaneous
				// translator the headline metric is TTFA.
				if (this.firstOutputAt === null) {
					this.firstOutputAt = Date.now();
					this.responseIndex++;
					const ttfa = this.firstInputAt !== null
						? this.firstOutputAt - this.firstInputAt
						: null;
					const lastInputToFirstOutput = this.lastInputAppendAt !== null
						? this.firstOutputAt - this.lastInputAppendAt
						: null;
					logger.info(
						`[${this.connectionId}] [${this.options.targetLanguage}] `
						+ `Translator latency response=${this.responseIndex} `
						+ `TTFA=${ttfa}ms lastInputToFirstOutput=${lastInputToFirstOutput}ms`,
					);
				}
				this.log(`[${this.options.targetLanguage}] Received audio delta, length: ${delta.length}`);

				if (this.encoderStatus === 'ready' && this.opusEncoder) {
					try {
						// delta is base64-encoded PCM16 audio at 24kHz
						const pcmBytes = fromBase64(delta);
						const opusFrames = this.opusEncoder.encodeFrame(pcmBytes);
						if (opusFrames.length > 0) {
							for (const frame of opusFrames) {
								this.sendAudioFrame(frame);
							}
						}
					} catch (error) {
						this.logError(`Failed to encode audio delta:`, error);
					}
				}
			}
			return;
		}

		// Transcript stream (text accompaniment of the translated audio).
		if (
			parsedMessage.type === 'session.output_transcript.delta'
			|| parsedMessage.type === 'response.output_audio_transcript.delta'
		) {
			// Emit deltas as transcription callbacks; the consumer (server.ts)
			// gates on `sendBack` and forwards to the client.
			if (typeof parsedMessage.delta === 'string' && parsedMessage.delta) {
				this.onTranscription?.(parsedMessage.delta, this.options.targetLanguage);
			}
			return;
		}

		// Final transcript. Emitted only from the transcript-done events so it fires once per utterance — the
		// /v1/realtime/translations endpoint sends both session.output_transcript.done and response.done for the
		// same utterance, and the audio-done events (below) carry no transcript.
		if (
			parsedMessage.type === 'session.output_transcript.done'
			|| parsedMessage.type === 'response.output_audio_transcript.done'
		) {
			const transcript =
				parsedMessage.transcript
				|| parsedMessage.response?.output?.[0]?.content?.[0]?.transcript
				|| parsedMessage.output?.[0]?.content?.[0]?.transcript;
			if (typeof transcript === 'string' && transcript) {
				this.log(`[${this.options.targetLanguage}] ${parsedMessage.type}: ${transcript}`);
				this.onTranscription?.(transcript, this.options.targetLanguage);
			} else {
				this.log(`[${this.options.targetLanguage}] ${parsedMessage.type}`);
			}
			return;
		}

		// End-of-utterance markers (audio-stream end / response complete). Reset the per-response latency
		// window so the next response is measured from its own input. The RTP timeline is NOT reset here —
		// RtpTimestamper keeps one continuous, monotonic timeline across responses and inserts the real
		// silence gap on the next frame. These events do not carry the transcript (emitted above).
		if (
			parsedMessage.type === 'session.output_audio.done'
			|| parsedMessage.type === 'response.output_audio.done'
			|| parsedMessage.type === 'response.done'
		) {
			this.firstOutputAt = null;
			this.firstInputAt = null;
			this.lastInputAppendAt = null;
			this.log(`[${this.options.targetLanguage}] ${parsedMessage.type}`);
			return;
		}

		this.log(`[${this.options.targetLanguage}] Received event: ${parsedMessage.type}`);

		if (parsedMessage.type === 'error') {
			this.logError(`OpenAI sent error message for ${this.localTag}: ${data}`);
			writeMetric(undefined, {
				name: 'openai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			// Notify before doClose() detaches the callbacks.
			this.onError?.(this.localTag, `OpenAI service sent error message: ${data}`);
			this.doClose(true);
		}
	}

	private sendAudioFrame(opusFrame: Uint8Array): void {
		// The RtpTimestamper produces a monotonic RTP timestamp (inserting a real-silence gap when the
		// source idled longer than the buffered media) and a uint16 RTP sequence number. JVB's
		// Conference.handleMediaMessage reinterprets `media.chunk` as that 16-bit RTP sequence number.
		const { timestamp, sequenceNumber: rtpSequenceNumber } = this.rtpTimestamper.nextFrameTimestamp();

		TranslatorConnection.globalSequenceNumber++;

		const payload = Buffer.from(opusFrame).toString('base64');

		this.onAudioFrame?.(this.localTag, rtpSequenceNumber, timestamp, payload, TranslatorConnection.globalSequenceNumber);
	}

	close(): void {
		this.doClose(false);
	}

	private doClose(notify: boolean): void {
		if (this.isClosed) {
			return;
		}
		this.isClosed = true;

		// Detach callbacks before teardown so a late OpenAI event firing during close() can't re-emit on the
		// proxy. Keep onClosed locally so we can notify exactly once after everything is torn down.
		const onClosed = this.onClosed;
		this.onClosed = undefined;
		this.onError = undefined;
		this.onTranscription = undefined;
		this.onAudioFrame = undefined;

		this.connectionStatus = 'closed';
		this.decoderStatus = 'closed';
		this.encoderStatus = 'closed';

		this.metricCache.flush();
		this.opusDecoder?.free();
		this.opusDecoder = undefined;
		this.opusEncoder?.free();
		this.opusEncoder = undefined;
		this.openaiWebSocket?.close();
		this.openaiWebSocket = undefined;

		if (notify) {
			onClosed?.(this.localTag);
		}
	}
}
