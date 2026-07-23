import { createAudioDecoder } from './AudioDecoderFactory';
import type { AudioDecoder } from './AudioDecoder';
import { NO_CHUNK_INFO } from './AudioDecoder';
import type { TranscriptionMessage, TranscriberProxyOptions } from './transcriberproxy';
import { writeMetric } from './metrics';
import { MetricCache } from './MetricCache';
import { config, getDefaultProvider } from './config';
import logger from './logger';
import { createBackend, getBackendConfig, type OpenAICustomOptions } from './backends/BackendFactory';
import type { TranscriptionBackend, BackendConfig } from './backends/TranscriptionBackend';
import { validateAudioFormat, type AudioFormat } from './AudioFormat';
import { getInstruments } from './telemetry/instruments';
import { SidecarClient, type ISidecarClient } from './identity/SidecarClient';
import { SidecarWsClient } from './identity/SidecarWsClient';
import { LocalIdentityClient } from './identity/LocalIdentityClient';
import { IdentityAttributor } from './identity/IdentityAttributor';
import { checkEnrollConsistency } from './identity/enrollGuard';
import { createIdentitySource, type IdentitySource, type ResolvedIdentity } from './identity/IdentitySource';
import type { AttributedSegment } from './identity/RoomAttributor';

// Process-wide sidecar client, built once from config when the identity feature is enabled.
// A ws(s):// URL uses one persistent multiplexed WS (required under Cloudflare's outbound
// connection cap); an http(s):// URL uses per-request HTTP.
let sidecarSingleton: ISidecarClient | null | undefined;
function getSidecar(): ISidecarClient | null {
	if (sidecarSingleton !== undefined) return sidecarSingleton;
	if (!config.identity?.enabled) {
		sidecarSingleton = null;
		return null;
	}
	// Prefer the in-container client (CAM++ embed + Vectorize match, no sidecar hop) when Vectorize
	// creds are configured. Falls back to the WS/HTTP sidecar otherwise.
	const { vectorizeAccountId, vectorizeIndex, vectorizeApiToken } = config.identity;
	if (vectorizeAccountId && vectorizeIndex && vectorizeApiToken) {
		sidecarSingleton = new LocalIdentityClient({
			embeddingModel: config.identity.embeddingModel,
			vectorize: { accountId: vectorizeAccountId, indexName: vectorizeIndex, apiToken: vectorizeApiToken },
			matchThreshold: config.identity.matchThreshold,
			maxEmbedSec: config.identity.maxEmbedSec,
		});
		return sidecarSingleton;
	}
	const url = config.identity?.sidecarUrl;
	if (!url) {
		sidecarSingleton = null;
		return null;
	}
	if (url.startsWith('ws://') || url.startsWith('wss://')) {
		sidecarSingleton = new SidecarWsClient({
			url,
			token: config.identity.sidecarToken,
			timeoutMs: config.identity.timeoutMs,
			maxInFlight: config.identity.maxInFlight,
			accessClientId: config.identity.accessClientId,
			accessClientSecret: config.identity.accessClientSecret,
		});
	} else {
		sidecarSingleton = new SidecarClient({
			baseUrl: url,
			token: config.identity.sidecarToken,
			timeoutMs: config.identity.timeoutMs,
			maxInFlight: config.identity.maxInFlight,
		});
	}
	return sidecarSingleton;
}

// Process-wide identity source (KV REST). Null when KV creds are unset.
let identitySourceSingleton: IdentitySource | null | undefined;
function getIdentitySource(): IdentitySource | null {
	if (identitySourceSingleton === undefined) identitySourceSingleton = createIdentitySource();
	return identitySourceSingleton;
}

const tagMatcher = /^([0-9a-fA-F]+)-/;

/**
 * Max number of consecutive recoverable backend errors (e.g. xAI "ASR stream
 * timed out") tolerated without any audio being sent in between. A muted
 * participant sends no audio, so the stream times out, we reconnect, it times
 * out again — without a bound this loops for the entire mute. After this many
 * consecutive recoveries we give up and tear the connection down; the next
 * media event (unmute) recreates it cleanly. The counter resets whenever audio
 * is actually sent, so an active (e.g. open-mic-but-silent) participant keeps
 * reconnecting as intended.
 */
const MAX_CONSECUTIVE_RECOVERIES = 3;

function audioFormatsDiffer(a: AudioFormat, b: AudioFormat): boolean {
	return a.encoding !== b.encoding || a.sampleRate !== b.sampleRate || a.channels !== b.channels;
}

export class OutgoingConnection {
	private localTag!: string;
	private serverAcknowledgedTag!: string;
	public get tag() {
		return this.localTag;
	}
	private setServerAcknowledgedTag(newTag: string) {
		this.serverAcknowledgedTag = newTag;
		const match = tagMatcher.exec(newTag);
		if (match !== null && match.length === 2) {
			this.participant = { id: match[1], tag: newTag };
		} else {
			this.participant = { id: newTag, tag: newTag };
		}
	}
	private participant: any;
	public get participantId(): string {
		return this.participant?.id || this.localTag;
	}
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'closed' = 'pending';
	private decoder?: AudioDecoder;
	private reinitGeneration = 0;
	/** Consecutive recoverable backend errors with no audio sent since; reset on each audio send. */
	private consecutiveRecoveries = 0;
	private isClosed = false;
	private backend?: TranscriptionBackend;
	private pendingInputFrames: Array<{ frame: Uint8Array; chunkNo: number; timestamp: number }> = [];
	private pendingAudioFrames: string[] = [];
	/** The audio format the current backend instance was initialized for (set synchronously in reinitializeDecoder). */
	private activeDesiredFormat: AudioFormat | undefined;

	/** Speaker-identity attributor (only when config.identity.enabled and this is the l16/16k path). */
	private identityAttributor?: IdentityAttributor;
	private identitySidecar?: ISidecarClient;
	/** Set once this stream has ever shown >1 speaker → never auto-enroll from it (it's a room). */
	private everSawMultipleSpeakers = false;
	private resolvedIdentityP?: Promise<ResolvedIdentity | null>;
	private lastEnrollAt = 0;
	private enrollCount = 0;
	/** Consecutive divergent enroll windows; latches everSawMultipleSpeakers only past the configured
	 *  strike count so one noisy window doesn't permanently disable a genuine single speaker. */
	private enrollDivergenceStrikes = 0;

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
	private inputAudioFormat!: AudioFormat; // set synchronously by updateInputFormat() in the constructor
	/** Per-endpoint diarization override (from the start event); mutable so a re-start can change it. */
	private diarize?: boolean;

	constructor(tag: string, inputFormat: AudioFormat, options: TranscriberProxyOptions, diarize?: boolean) {
		this.localTag = tag;
		this.setServerAcknowledgedTag(tag);
		this.options = options;
		this.diarize = diarize;
		this.metricCache = new MetricCache(undefined, NaN);

		this.updateInputFormat(inputFormat);
		this.initializeBackend();
	}

	getInputFormat(): AudioFormat {
		// Return a shallow copy so callers can't mutate the decoder's format state.
		return { ...this.inputAudioFormat };
	}

	updateInputFormat(inputFormat: AudioFormat, diarize?: boolean): void {
		// Validate synchronously so callers get an immediate error rather than
		// an async failure deep in reinitializeDecoder -> createAudioDecoder.
		// validateAudioFormat also normalises 'ogg-opus' → 'ogg'.
		const newFormat = validateAudioFormat(inputFormat);

		// A re-start may change the per-endpoint diarize flag. It's a connect-time
		// URL param, so honour a change by forcing a backend reconnect even when the
		// audio format is unchanged. Only an explicit boolean is considered.
		const diarizeChanged = diarize !== undefined && diarize !== this.diarize;
		if (diarizeChanged) {
			this.diarize = diarize;
		}

		if (this.backend) {
			// Skip reinitialisation when nothing changed — avoids flushing pending
			// frames and reconnecting the backend for repeated start events.
			if (!audioFormatsDiffer(newFormat, this.inputAudioFormat) && !diarizeChanged) {
				return;
			}
		}

		this.inputAudioFormat = newFormat;

		// reinitializeDecoder swaps the audio decoder and, if the backend's desired
		// format has changed (e.g. a Deepgram connection opened for Opus is now
		// needed for PCM), also closes the old backend connection and opens a new
		// one via reconnectBackend().

		if (this.backend) {
			const promise = this.reinitializeDecoder(diarizeChanged);
			// reinitGeneration is incremented synchronously inside reinitializeDecoder
			// (before its first await), so this.reinitGeneration already reflects the
			// generation owned by this call.
			const generation = this.reinitGeneration;
			promise.catch((error) => {
				if (generation !== this.reinitGeneration) {
					// A newer reinitializeDecoder call has already succeeded; don't
					// tear down the connection that it set up.
					logger.debug(`Stale reinitializeDecoder error for tag ${this.localTag} (superseded by generation ${this.reinitGeneration}):`, error);
					return;
				}
				logger.error(`Failed to reinitialize decoder for tag ${this.localTag}:`, error);
				this.onError?.(this.localTag, error instanceof Error ? error.message : String(error));
				this.doClose(true);
			});
		}
	}

	private getOpenAICustomOptions(): OpenAICustomOptions | undefined {
		if (this.options.provider !== 'openai_custom') return undefined;
		return {
			openaiCustomUrl: this.options.openaiCustomUrl,
			openaiCustomApiKey: this.options.openaiCustomApiKey,
		};
	}

	/**
	 * Copy the per-connection / per-endpoint settings onto a fresh BackendConfig.
	 * Shared by the initial connect (initializeBackend) and the reconnect path
	 * (reconnectBackend) so the two lists can never drift out of lockstep.
	 */
	private applyPerConnectionConfig(backendConfig: BackendConfig): void {
		backendConfig.language = this.options.language;
		backendConfig.tags = this.options.tags;
		backendConfig.deepgramMipOptOut = this.options.deepgramMipOptOut;
		backendConfig.diarize = this.diarize;
		backendConfig.xaiEndpointing = this.options.xaiEndpointing;
		backendConfig.xaiSmartTurn = this.options.xaiSmartTurn;
		backendConfig.xaiSmartTurnTimeout = this.options.xaiSmartTurnTimeout;
		backendConfig.xaiGranularFinals = this.options.xaiGranularFinals;
		backendConfig.xaiGranularStabilityMs = this.options.xaiGranularStabilityMs;
		backendConfig.xaiGranularGuardWords = this.options.xaiGranularGuardWords;
	}

	private async initializeBackend(): Promise<void> {
		try {
			// Create backend using factory
			// Use provider from options (URL param), or fall back to config default
			this.backend = createBackend(this.localTag, this.participant, this.options.provider, this.getOpenAICustomOptions());

			await this.reinitializeDecoder();

			// close() may have been called while we were initializing the decoder.
			if (this.isClosed) return;

			this.setupBackendHandlers(this.backend);

			// Get backend configuration
			const backendConfig = getBackendConfig(this.options.provider);
			this.applyPerConnectionConfig(backendConfig);

			// Connect the backend
			const connectStartTime = Date.now();
			await this.backend.connect(backendConfig);

			// close() may have been called while we were connecting.
			if (this.isClosed) return;

			const connectDurationSec = (Date.now() - connectStartTime) / 1000;

			// OTel metrics: track backend connection
			const instruments = getInstruments();
			instruments.backendConnectionsActive.add(1);
			instruments.backendConnectionDurationSeconds.record(connectDurationSec, { provider: this.options.provider || 'unknown' });

			logger.info(`Transcription backend connected for tag: ${this.localTag}`);

			// Only flush if the decoder is ready.  If a newer reinitializeDecoder()
			// call is still in flight (e.g. a start event arrived while we were
			// awaiting connect), the decoder is still undefined; leave the queued
			// frames for the winning reinit to flush once it settles.
			if (this.decoderStatus === 'ready') {
				this.processPendingInputFrames();
				this.processPendingAudioData();
			}
		} catch (error) {
			// Suppress cascading errors if close() was already called — doClose()
			// has run (or is running) and any further teardown is a no-op.
			if (this.isClosed) return;
			logger.error(`Failed to initialize transcription backend for tag ${this.localTag}:`, error);
			this.backend = undefined;
			this.onBackendError?.('connection_failed', error instanceof Error ? error.message : 'Unknown error');
			this.doClose(true);
			this.onError?.(this.localTag, `Error initializing transcription backend: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private setupBackendHandlers(backend: TranscriptionBackend): void {
		backend.onInterimTranscription = (message) => {
			getInstruments().transcriptionsReceivedTotal.add(1, { provider: this.options.provider || 'unknown', is_interim: 'true' });
			this.logTranscriptionSummary(message, true);
			this.onInterimTranscription?.(message);
		};

		backend.onCompleteTranscription = (message) => {
			getInstruments().transcriptionsReceivedTotal.add(1, { provider: this.options.provider || 'unknown', is_interim: 'false' });
			this.logTranscriptionSummary(message, false);
			this.clearIdleCommitTimeout();
			this.onCompleteTranscription?.(message);
		};

		backend.onError = (errorType, errorMessage, recoverable) => {
			getInstruments().backendErrorsTotal.add(1, { provider: this.options.provider || 'unknown', type: errorType });

			// Transient stream-level errors (e.g. xAI's "ASR stream timed out" on
			// silence) leave the participant active. Reopen the backend in place
			// instead of dropping the participant — keeps the decoder, transcript
			// history and negotiated format, and restores transcription within the
			// reconnect latency rather than waiting for coarse recovery (JIT-15901).
			//
			// Bound the reconnect loop: a muted participant sends no audio, so a fresh
			// stream just times out again. After MAX_CONSECUTIVE_RECOVERIES reconnects
			// without any audio in between, give up and tear down; the next media event
			// (unmute) recreates the connection cleanly. The counter resets on each
			// audio send, so an active participant reconnects without limit.
			if (recoverable && !this.isClosed && this.consecutiveRecoveries < MAX_CONSECUTIVE_RECOVERIES) {
				this.consecutiveRecoveries++;
				logger.warn(
					`Recoverable backend error for tag ${this.localTag} (${errorType}: ${errorMessage}); reconnecting backend in place (attempt ${this.consecutiveRecoveries}/${MAX_CONSECUTIVE_RECOVERIES})`,
				);
				this.recoverBackend(errorType, errorMessage).catch((error) => {
					// reconnectBackend handles its own connect failures (onBackendError +
					// doClose) and resolves false, so reaching here means an unexpected
					// throw during recovery. Report the actual cause, not the original
					// timeout that triggered the recovery, so metrics/logs aren't misleading.
					const cause = error instanceof Error ? error.message : String(error);
					logger.error(`Unexpected error during backend recovery for tag ${this.localTag}:`, error);
					this.onBackendError?.('recovery_failed', cause);
					this.doClose(true);
					this.onError?.(this.localTag, `Transcription backend error: ${cause}`);
				});
				return;
			}

			if (recoverable && this.consecutiveRecoveries >= MAX_CONSECUTIVE_RECOVERIES) {
				logger.warn(
					`Tag ${this.localTag}: ${this.consecutiveRecoveries} consecutive recoverable errors with no audio in between; giving up — connection will be recreated on the next media event`,
				);
			}

			this.onBackendError?.(errorType, errorMessage);
			this.doClose(true);
			this.onError?.(this.localTag, `Transcription backend error: ${errorMessage}`);
		};

		backend.onClosed = () => {
			logger.info(`Backend closed for tag ${this.localTag}, cleaning up OutgoingConnection`);
			getInstruments().backendConnectionsActive.add(-1);
			this.doClose(true);
		};
	}

	private logTranscriptionSummary(message: TranscriptionMessage, isInterim: boolean): void {
		// DEBUG-only: summarises each transcription arriving from the backend so we
		// can tell apart empty end-of-utterance finals from real speech without
		// logging full PII.  Controlled by LOG_LEVEL=debug.
		// Early-exit when debug isn't enabled so we don't allocate join/slice strings
		// on every transcription in production.
		if (!logger.isLevelEnabled('debug')) return;
		const segments = message.transcript ?? [];
		const text = segments.map((s) => s.text ?? '').join(' ').trim();
		const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
		logger.debug(
			`Backend ${isInterim ? 'interim' : 'final'} tag=${this.localTag} lang=${message.language ?? 'n/a'} segments=${segments.length} textLen=${text.length} preview=${JSON.stringify(preview)}`,
		);
	}

	private async reinitializeDecoder(forceReconnect = false): Promise<void> {
		if (!this.backend) {
			throw new Error('Cannot initialize decoder without a backend');
		}

		// Capture a generation token before the first await. Any concurrent call
		// increments reinitGeneration, letting us detect and discard stale work.
		const generation = ++this.reinitGeneration;

		// Discard frames queued for the old decoder — they are in the old audio
		// format.  Frames arriving after this point will use the new format.
		// Already-decoded audio (pendingAudioFrames) was produced by the old decoder
		// and must be discarded too.
		this.pendingInputFrames = [];
		this.pendingAudioFrames = [];
		this.decoder?.free();
		this.decoder = undefined;
		this.decoderStatus = 'pending';

		const oldDesiredFormat = this.activeDesiredFormat;
		const desiredFormat = this.backend.getDesiredAudioFormat(this.inputAudioFormat);

		// Record the target format synchronously so that any concurrent
		// reinitializeDecoder call sees the new value immediately and can decide
		// whether it also needs to replace the backend.
		this.activeDesiredFormat = desiredFormat;

		// Reconnect the backend when its desired audio format has changed (e.g. Deepgram
		// switching between raw-Opus pass-through and decoded PCM) OR when a re-start
		// changed a connect-time flag such as diarize (forceReconnect). Only when a
		// backend already exists — the initial connect is handled by initializeBackend.
		const formatChanged = audioFormatsDiffer(desiredFormat, oldDesiredFormat ?? desiredFormat);
		if (oldDesiredFormat !== undefined && (formatChanged || forceReconnect)) {
			const reconnected = await this.reconnectBackend(generation, formatChanged ? undefined : 'diarize changed');
			if (!reconnected) {
				return; // stale or fatal error — a newer call has taken over
			}
		}

		const newDecoder = createAudioDecoder(this.inputAudioFormat, desiredFormat);
		await newDecoder.ready;

		if (generation !== this.reinitGeneration) {
			logger.debug(`Discarding stale decoder for tag: ${this.localTag} (superseded by generation ${this.reinitGeneration})`);
			newDecoder.free();
			return;
		}

		this.decoder = newDecoder;
		this.decoderStatus = 'ready';
		logger.info(`Audio decoder ready for tag: ${this.localTag} (output: ${desiredFormat.encoding})`);

		if (this.backend?.getStatus() === 'connected') {
			this.processPendingInputFrames();
			this.processPendingAudioData();
		}
	}

	/**
	 * Close the current backend and open a new one for the format stored in
	 * this.activeDesiredFormat.  Returns true if the new backend connected
	 * successfully and the generation is still current; false if the call is
	 * stale (a newer reinitializeDecoder took over) or a fatal error occurred.
	 */
	private async reconnectBackend(generation: number, reason?: string): Promise<boolean> {
		// Reset the identity ring up front — BEFORE the connect await below. The fresh backend stream
		// restarts its per-word media clock at 0, so the ring's clock must too. It has to happen here
		// (not after connect): on the recover path the decoder stays alive, so audio arriving during
		// the reconnect is decoded into the ring AND queued, then flushed to the new backend afterwards
		// (recoverBackend). Resetting after connect would wipe that queued gap audio from the ring while
		// the new backend still receives it → every later word time runs ahead of the ring. JIT-16065.
		this.identityAttributor?.reset();

		// Detach all handlers from the old backend before closing it so that its
		// onClosed / onError callbacks don't trigger OutgoingConnection teardown
		// while we're replacing it.
		const oldBackend = this.backend!;
		const wasConnected = oldBackend.getStatus() === 'connected';
		oldBackend.onInterimTranscription = undefined;
		oldBackend.onCompleteTranscription = undefined;
		oldBackend.onError = undefined;
		oldBackend.onClosed = undefined;
		oldBackend.close();

		if (wasConnected) {
			// onClosed was suppressed above, so we decrement the metric manually.
			getInstruments().backendConnectionsActive.add(-1);
		}

		logger.info(`Reconnecting backend for tag ${this.localTag} (${reason ?? `format changed to: ${this.activeDesiredFormat?.encoding}`})`);

		const newBackend = createBackend(this.localTag, this.participant, this.options.provider, this.getOpenAICustomOptions());
		this.setupBackendHandlers(newBackend);
		this.backend = newBackend;

		// Call getDesiredAudioFormat on the new instance so that backends with
		// connect-time side effects (e.g. DeepgramBackend stores negotiatedFormat)
		// are correctly configured before connect() is called.
		newBackend.getDesiredAudioFormat(this.inputAudioFormat);

		const backendConfig = getBackendConfig(this.options.provider);
		this.applyPerConnectionConfig(backendConfig);

		try {
			const connectStartTime = Date.now();
			await newBackend.connect(backendConfig);

			if (this.isClosed) {
				// doClose() ran concurrently — it already closed newBackend (via
				// this.backend) and decremented the metric if connected.
				return false;
			}

			if (generation !== this.reinitGeneration) {
				// A newer reinitializeDecoder has taken over, or close() was called.
				// Clean up the backend we just connected.  We check the backend's
				// current status rather than assuming it is connected, because
				// doClose() may have already closed it and decremented the metric.
				newBackend.onClosed = undefined;
				const isConnected = newBackend.getStatus() === 'connected';
				newBackend.close();
				if (isConnected) {
					getInstruments().backendConnectionsActive.add(-1);
				}
				return false;
			}

			const connectDurationSec = (Date.now() - connectStartTime) / 1000;
			const instruments = getInstruments();
			instruments.backendConnectionsActive.add(1);
			instruments.backendConnectionDurationSeconds.record(connectDurationSec, { provider: this.options.provider || 'unknown' });

			logger.info(`Backend reconnected for tag: ${this.localTag}`);
			return true;
		} catch (error) {
			if (generation !== this.reinitGeneration) {
				// Stale — a newer call or close() already handles cleanup.
				return false;
			}
			logger.error(`Failed to reconnect backend for tag ${this.localTag}:`, error);
			this.backend = undefined;
			this.onBackendError?.('connection_failed', error instanceof Error ? error.message : 'Unknown error');
			this.doClose(true);
			this.onError?.(this.localTag, `Error reconnecting backend: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	/**
	 * Reopen the transcription backend in place after a recoverable (transient)
	 * backend error, without tearing down the OutgoingConnection. The decoder,
	 * transcript history and negotiated audio format are preserved; only the
	 * backend connection is replaced. Used for e.g. xAI's "ASR stream timed out"
	 * on silence (JIT-15901).
	 */
	private async recoverBackend(errorType: string, errorMessage: string): Promise<void> {
		if (this.isClosed || !this.backend) return;

		// Bump the generation so any in-flight reinitializeDecoder/reconnectBackend
		// call detects it has been superseded; reconnectBackend uses this token to
		// discard stale work after its awaits.
		const generation = ++this.reinitGeneration;

		const reconnected = await this.reconnectBackend(generation, `recovering after ${errorType}: ${errorMessage}`);
		if (!reconnected) {
			// Either a newer call took over, the connection was closed, or
			// reconnectBackend already handled a fatal connect failure (doClose).
			return;
		}

		// Defensive: a concurrent doClose() may have run while reconnectBackend was
		// awaiting. reconnectBackend returns false if isClosed was set by its exit,
		// but re-check here so we never flush into a torn-down connection.
		if (this.isClosed) return;

		// The decoder was left untouched, so it is still ready for the same input
		// format. Flush anything buffered during the reconnect gap.
		if (this.decoderStatus === 'ready') {
			this.processPendingInputFrames();
			this.processPendingAudioData();
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
		// Identity feature: buffer decoded PCM for the sidecar (only the l16/16k path, i.e. xAI).
		// Off the hot path — a copy into a bounded ring, no network here.
		if (
			config.identity?.enabled &&
			this.activeDesiredFormat?.encoding === 'l16' &&
			this.activeDesiredFormat?.sampleRate === 16000
		) {
			this.ensureIdentityAttributor();
			this.identityAttributor?.appendPcm(audioData);
		}

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

	private ensureIdentityAttributor(): void {
		if (this.identityAttributor) return;
		const sidecar = getSidecar();
		const sessionId = this.options.sessionId;
		if (!sidecar || !sessionId) return;
		this.identitySidecar = sidecar;
		this.identityAttributor = new IdentityAttributor(sidecar, {
			sessionId,
			streamId: this.localTag,
			analyzeWindowSec: config.identity?.analyzeWindowSec,
		});
	}

	/** Resolve (once, cached) this participant's stable identity + tenant from the identity source. */
	private resolveIdentity(): Promise<ResolvedIdentity | null> {
		// Reuse the in-flight/resolved promise to dedupe concurrent finals — but only KEEP it once it
		// resolves non-null. A null (KV record not written yet) must not stick for the whole session,
		// or an early first final permanently disables identity/enrollment; clearing it lets a later
		// final retry (the source layer rate-limits the re-query via its negative TTL). JIT-16065.
		if (this.resolvedIdentityP) return this.resolvedIdentityP;
		const src = getIdentitySource();
		const sessionId = this.options.sessionId;
		if (!src || !sessionId) return Promise.resolve(null);
		const p = src.resolve(sessionId, this.participantId).catch(() => null);
		this.resolvedIdentityP = p;
		void p.then((r) => {
			if (!r) this.resolvedIdentityP = undefined;
		});
		return p;
	}

	/**
	 * Handle a final, gated by the per-endpoint `diarize` flag (the room-vs-individual discriminator,
	 * Emil #106 — true only for endpoints carrying multiple speakers). JIT-16065:
	 *  - diarize === true  (room): identify each backend-diarized speaker and return per-speaker
	 *    segments so the store attributes speech to whoever actually spoke. NEVER enroll (a shared
	 *    mic must not pollute a fingerprint).
	 *  - diarize !== true  (individual): the owner is already known from the join, so DON'T run an
	 *    open-set identify (a spurious match would misattribute). Just enroll in the background
	 *    (guarded) and return null → normal mic-owner dispatch.
	 * Returns null when the feature is off / no per-word timing / any failure. Never throws — runs
	 * off the transcription hot path.
	 */
	/**
	 * Whether the backend is diarizing for this connection — mirrors the backend's own resolution
	 * (`backendConfig.diarize ?? config.<provider>.diarize`): the per-endpoint flag when set, else the
	 * provider's global. The identity room path relies on the backend's per-word `speaker` labels, so
	 * this gate must match exactly when those labels are actually produced (else a globally-diarized
	 * endpoint with no per-endpoint flag would wrongly take the individual/enroll path). JIT-16065.
	 */
	private diarizeActive(): boolean {
		if (this.diarize !== undefined) return this.diarize;
		const provider = this.options.provider ?? getDefaultProvider();
		if (provider === 'deepgram') return config.deepgram.diarize;
		if (provider === 'xai') return config.xai.diarize;
		return false;
	}

	async identityAttributeFinal(message: TranscriptionMessage): Promise<AttributedSegment[] | null> {
		if (!this.identityAttributor || message.is_interim) return null;
		try {
			if (this.diarizeActive()) {
				// ROOM: per-speaker identify + attribution override. Needs the backend's per-word speaker
				// labels — skip a final that carries none (the words guard belongs HERE, not before the
				// enroll branch: enroll uses a rolling window and works fine on word-less finals such as
				// xAI granular commits or transcript.done). JIT-16065.
				if (!message.words?.length) return null;
				const resolved = await this.resolveIdentity();
				const tenant = resolved?.tenant ?? config.identity?.tenant ?? 'default';
				const a = await this.identityAttributor.analyze(message.words, tenant);
				if (!a || a.segments.length === 0) return null;
				if (a.speakerCount > 1) this.everSawMultipleSpeakers = true;
				return a.segments;
			}
			// INDIVIDUAL: background enroll only (no identify, no attribution override). Enroll from a
			// ROLLING window of recent audio (not this final's span) so it works regardless of how the
			// backend chunks finals — short granular finals would otherwise never reach enrollMinSpeechSec.
			const w = this.identityAttributor.recentWindow(config.identity?.enrollMinSpeechSec ?? 8);
			if (w) {
				const resolved = await this.resolveIdentity();
				const tenant = resolved?.tenant ?? config.identity?.tenant ?? 'default';
				void this.maybeAutoEnroll(resolved, tenant, w.pcm, w.windowSec);
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Quality-gated + rate-limited enrollment of a single-person (non-diarized) stream's audio.
	 * Before enrolling, the single-mic guard (checkEnrollConsistency) verifies the window is one
	 * consistent voice. A divergent window skips that enroll; only after `enrollConsistencyMaxStrikes`
	 * consecutive divergent windows is enrollment disabled for the stream (so a transient cough/pause
	 * doesn't permanently disable a genuine single speaker). JIT-16065.
	 */
	private async maybeAutoEnroll(resolved: ResolvedIdentity | null, tenant: string, pcm: Buffer, windowSec: number): Promise<void> {
		const c = config.identity;
		if (!resolved || !this.identitySidecar || !c) return;
		if (this.everSawMultipleSpeakers) return; // this stream has shown >1 voice — don't pollute the fingerprint
		if (windowSec < c.enrollMinSpeechSec) return;
		const now = Date.now();
		if (now - this.lastEnrollAt < c.enrollCooldownMs) return;
		if (this.enrollCount >= c.maxEnrollsPerSession) return;
		// Set synchronously (before any await) so overlapping finals don't both pass the cooldown gate.
		this.lastEnrollAt = now;

		// Single-mic guard — only when the client can embed locally (LocalIdentityClient).
		const embed = this.identitySidecar.embed?.bind(this.identitySidecar);
		if (embed) {
			const r = await checkEnrollConsistency(pcm, embed, {
				subWindowSec: c.enrollConsistencySubWindowSec,
				threshold: c.enrollConsistencyThreshold,
			});
			logger.debug(
				`[identity] ${this.localTag} enroll-consistency reason=${r.reason} ` +
					`minCos=${Number.isNaN(r.minCosine) ? 'n/a' : r.minCosine.toFixed(3)} windows=${r.windows}`,
			);
			if (!r.consistent) {
				// Skip THIS enroll, but only disable the stream after enough consecutive divergent
				// windows — a single cough/pause/music window must not permanently disable a genuine
				// single speaker. A consistent window (below) resets the strike count.
				this.enrollDivergenceStrikes++;
				const maxStrikes = c.enrollConsistencyMaxStrikes;
				if (this.enrollDivergenceStrikes >= maxStrikes) {
					this.everSawMultipleSpeakers = true;
					logger.info(
						`[identity] ${this.localTag} enroll disabled — ${this.enrollDivergenceStrikes} consecutive ` +
							`multi-voice windows (last minCos=${r.minCosine.toFixed(3)})`,
					);
				} else {
					logger.debug(
						`[identity] ${this.localTag} enroll skipped — multi-voice window ` +
							`(minCos=${r.minCosine.toFixed(3)}, strike ${this.enrollDivergenceStrikes}/${maxStrikes})`,
					);
				}
				return;
			}
			this.enrollDivergenceStrikes = 0; // consistent window → reset the streak
		}

		this.enrollCount++;
		void this.identitySidecar.enroll(resolved.identity, tenant, pcm, resolved.name).catch(() => {});
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
			// Audio is flowing → the participant is active, so any earlier recoverable
			// errors were transient. Reset the consecutive-recovery guard so an active
			// participant can reconnect without limit (only silent ones get bounded).
			this.consecutiveRecoveries = 0;
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
		const injectedSilenceSec = this.backend.forceCommit();
		// Mirror any provider-injected idle silence into the identity ring so its media clock stays
		// aligned with what the backend received (xAI injects silence to flush a trailing final).
		if (injectedSilenceSec > 0) this.identityAttributor?.appendSilence(injectedSilenceSec);
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

			if (backendType === 'openai' || backendType === 'openai_custom') {
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
		if (this.isClosed) return;
		this.isClosed = true;

		// Increment the generation so any in-flight reinitializeDecoder /
		// reconnectBackend calls detect that they are stale and exit cleanly.
		++this.reinitGeneration;

		logger.debug(`Closing OutgoingConnection for tag: ${this.localTag}`);
		this.clearIdleCommitTimeout();
		this.metricCache.flush();
		this.decoder?.free();
		this.decoder = undefined;
		this.decoderStatus = 'closed';

		if (this.backend) {
			// Detach callbacks before calling close() so that asynchronous backend
			// events (e.g. a WebSocket 'close' frame arriving after we return) do
			// not invoke handlers on this already-torn-down connection.
			this.backend.onClosed = undefined;
			this.backend.onError = undefined;
			this.backend.onInterimTranscription = undefined;
			this.backend.onCompleteTranscription = undefined;
			const wasConnected = this.backend.getStatus() === 'connected';
			this.backend.close();
			this.backend = undefined;
			if (wasConnected) {
				// onClosed was suppressed above, so decrement the metric manually.
				getInstruments().backendConnectionsActive.add(-1);
			}
		}

		// Release any sidecar-side per-session state (no-op for the in-process LocalIdentityClient;
		// frees per-stream state on the WS/HTTP fallback sidecar). Fire-and-forget, never throws.
		if (this.identitySidecar && this.options.sessionId) {
			void this.identitySidecar.sessionEnd(this.options.sessionId, this.localTag).catch(() => {});
		}

		if (notify) {
			this.onClosed?.(this.localTag);
		}
	}
}
