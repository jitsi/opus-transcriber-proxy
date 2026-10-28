/*
 * Copyright @ 2025 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { RtpTimestamper, RTP_CLOCK_RATE, FRAME_DURATION_MS } from './RtpTimestamper';
import { bytesToBase64, base64ToBytes } from './translate/base64';
import { unrefTimer } from './translate/timers';
import type { IOpusDecoder } from './OpusDecoder/opusTypes';
import type { IOpusEncoder } from './OpusEncoder/opusEncoderTypes';
import type { IWebSocket, MetricBatcher, TranslationRuntime } from './translate/runtime';
import {
	defaultTranslationProvider,
	getTranslationProvider,
	normalizeTargetLanguage,
	type TranslationProviderId,
	type TranslationProviderSpec,
} from './translate/provider';

// The provider endpoints, protocol differences and session configuration live in ./translate/provider.ts.
export { normalizeTargetLanguage };

// Caps on audio buffered before the decoder/provider socket are ready. These bound per-connection
// memory if init stalls; with N (source, language) pairs the worst case is N times these values.
// 10 s of 24 kHz 16-bit mono PCM (~480 KB) before the provider session is ready — connect is normally
// sub-second, so hitting this means the socket is stuck and the buffered audio is stale anyway.
const MAX_PENDING_PCM_BYTES = 24000 * 2 * 10;
// A provider with a `session` handshake (xAI) must answer `session.created` and `session.updated`
// within this long of the socket opening, or the direction is failed: audio buffers behind the
// handshake, so a session that never becomes ready would otherwise hold the direction open, silent.
const HANDSHAKE_TIMEOUT_MS = 10_000;
// ~10 s of 20 ms Opus frames queued while the WASM decoder initialises.
const MAX_PENDING_OPUS_FRAMES = 500;
// RTP ticks per emitted Opus frame (48000 Hz * 20 ms = 960). The talk-stop timestamp is one past the end of the run:
// the last frame's timestamp plus this, i.e. the timestamp the next contiguous packet would carry (were there no
// intervening silence before the next talk). Multiply before dividing so the arithmetic is an exact integer.
const SAMPLES_PER_FRAME = (RTP_CLOCK_RATE * FRAME_DURATION_MS) / 1000;

function safeToBase64(array: Uint8Array): string {
	return bytesToBase64(array);
}

function fromBase64(str: string): Uint8Array {
	return base64ToBytes(str);
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

/**
 * Why a connection closed, reported on `onClosed`: `local` (the owner called close()), `remote` (the
 * provider closed the socket without a preceding error, after taking audio), `rejected` (the provider
 * closed the socket before the session was usable: within `REJECTED_MAX_SESSION_AGE_MS` of creation and
 * before `REJECTED_MAX_AUDIO_SAMPLES` of audio had been sent, so during the handshake or right after it;
 * an accepted-then-dropped session, which repeated per frame would be a paid session start each
 * time), `idle` (no media for the idle-close period),
 * `error` (a failure; `onError` fired first). The owner paces a reopen after `error` and `rejected`.
 */
export type TranslatorCloseReason = 'local' | 'remote' | 'rejected' | 'idle' | 'error';

/**
 * A provider close after less audio than this (2 s at 24 kHz) is `rejected`, not `remote`: a session
 * that takes a moment of audio and then drops every time is as costly to re-dial per frame as one
 * that never took any, and a healthy provider's own closes (xAI's ~5 min idle drop and ~2 h cap)
 * come long after it.
 */
const REJECTED_MAX_AUDIO_SAMPLES = 24000 * 2;

/**
 * ...and only when the connection is younger than this. A direction that stayed open for minutes with
 * little or no audio (a muted participant with the idle close disabled) and was then dropped by the
 * provider's own idle timeout was a healthy session, not a refused one, and reopens at once.
 */
const REJECTED_MAX_SESSION_AGE_MS = 10_000;

export interface TranslatorConnectionOptions {
	/** Target language code the provider accepts (e.g. "en", "es"; see provider.ts). */
	targetLanguage: string;
	/** Speech-to-speech provider; undefined → the runtime's default (`openai`). */
	provider?: TranslationProviderId;
	/**
	 * Called periodically with the audio duration translated since the previous
	 * report, plus a final delta on close; the deltas sum to this direction's total.
	 * Reporting incrementally (rather than once at close) means an abrupt kill —
	 * e.g. a Cloudflare Worker hitting its CPU limit — only loses the last partial
	 * interval, not the whole direction. Billing is linear in duration and the usage
	 * endpoint sums each report's `duration_seconds`, so periodic deltas are
	 * billing-equivalent to one cumulative report. Reporting-agnostic — the proxy
	 * wires this to the usage reporter. `durationSeconds` is derived from the input
	 * audio appended to the provider (24 kHz PCM).
	 */
	onUsageReport?: (durationSeconds: number, targetLanguage: string) => void;
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
	private opusDecoder?: IOpusDecoder<24000>;
	private opusEncoder?: IOpusEncoder;
	private providerWebSocket?: IWebSocket;
	// Fails the direction if a `session` handshake does not complete (see HANDSHAKE_TIMEOUT_MS).
	private handshakeTimer?: ReturnType<typeof setTimeout>;
	// Idle close (see TranslationRuntimeConfig.idleCloseMs): the period, the periodic check, and when
	// media last arrived (creation time until the first frame, so a direction that never gets audio
	// is closed too).
	private readonly idleCloseMs: number;
	private idleTimer?: ReturnType<typeof setInterval>;
	private idleSince = Date.now();
	private readonly createdAt = Date.now();
	private sessionUsableReported = false;
	private pendingOpusFrames: Uint8Array[] = [];
	private pendingFramesOverflowed = false;
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
	// Samples actually appended to the provider — the billable translated audio. Distinct from
	// totalSamplesSent (which counts all decoded audio, including frames dropped before the socket
	// opens); usage is billed from this so a stalled/never-connected session that drops its buffered
	// audio isn't charged. See reportUsageDelta / sendAudioToOpenAI.
	private sentSamples = 0;
	// Samples already reported via onUsageReport. Each report fires the delta (sentSamples - reported)
	// so periodic reports sum to the direction's translated total; see reportUsageDelta.
	private reportedSamples = 0;
	private usageReportTimer?: ReturnType<typeof setInterval>;

	private readonly rtpTimestamper = new RtpTimestamper();

	onError?: (tag: string, error: any) => void = undefined;
	onClosed?: (tag: string, reason: TranslatorCloseReason) => void = undefined;
	/**
	 * Fired once, when the session has taken `REJECTED_MAX_AUDIO_SAMPLES` of audio: the point past which a
	 * provider close is `remote` rather than `rejected`. The owner clears the direction's reopen backoff on
	 * it, so an isolated failure hours later starts from the base wait again instead of a doubled one.
	 */
	onSessionUsable?: (tag: string) => void = undefined;
	onTranscription?: (transcript: string, targetLanguage: string, isInterim: boolean) => void = undefined;
	/**
	 * A translated Opus frame to forward. `audioLevel` is the frame's RFC 6464 level (0 = full scale .. 127 = silence)
	 * and `vad` its voice-activity flag, for the bridge to write into the ssrc-audio-level header extension. Only
	 * non-DTX frames are forwarded, so `vad` is true on every frame emitted: libopus's own VAD judged it voice.
	 */
	onAudioFrame?: (tag: string, chunk: number, timestamp: number, payload: string, audioLevel: number, vad: boolean) => void =
		undefined;
	// Talk boundaries: a "talk" is one contiguous run of translated audio. onTalkStart fires on the first frame of
	// the run (timestamp = that frame's RTP timestamp); onTalkStop fires when the output goes silent (see
	// armTalkSilenceTimer) with a timestamp one past the end of the run (the last frame's RTP timestamp + one frame),
	// i.e. the timestamp the next contiguous packet would carry — so the run spans [start, stop). onTalkStop also
	// reports the run's mediaInfo: bytesSent (total encoded Opus payload bytes) and duration (ms, the [start, stop)
	// span). The /v1/realtime/translations endpoint has no per-utterance boundary event, so end-of-talk is inferred
	// from an output-audio silence gap rather than an OpenAI "done" event.
	onTalkStart?: (tag: string, timestamp: number) => void = undefined;
	onTalkStop?: (tag: string, timestamp: number, mediaInfo: { bytesSent: number; duration: number }) => void = undefined;

	// Whether a talk is currently in progress (between onTalkStart and onTalkStop), the RTP timestamp of the most
	// recently emitted frame (to place the talk-stop boundary), the RTP timestamp of the run's first frame, and the
	// total encoded Opus bytes emitted in the run (for the stop's mediaInfo). See sendAudioFrame / endTalk.
	private talkActive = false;
	private lastFrameTimestamp = 0;
	private talkStartTimestamp = 0;
	private talkBytes = 0;
	// Accumulated transcript for the current run. Both providers stream session.output_transcript.delta events
	// that are INCREMENTAL FRAGMENTS (append-only, e.g. " sin", "color", "periód", "ica") — NOT a cumulative
	// hypothesis. OpenAI sends no transcript-done event, so the fragments are concatenated here and the whole run
	// is emitted as the final at the talk-stop boundary (finalizePendingTranscript), then reset. xAI sends a
	// per-segment `session.output_transcript.updated` final (provider.serverTranscriptFinals), which is emitted
	// as the final at once and resets the buffer. Empty when nothing is pending. See handleProviderMessage.
	private transcriptBuffer = '';
	// Debounce timer that ends the talk once BOTH output audio and (when enabled) the transcript have gone quiet
	// for talkSilenceTimeoutMs; re-armed on each audio frame and each transcript delta. talkDeadline is its absolute
	// wall-clock target, used to avoid a zero-playout transcript delta shortening a timer set from buffered audio.
	private talkTimeout?: ReturnType<typeof setTimeout>;
	private talkDeadline = 0;
	// End-of-talk silence timeout in ms; 0 disables inference (only a done event / close ends a talk). Set in the ctor.
	private readonly talkSilenceTimeoutMs: number;

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
	// The translations endpoint has no per-response boundary event, so this
	// window is measured once per connection (TTFA of the first output).
	private firstInputAt: number | null = null;
	private lastInputAppendAt: number | null = null;
	private firstOutputAt: number | null = null;
	private responseIndex: number = 0;
	// Latency instrumentation (incl. the per-frame speech-RMS gate) is debug-only — it is a diagnostic,
	// not a production metric, so it adds no per-frame work on the hot path unless DEBUG is enabled.
	private readonly measureLatency: boolean;

	private options: TranslatorConnectionOptions;
	private readonly runtime: TranslationRuntime;
	private readonly provider: TranslationProviderSpec;
	private metricBatcher: MetricBatcher;

	constructor(tag: string, options: TranslatorConnectionOptions, runtime: TranslationRuntime) {
		this.connectionId = `translator-conn-${++TranslatorConnection.connectionCounter}`;
		this.localTag = tag;
		this.options = options;
		this.runtime = runtime;
		this.provider = getTranslationProvider(options.provider ?? defaultTranslationProvider(runtime.config), runtime.config);
		this.measureLatency = runtime.config.debug;
		this.talkSilenceTimeoutMs = runtime.config.talkSilenceTimeoutMs ?? 350;
		this.idleCloseMs = runtime.config.idleCloseMs ?? this.provider.defaultIdleCloseMs;
		this.metricBatcher = runtime.createMetricBatcher();

		if (this.idleCloseMs > 0) {
			// Check a few times per period rather than re-arming a timer on every 20 ms frame.
			this.idleTimer = setInterval(() => this.checkIdle(), Math.max(1000, Math.floor(this.idleCloseMs / 4)));
			unrefTimer(this.idleTimer);
		}

		// Report usage incrementally (periodic deltas) while the direction is open, but only when a
		// reporter is wired AND an interval is configured — dev/replay sessions pass no onUsageReport
		// and thus start no timer. The final remaining delta is flushed in doClose().
		const iv = this.runtime.config.usageReportIntervalMs;
		if (this.options.onUsageReport && iv && iv > 0) {
			this.usageReportTimer = setInterval(() => this.reportUsageDelta(), iv);
			unrefTimer(this.usageReportTimer);
		}

		this.initializeOpusDecoder();
		this.initializeOpusEncoder();
		// Deferred to a microtask so the proxy has wired onError/onClosed by the time it runs — otherwise a
		// synchronous failure in `new WebSocket` (e.g. a bad URL) would have no callback to report through.
		queueMicrotask(() => this.initializeProviderWebSocket());
	}

	private log(message: string): void {
		this.runtime.logger.debug(`[${this.connectionId}] ${message}`);
	}

	private logError(message: string, error?: any): void {
		if (error !== undefined) {
			this.runtime.logger.error(`[${this.connectionId}] ${message}`, error);
		} else {
			this.runtime.logger.error(`[${this.connectionId}] ${message}`);
		}
	}

	private async initializeOpusDecoder(): Promise<void> {
		try {
			this.log(`Creating Opus decoder for tag: ${this.localTag}`);
			this.opusDecoder = this.runtime.createOpusDecoder({
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
			this.doClose(true, 'error');
		}
	}

	private async initializeOpusEncoder(): Promise<void> {
		try {
			this.log(`Creating Opus encoder for tag: ${this.localTag}`);
			this.opusEncoder = this.runtime.createOpusEncoder({
				sampleRate: 24000,
				channels: 1,
				application: 'voip',
				bitrate: 64000,
				complexity: 5,
				// DTX lets libopus's VAD flag comfort-noise/silence frames (EncodedFrame.inDtx). We use that to
				// bracket talks by actual voice and to drop silence frames, since the translated audio stream is
				// otherwise continuous (OpenAI keeps emitting during input silence). See sendAudioFrame.
				// Also load-bearing for the ssrc-audio-level `vad` flag: sendAudioFrame reports vad=true on every frame
				// it forwards, which is only honest because the DTX (non-voice) frames are dropped before that point.
				dtx: true,
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
			this.doClose(true, 'error');
		}
	}

	private initializeProviderWebSocket(): void {
		// The connection may have been torn down (doClose) before this deferred init runs.
		if (this.isClosed) {
			return;
		}
		const provider = this.provider;
		try {
			// The runtime applies the bearer token the way its transport allows (Node → auth subprotocol,
			// Worker → Authorization header); only one form is sent (OpenAI rejects both).
			const ws = this.runtime.createOutboundWebSocket(provider.url, {
				protocols: [...provider.protocols],
				bearerToken: provider.apiKey,
				authSubprotocolPrefix: provider.authSubprotocolPrefix,
			});

			this.log(`Opening ${provider.name} WebSocket for translation to ${this.options.targetLanguage}`);

			this.providerWebSocket = ws;

			ws.addEventListener('open', () => {
				this.log(`${provider.name} WebSocket connected for translation to ${this.options.targetLanguage}`);
				if (provider.handshake === 'open') {
					// OpenAI: configure and stream at once.
					ws.send(JSON.stringify(provider.buildSessionUpdate(this.options.targetLanguage)));
					this.markConnected();
					return;
				}
				// xAI: the server opens with `session.created`; `session.update` is answered with
				// `session.updated`, and audio may only follow that (see handleProviderMessage).
				this.handshakeTimer = setTimeout(() => {
					if (this.isClosed || this.connectionStatus !== 'pending') return;
					this.logError(`${provider.name} session not ready ${HANDSHAKE_TIMEOUT_MS}ms after connect for tag ${this.localTag}`);
					this.runtime.writeMetric({
						name: `${provider.id}_api_error`,
						worker: 'opus-transcriber-proxy',
						errorType: 'handshake_timeout',
					});
					this.onError?.(this.localTag, `${provider.name} session handshake timed out`);
					this.doClose(true, 'error');
				}, HANDSHAKE_TIMEOUT_MS);
				unrefTimer(this.handshakeTimer);
			});

			ws.addEventListener('message', (event) => {
				this.handleProviderMessage(event.data);
			});

			ws.addEventListener('error', (event) => {
				const errorMessage = (event as { message?: string; }).message ?? 'WebSocket error';
				if (this.isClosed) {
					// Our own close() in flight: xAI does not answer the client's Close frame, so the socket ends
					// 1006 with an error event about a second later. Not a provider failure, so not an error line.
					this.log(`${provider.name} WebSocket error after close for tag ${this.localTag}: ${errorMessage}`);
					return;
				}
				this.logError(`${provider.name} WebSocket error for tag ${this.localTag}: ${errorMessage}`);
				this.runtime.writeMetric({
					name: `${provider.id}_api_error`,
					worker: 'opus-transcriber-proxy',
					errorType: 'websocket_error',
				});
				// Notify before doClose() detaches the callbacks. doClose() is idempotent, so the close event
				// that always follows an error is a no-op.
				this.onError?.(this.localTag, `Error connecting to ${provider.name} service: ${errorMessage}`);
				this.doClose(true, 'error');
			});

			ws.addEventListener('close', (event) => {
				this.log(
					`${provider.name} WebSocket closed for tag ${this.localTag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean}`,
				);
				// A session the provider accepted and then closed before it was usable (mid-handshake, or right after
				// with only a moment of audio) is reported as `rejected`, so the owner paces the re-dial instead of
				// opening a new (billable) session per frame. One that lived longer was healthy, however little audio
				// it carried.
				const rejected = this.sentSamples < REJECTED_MAX_AUDIO_SAMPLES && Date.now() - this.createdAt < REJECTED_MAX_SESSION_AGE_MS;
				this.doClose(true, rejected ? 'rejected' : 'remote');
			});
		} catch (error) {
			this.logError(`Failed to create ${provider.name} WebSocket for tag ${this.localTag}:`, error);
			this.runtime.writeMetric({
				name: `${provider.id}_api_error`,
				worker: 'opus-transcriber-proxy',
				errorType: 'connection_failed',
			});
			this.connectionStatus = 'failed';
			// Notify before doClose() detaches the callbacks, then tear down so the proxy removes this session.
			this.onError?.(this.localTag, `Failed to connect to ${provider.name} service: ${error instanceof Error ? error.message : String(error)}`);
			this.doClose(true, 'error');
		}
	}

	/** The provider session is ready for audio: flush what buffered while it was pending. */
	private markConnected(): void {
		if (this.handshakeTimer !== undefined) {
			clearTimeout(this.handshakeTimer);
			this.handshakeTimer = undefined;
		}
		this.connectionStatus = 'connected';
		this.processPendingAudioData();
	}

	/** Close the direction if no media has arrived for idleCloseMs (see TranslationRuntimeConfig). */
	private checkIdle(): void {
		if (this.isClosed) return;
		// Not while translated audio is still playing out: translation lags the source by seconds, so a
		// speaker who finishes and mutes would otherwise have the tail of the last utterance cut off. With
		// the talk timer disabled a talk never ends, so it cannot be allowed to hold the direction open.
		if (this.talkActive && this.talkSilenceTimeoutMs > 0) return;
		const idleFor = Date.now() - this.idleSince;
		if (idleFor < this.idleCloseMs) return;
		this.runtime.logger.info(
			`[${this.connectionId}] Closing idle translation direction for tag ${this.localTag} (${this.options.targetLanguage}): no media for ${idleFor}ms`,
		);
		this.doClose(true, 'idle');
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
		this.idleSince = this._lastMediaTime;

		let opusFrame: Uint8Array;

		try {
			opusFrame = fromBase64(mediaEvent.media.payload);
		} catch (error) {
			this.logError(`Failed to decode base64 media payload for tag ${this.localTag}:`, error);
			return;
		}

		this.metricBatcher.increment({
			name: 'audio_packet_received',
			worker: 'opus-transcriber-proxy',
		});

		if (Number.isInteger(mediaEvent.media?.chunk) && Number.isInteger(mediaEvent.media.timestamp)) {
			if (this.lastChunkNo != -1 && mediaEvent.media.chunk != this.lastChunkNo + 1) {
				const chunkDelta = mediaEvent.media.chunk - this.lastChunkNo;
				if (chunkDelta <= 0) {
					this.runtime.writeMetric({
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
			if (this.pendingOpusFrames.length >= MAX_PENDING_OPUS_FRAMES) {
				// Decoder init has not completed in ~10 s of audio — drop rather than grow without bound.
				if (!this.pendingFramesOverflowed) {
					this.pendingFramesOverflowed = true;
					this.runtime.logger.warn(`[${this.connectionId}] Dropping queued opus frames for tag ${this.localTag}: decoder still initialising after ${MAX_PENDING_OPUS_FRAMES} frames`);
				}
			} else {
				this.pendingOpusFrames.push(opusFrame);
			}
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
				this.runtime.writeMetric({
					name: 'audio_decode_failure',
					worker: 'opus-transcriber-proxy',
				});
			} else {
				this.sendOrEnqueueDecodedAudio(concealedAudio.audioData);
				this.runtime.writeMetric({
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
				this.runtime.writeMetric({
					name: 'audio_decode_failure',
					worker: 'opus-transcriber-proxy',
				});
				return;
			}
			this.metricBatcher.increment({
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

		// Latency measurement (debug-only): only update timestamps on speech chunks (RMS gate). Silence
		// padding doesn't count. The RMS scan runs only when latency instrumentation is enabled.
		if (this.measureLatency && pcmContainsSpeech(audioData)) {
			const now = Date.now();
			if (this.firstInputAt === null) {
				this.firstInputAt = now;
			}
			this.lastInputAppendAt = now;
		}

		if (this.connectionStatus === 'connected' && this.providerWebSocket) {
			const encodedAudio = safeToBase64(audioData);
			this.sendAudioToProvider(encodedAudio, samplesSent);
		} else if (this.connectionStatus === 'pending') {
			if (this.pendingAudioData.length + audioData.length <= MAX_PENDING_PCM_BYTES) {
				const merged = new Uint8Array(this.pendingAudioData.length + audioData.length);
				merged.set(this.pendingAudioData);
				merged.set(audioData, this.pendingAudioData.length);
				this.pendingAudioData = merged;
			} else {
				// Connection still pending and the buffer is full — drop the accumulated audio rather than
				// send on a socket that has not opened yet (and keep memory bounded). processPendingAudioData
				// flushes the buffer once the connection opens.
				this.runtime.logger.warn(`[${this.connectionId}] Dropping buffered audio for tag ${this.localTag}: pending PCM buffer full (>${MAX_PENDING_PCM_BYTES} bytes) before connect`);
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

	private sendAudioToProvider(encodedAudio: string, sampleCount: number): void {
		if (!this.providerWebSocket) {
			this.logError(`No websocket available for tag: ${this.localTag}`);
			return;
		}

		try {
			// Both providers' translation endpoints take the "session."-prefixed client message types:
			// only session.update, session.input_audio_buffer.append and session.close are accepted.
			// VAD and response triggering are handled server-side automatically.
			this.providerWebSocket.send(JSON.stringify({
				type: 'session.input_audio_buffer.append',
				audio: encodedAudio,
			}));
			// Bill only audio actually appended to the provider (see reportUsageDelta).
			this.sentSamples += sampleCount;
			if (!this.sessionUsableReported && this.sentSamples >= REJECTED_MAX_AUDIO_SAMPLES) {
				this.sessionUsableReported = true;
				this.onSessionUsable?.(this.localTag);
			}
			this.metricBatcher.increment({
				name: 'backend_audio_sent',
				worker: 'opus-transcriber-proxy',
			});
		} catch (error) {
			this.logError(`Failed to send audio to ${this.provider.name} for tag ${this.localTag}`, error);
		}
	}

	private processPendingAudioData(): void {
		if (this.pendingAudioData.length === 0) return;

		this.log(`Processing ${this.pendingAudioData.length} bytes of queued audio for tag: ${this.localTag}`);

		const flushedSamples = this.pendingAudioData.length / 2; // 16-bit samples
		const encodedAudio = safeToBase64(this.pendingAudioData);
		this.pendingAudioData = new Uint8Array(0);

		this.sendAudioToProvider(encodedAudio, flushedSamples);
	}

	private handleProviderMessage(data: any): void {
		// xAI does not answer our Close frame, so its socket's listeners outlive doClose by about a second; an
		// `error` event it sends in that window is not this direction's failure and must not count as one.
		if (this.isClosed) return;
		const provider = this.provider;
		let parsedMessage;
		try {
			parsedMessage = JSON.parse(data);
		} catch (parseError) {
			this.logError(`Failed to parse ${provider.name} message as JSON for tag ${this.localTag}:`, parseError);
			return;
		}

		// JSON.parse can succeed and still yield null (e.g. data was null, a
		// non-text frame, or the literal "null"). Guard against it so the WS
		// message listener never throws and crashes the process.
		if (parsedMessage === null || typeof parsedMessage !== 'object' || typeof parsedMessage.type !== 'string') {
			this.log(`Ignoring non-object/typeless ${provider.name} message for tag ${this.localTag}`);
			return;
		}

		// Session handshake (xAI): `session.created` opens the exchange, `session.updated` confirms our
		// configuration and permits audio. OpenAI echoes a `session.updated` too, but it is connected on
		// open already, so this only acts while the connection is still pending.
		if (parsedMessage.type === 'session.created') {
			this.log(`[${this.options.targetLanguage}] ${provider.name} session created: ${JSON.stringify(parsedMessage.session ?? {})}`);
			if (provider.handshake === 'session' && this.providerWebSocket && this.connectionStatus === 'pending') {
				this.providerWebSocket.send(JSON.stringify(provider.buildSessionUpdate(this.options.targetLanguage)));
			}
			return;
		}
		if (parsedMessage.type === 'session.updated') {
			this.log(`[${this.options.targetLanguage}] ${provider.name} session updated: ${JSON.stringify(parsedMessage.session ?? {})}`);
			if (this.connectionStatus === 'pending') {
				this.markConnected();
			}
			return;
		}

		// Translated audio: base64-encoded PCM16 at 24 kHz, re-encoded to Opus and forwarded as RTP.
		if (parsedMessage.type === 'session.output_audio.delta') {
			const delta = parsedMessage.delta;
			if (delta) {
				// Latency: capture both TTFA and ongoing-lag on the first
				// audio.delta of this response window. For a simultaneous
				// translator the headline metric is TTFA.
				if (this.measureLatency && this.firstOutputAt === null) {
					this.firstOutputAt = Date.now();
					this.responseIndex++;
					const ttfa = this.firstInputAt !== null
						? this.firstOutputAt - this.firstInputAt
						: null;
					const lastInputToFirstOutput = this.lastInputAppendAt !== null
						? this.firstOutputAt - this.lastInputAppendAt
						: null;
					this.runtime.logger.info(
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
						for (const frame of opusFrames) {
							this.sendAudioFrame(frame.data, frame.inDtx, frame.audioLevel);
						}
					} catch (error) {
						this.logError(`Failed to encode audio delta:`, error);
					}
				}
			}
			return;
		}

		// Transcript stream (text accompaniment of the translated audio).
		if (parsedMessage.type === 'session.output_transcript.delta') {
			// Deltas are incremental fragments (append-only), not a cumulative hypothesis. Forward each as an
			// interim (server.ts gates on `sendBack`/`sendBackInterim`) and concatenate into the run buffer so the
			// whole utterance can be emitted as the final at the talk-stop boundary (OpenAI sends no transcript-done
			// event; see finalizePendingTranscript) or replaced by the provider's own final below. Suppressed when
			// transcripts disabled.
			if (this.runtime.config.emitTranscripts && typeof parsedMessage.delta === 'string' && parsedMessage.delta) {
				this.onTranscription?.(parsedMessage.delta, this.options.targetLanguage, /* isInterim */ true);
				this.transcriptBuffer += parsedMessage.delta;
				// Extend the talk so it doesn't end (finalizing the transcript / emitting the audio stop) while the
				// transcript is still streaming past the audio. playoutAhead is 0 — text has no playout. This also
				// arms the timer when no audio talk is active (a transcript before the first audio frame, or a late
				// fragment after a talk ended): the buffered transcript then finalizes on its own silence with no
				// audio stop — preferable to attaching a stray trailing fragment to the next utterance's final.
				this.armTalkSilenceTimer(0);
			}
			return;
		}

		// A per-segment transcript final (xAI). Its `text` is the segment's whole translation (measured equal to
		// the concatenated deltas), so emit it as the final now and drop the buffered fragments, instead of
		// waiting for the talk-stop silence. It lands ~1.5 s after the source phrase ends and typically before
		// the segment's audio, so the subtitle leads the translated speech. Neither provider sends a per-segment
		// AUDIO boundary, so the talk-stop stays silence-driven (armTalkSilenceTimer).
		// On a provider without server finals the event falls through to the generic debug line below, so
		// an endpoint that starts sending it is visible when debugging.
		if (parsedMessage.type === 'session.output_transcript.updated' && provider.serverTranscriptFinals) {
			if (this.runtime.config.emitTranscripts) {
				const text = typeof parsedMessage.text === 'string' ? parsedMessage.text.trim() : '';
				this.transcriptBuffer = '';
				if (text) {
					this.log(`[${this.options.targetLanguage}] transcript final (segment ${parsedMessage.segment_id ?? '?'}): ${text}`);
					this.onTranscription?.(text, this.options.targetLanguage, /* isInterim */ false);
				}
			}
			return;
		}

		// Neither provider sends a per-utterance AUDIO boundary event (audio-done / response.done): output audio
		// streams as deltas, so the talk-stop is driven by the silence timer (armTalkSilenceTimer), and for OpenAI
		// so is the transcript final (finalizePendingTranscript).

		this.log(`[${this.options.targetLanguage}] Received event: ${parsedMessage.type}`);

		if (parsedMessage.type === 'error') {
			this.logError(`${provider.name} sent error message for ${this.localTag}: ${data}`);
			this.runtime.writeMetric({
				name: `${provider.id}_api_error`,
				worker: 'opus-transcriber-proxy',
				errorType: 'api_error',
			});
			// Notify before doClose() detaches the callbacks.
			this.onError?.(this.localTag, `${provider.name} service sent error message: ${data}`);
			this.doClose(true, 'error');
		}
	}

	private sendAudioFrame(opusFrame: Uint8Array, inDtx: boolean, audioLevel: number): void {
		// DTX frame: libopus's VAD marked this as comfort-noise/silence, not voice. Don't forward it to the
		// bridge and don't count it as talk activity. The silence timer (armed only by the voice frames below)
		// then ends the talk after the configured silence, and the RtpTimestamper inserts the real gap when
		// voice resumes — so a live mic's continuous ambient/near-silent output no longer holds the talk open
		// forever, and no silence packets are sent downstream.
		if (inDtx) {
			return;
		}

		// The RtpTimestamper produces a monotonic RTP timestamp (inserting a real-silence gap when the
		// source idled longer than the buffered media — e.g. across the DTX frames we skipped above) and a
		// uint16 RTP sequence number. JVB's Conference.handleMediaMessage reinterprets `media.chunk` as that
		// 16-bit RTP sequence number.
		const { timestamp, sequenceNumber: rtpSequenceNumber, bufferAheadMs } = this.rtpTimestamper.nextFrameTimestamp();

		// First frame of a talk: emit the talk-start boundary at this frame's timestamp, and reset the run's
		// mediaInfo accumulators. The end-of-utterance handler emits the matching talk-stop. Uses its own flag
		// (not the debug-only firstOutputAt) so it works in production.
		if (!this.talkActive) {
			this.talkActive = true;
			this.talkStartTimestamp = timestamp;
			this.talkBytes = 0;
			this.log(`[${this.options.targetLanguage}] talk start tag=${this.localTag} ts=${timestamp}`);
			this.onTalkStart?.(this.localTag, timestamp);
		}
		this.lastFrameTimestamp = timestamp;
		this.talkBytes += opusFrame.length;
		// (Re)arm the silence timer against the MEDIA playout, not frame arrival: OpenAI streams faster than real
		// time (a 2 s utterance can arrive in ~200 ms), so the consumer is still playing out the buffered burst long
		// after the last frame arrives. Wait until that buffered media would finish playing (bufferAheadMs) plus the
		// silence margin before ending the talk.
		this.armTalkSilenceTimer(bufferAheadMs);

		const payload = bytesToBase64(opusFrame);

		// The mediajson wire-envelope sequence number is assigned by the proxy (per-WebSocket), not here.
		// Every frame that reaches here passed libopus's VAD (DTX frames were dropped above), hence vad = true.
		this.onAudioFrame?.(this.localTag, rtpSequenceNumber, timestamp, payload, audioLevel, /* vad */ true);
	}

	/**
	 * (Re)arm the end-of-talk silence timer. The /v1/realtime/translations endpoint streams output-audio and
	 * output-transcript deltas with no per-utterance boundary event, so a talk is ended once BOTH have gone silent:
	 * armed from each audio frame and (when transcripts are enabled) each transcript delta, so the audio sending-change
	 * and the transcript final stay aligned to one boundary and a trailing transcript is not orphaned.
	 *
	 * `playoutAheadMs` is how far the projected MEDIA playout extends beyond now: `bufferAheadMs` for an audio frame
	 * (so a faster-than-real-time burst isn't ended while the consumer is still playing it out), 0 for a transcript
	 * delta (text has no playout). The deadline is `now + playoutAheadMs + talkSilenceTimeoutMs`. A pending timer is
	 * only ever EXTENDED, never shortened — a zero-playout transcript delta must not cut a timer set from buffered
	 * audio; the talk ends at the later of the two streams' quiet points. Non-positive timeout disables inference.
	 */
	private armTalkSilenceTimer(playoutAheadMs: number): void {
		if (this.talkSilenceTimeoutMs <= 0) {
			return;
		}
		const deadline = Date.now() + playoutAheadMs + this.talkSilenceTimeoutMs;
		if (this.talkTimeout !== undefined && deadline <= this.talkDeadline) {
			return; // keep the later pending timer (don't let this source shorten it)
		}
		if (this.talkTimeout !== undefined) {
			clearTimeout(this.talkTimeout);
		}
		this.talkDeadline = deadline;
		this.talkTimeout = setTimeout(() => this.endTalk(), playoutAheadMs + this.talkSilenceTimeoutMs);
		unrefTimer(this.talkTimeout);
	}

	/**
	 * Emit the accumulated transcript for the run as the final, if any fragments are buffered, and reset the buffer.
	 * The /v1/realtime/translations endpoint sends no transcript-done event, so — like the audio talk-stop — the
	 * transcript is finalized at the silence boundary (and at close), emitting the concatenation of the run's
	 * fragment deltas with isInterim=false. (Buffer only grows when emitTranscripts is on.)
	 */
	private finalizePendingTranscript(): void {
		if (this.transcriptBuffer === '') {
			return;
		}
		// A provider that sends its own per-segment finals (xAI) owns finalization: publishing the buffered
		// deltas here as well would print the segment twice when the silence timer lands between the deltas
		// and the `updated` event. The deltas were already forwarded as interims; at close a segment whose
		// final never arrived is dropped rather than guessed.
		if (this.provider.serverTranscriptFinals) {
			this.transcriptBuffer = '';
			return;
		}
		const transcript = this.transcriptBuffer;
		this.transcriptBuffer = '';
		this.log(`[${this.options.targetLanguage}] transcript final: ${transcript}`);
		this.onTranscription?.(transcript, this.options.targetLanguage, /* isInterim */ false);
	}

	/** Emit the talk-stop boundary if a talk is in progress. Idempotent (a no-op when no talk is active). */
	private endTalk(): void {
		if (this.talkTimeout !== undefined) {
			clearTimeout(this.talkTimeout);
			this.talkTimeout = undefined;
			this.talkDeadline = 0; // keep the invariant obvious: no pending timer ⇒ no live deadline
		}
		// Finalize the transcript at the same boundary (before the talkActive guard, so a pending interim is still
		// flushed at close even if no audio talk is active).
		this.finalizePendingTranscript();
		if (!this.talkActive) {
			return;
		}
		this.talkActive = false;
		// One past the end of the run: the last frame occupies [lastFrameTimestamp, lastFrameTimestamp + one frame),
		// so its exclusive end (the next contiguous packet's timestamp) marks where the talk stops.
		const stopTimestamp = this.lastFrameTimestamp + SAMPLES_PER_FRAME;
		// duration is the run's span on the media timeline: (stop - start) converted to ms at RTP_CLOCK_RATE. It
		// equals the [start, stop) interval the talk-start/stop timestamps bracket, so it includes any silence the
		// RtpTimestamper inserted mid-run. bytesSent is the total encoded Opus payload.
		const duration = Math.round((stopTimestamp - this.talkStartTimestamp) / (RTP_CLOCK_RATE / 1000));
		this.log(
			`[${this.options.targetLanguage}] talk stop tag=${this.localTag} ts=${stopTimestamp} ` +
				`bytes=${this.talkBytes} durationMs=${duration}`,
		);
		this.onTalkStop?.(this.localTag, stopTimestamp, { bytesSent: this.talkBytes, duration });
	}

	// Report the audio duration translated (appended to the provider) since the previous report. Fired on a
	// timer while open and once more at close to flush the remainder; the deltas sum to sentSamples / 24000.
	private reportUsageDelta(): void {
		const total = this.sentSamples;
		const deltaSamples = total - this.reportedSamples;
		if (deltaSamples <= 0) return;
		try {
			this.options.onUsageReport?.(deltaSamples / 24000, this.options.targetLanguage);
			// Advance only after a successful report so a throwing callback re-includes this delta on the
			// next timer tick. The final close() call has no next tick, so a throw there drops the last
			// delta — acceptable because reportTranslationUsage is synchronous and non-throwing.
			this.reportedSamples = total;
		} catch (err) {
			this.runtime.logger.error('onUsageReport callback failed', err as Error);
		}
	}

	close(): void {
		this.doClose(false, 'local');
	}

	private doClose(notify: boolean, reason: TranslatorCloseReason): void {
		if (this.isClosed) {
			return;
		}
		this.isClosed = true;

		if (this.handshakeTimer !== undefined) {
			clearTimeout(this.handshakeTimer);
			this.handshakeTimer = undefined;
		}
		if (this.idleTimer !== undefined) {
			clearInterval(this.idleTimer);
			this.idleTimer = undefined;
		}

		// Stop the periodic usage timer and flush the final remaining delta for this direction. Every
		// teardown path (proxy reconcile, ws close, error) funnels through here, and the isClosed guard
		// above ensures this runs once. onUsageReport lives on options (not detached below), so it
		// survives the teardown; reportUsageDelta no-ops when nothing new has been translated.
		if (this.usageReportTimer) {
			clearInterval(this.usageReportTimer as unknown as number);
			this.usageReportTimer = undefined;
		}
		this.reportUsageDelta();

		// Close any talk still in progress so a receiver isn't left believing the source is still sending after the
		// connection goes away. Fired while onTalkStop is still attached, before the detach below.
		this.endTalk();

		// Detach callbacks before teardown so a late provider event firing during close() can't re-emit on the
		// proxy. Keep onClosed locally so we can notify exactly once after everything is torn down.
		const onClosed = this.onClosed;
		this.onClosed = undefined;
		this.onError = undefined;
		this.onTranscription = undefined;
		this.onAudioFrame = undefined;
		this.onTalkStart = undefined;
		this.onTalkStop = undefined;

		this.connectionStatus = 'closed';
		this.decoderStatus = 'closed';
		this.encoderStatus = 'closed';

		this.metricBatcher.flush();
		this.opusDecoder?.free();
		this.opusDecoder = undefined;
		this.opusEncoder?.free();
		this.opusEncoder = undefined;
		this.providerWebSocket?.close();
		this.providerWebSocket = undefined;

		if (notify) {
			onClosed?.(this.localTag, reason);
		}
	}
}
