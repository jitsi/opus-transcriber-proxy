import { AgentPacer } from './agent/AgentPacer';
import { RtpTimestamper, RTP_CLOCK_RATE, FRAME_DURATION_MS } from './RtpTimestamper';
import { bytesToBase64, base64ToBytes } from './translate/base64';
import { Emitter } from './translate/emitter';
import type { IOpusDecoder } from './OpusDecoder/opusTypes';
import type { IOpusEncoder } from './OpusEncoder/opusEncoderTypes';
import type { IWebSocket, TranslationRuntime } from './translate/runtime';

// RTP ticks per 20 ms frame (48000 Hz); the talk-stop timestamp is one frame past the last frame's.
const SAMPLES_PER_FRAME = (RTP_CLOCK_RATE * FRAME_DURATION_MS) / 1000;

// The PCM format spoken on the customer leg (both directions). 24 kHz matches the Opus codec
// pipeline used by the translation path (no resampling step); voice-agent frameworks (e.g.
// Pipecat) resample internally as needed. TODO(MVP gap): offer 16 kHz via the Resampler.
export const AGENT_PCM_SAMPLE_RATE = 24000;
const AGENT_MEDIA_FORMAT = { encoding: 'audio/l16', sampleRate: AGENT_PCM_SAMPLE_RATE, channels: 1 };

// Bounds on buffering while the codecs / customer socket initialise (mirrors TranslatorConnection).
const MAX_PENDING_OPUS_FRAMES = 500; // ~10 s of 20 ms frames per source
const MAX_PENDING_PCM_BYTES = AGENT_PCM_SAMPLE_RATE * 2 * 10; // 10 s of return PCM
const MAX_PENDING_ENDPOINT_MESSAGES = 1000; // JSON messages queued before the customer socket opens

export interface AgentProxyOptions {
	/** The customer's WebSocket endpoint to dial out to. */
	endpointUrl: string;
	/**
	 * Opens the outbound WebSocket to the customer endpoint. Injected by the host (server.ts uses
	 * `ws` with forwarded auth headers); NOT the runtime's OpenAI-shaped factory, whose bearer-token
	 * handling is OpenAI-specific.
	 */
	createEndpointWebSocket: (url: string) => IWebSocket;
	/** Opaque provisioning metadata echoed to the customer in `start.customParameters`. */
	customParameters?: Record<string, unknown>;
	/** How much agent audio (ms) may be released ahead of real time. Default 200. */
	paceLeadMs?: number;
}

/** Per-participant-source state: decodes the bridge's Opus into PCM for the customer leg. */
interface SourceState {
	decoder?: IOpusDecoder<typeof AGENT_PCM_SAMPLE_RATE>;
	decoderStatus: 'pending' | 'ready' | 'failed';
	pendingFrames: Uint8Array[];
	/** Per-source chunk counter on the customer leg. */
	chunk: number;
	/** The last timestamp seen from the bridge, passed through to the customer leg. */
	lastTimestamp: number;
}

/**
 * Bridges a single `/agent` WebSocket (the bridge's voice-agent connect) to the customer's agent
 * server:
 *
 *  - Bridge → customer: every exported source's Opus is decoded to PCM16 mono 24 kHz and forwarded
 *    as mediajson `media` events (per-source `start` announcements carry the format and the
 *    provisioning metadata).
 *  - Customer → bridge: `media` events (base64 PCM16 24 kHz, any chunking) are Opus-encoded (DTX),
 *    paced to ~real time (see [AgentPacer]) and returned tagged with the agent's synthetic source
 *    name (from the bridge's `sources.requests`), with talk boundaries inferred from DTX silence
 *    exactly like the translation path.
 *  - `clear` (barge-in) drops the un-released part of the agent's audio; `mark` checkpoints are
 *    echoed back once the pacer releases past them.
 *
 * A failure on the customer leg closes the bridge socket: the bridge's Exporter reconnects with
 * backoff, which re-dials the customer endpoint (session-level retry for free).
 */
export class AgentProxy extends Emitter {
	private readonly ws: IWebSocket;
	private readonly options: AgentProxyOptions;
	private readonly runtime: TranslationRuntime;

	private readonly sources = new Map<string, SourceState>();

	/** The agent's synthetic source name, from the bridge's `sources.requests`. */
	private agentTag?: string;

	private endpointWs?: IWebSocket;
	private endpointStatus: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private pendingEndpointMessages: string[] = [];

	private encoder?: IOpusEncoder;
	private encoderStatus: 'pending' | 'ready' | 'failed' = 'pending';
	private pendingReturnPcm: Uint8Array = new Uint8Array(0);

	private readonly rtpTimestamper = new RtpTimestamper();
	private readonly pacer: AgentPacer;

	/** Monotonic mediajson wire-envelope sequence for bridge-bound messages. */
	private envelopeSequenceNumber = 0;
	/** Monotonic mediajson wire-envelope sequence for customer-bound messages. */
	private endpointSequenceNumber = 0;

	private talkActive = false;
	private talkStartTimestamp = 0;
	private lastFrameTimestamp = 0;
	private talkBytes = 0;
	private talkTimeout?: ReturnType<typeof setTimeout>;
	private readonly talkSilenceTimeoutMs: number;

	private isClosed = false;

	constructor(ws: IWebSocket, options: AgentProxyOptions, runtime: TranslationRuntime) {
		super();
		this.ws = ws;
		this.options = options;
		this.runtime = runtime;
		this.talkSilenceTimeoutMs = runtime.config.talkSilenceTimeoutMs ?? 350;
		this.pacer = new AgentPacer({ leadMs: options.paceLeadMs });
		this.pacer.onFrame = (payload) => this.sendAgentFrame(payload);
		this.pacer.onMark = (name) => this.sendToEndpoint({ event: 'mark', mark: { name } });

		this.ws.addEventListener('close', () => this.close());
		this.ws.addEventListener('error', (event) => {
			const message = (event as { message?: string }).message ?? 'WebSocket error';
			this.runtime.logger.error(`AgentProxy bridge WebSocket error: ${message}`);
		});
		this.ws.addEventListener('message', (event) => this.handleBridgeMessage(event.data));

		this.initializeEncoder();
		// Deferred to a microtask so the host has wired the 'error'/'closed' handlers by the time a
		// synchronous connect failure (e.g. malformed URL) can fire.
		queueMicrotask(() => this.connectEndpoint());

		const info = this.runtime.buildServerInfo();
		if (info !== undefined) {
			try {
				this.ws.send(JSON.stringify(info));
			} catch (error) {
				this.runtime.logger.error('Failed to send server info on /agent:', error);
			}
		}
	}

	/** Tear down both legs and all codec/pacer state. Idempotent. */
	close(): void {
		if (this.isClosed) {
			return;
		}
		this.isClosed = true;
		this.endTalk();
		this.pacer.close();
		if (this.talkTimeout !== undefined) {
			clearTimeout(this.talkTimeout);
			this.talkTimeout = undefined;
		}
		for (const state of this.sources.values()) {
			state.decoder?.free();
		}
		this.sources.clear();
		this.encoder?.free();
		try {
			this.endpointWs?.close();
		} catch {
			// already closing/closed
		}
		try {
			this.ws.close();
		} catch {
			// already closing/closed
		}
		this.emit('closed');
	}

	// ---------------------------------------------------------------- bridge leg

	private handleBridgeMessage(data: unknown): void {
		let message: any;
		try {
			message = JSON.parse(data as string);
		} catch {
			return;
		}
		if (!message || typeof message !== 'object') {
			return;
		}

		switch (message.event) {
			case 'ping': {
				const pong: { event: string; id?: number } = { event: 'pong' };
				if (typeof message.id === 'number') {
					pong.id = message.id;
				}
				this.ws.send(JSON.stringify(pong));
				break;
			}
			case 'sources':
				this.handleSources(message.requests ?? []);
				break;
			case 'start':
				// Per-source stream announcement from the bridge. The exported audio is always Opus 48k;
				// the customer-leg start is sent when the source's first media arrives (ensureSource).
				this.runtime.logger.info(`agent: bridge start for tag ${message.start?.tag}`);
				break;
			case 'media':
				this.handleBridgeMedia(message);
				break;
			case 'info':
				this.runtime.logger.info(`Received info from bridge on /agent: ${JSON.stringify(message)}`);
				break;
			default:
				break;
		}
	}

	private handleSources(requests: unknown): void {
		const requestList: string[] = Array.isArray(requests) ? requests.filter((s): s is string => typeof s === 'string') : [];
		if (requestList.length === 0) {
			this.runtime.logger.warn('agent: sources event with no requests; keeping previous agent tag');
			return;
		}
		if (requestList.length > 1) {
			this.runtime.logger.warn(`agent: ${requestList.length} requested sources, using the first (${requestList[0]})`);
		}
		if (this.agentTag !== undefined && this.agentTag !== requestList[0]) {
			this.runtime.logger.warn(`agent: requested source changed from ${this.agentTag} to ${requestList[0]}`);
		}
		this.agentTag = requestList[0];
	}

	private handleBridgeMedia(message: any): void {
		const tag = message.media?.tag;
		const payload = message.media?.payload;
		if (typeof tag !== 'string' || tag.length === 0 || typeof payload !== 'string') {
			return;
		}
		// Don't feed the agent its own (or another agent's) audio back. The bridge already excludes
		// synthetic sources from exports; this is a local safety net.
		if (tag === this.agentTag) {
			return;
		}

		let opusFrame: Uint8Array;
		try {
			opusFrame = base64ToBytes(payload);
		} catch {
			return;
		}

		const state = this.ensureSource(tag);
		if (Number.isInteger(message.media?.timestamp)) {
			state.lastTimestamp = message.media.timestamp;
		}

		if (state.decoderStatus === 'ready' && state.decoder) {
			this.decodeAndForward(tag, state, opusFrame);
		} else if (state.decoderStatus === 'pending') {
			if (state.pendingFrames.length < MAX_PENDING_OPUS_FRAMES) {
				state.pendingFrames.push(opusFrame);
			}
		}
	}

	private ensureSource(tag: string): SourceState {
		let state = this.sources.get(tag);
		if (state !== undefined) {
			return state;
		}
		state = { decoderStatus: 'pending', pendingFrames: [], chunk: 0, lastTimestamp: 0 };
		this.sources.set(tag, state);

		// Announce the stream to the customer before its first media.
		this.sendToEndpoint({
			event: 'start',
			start: {
				tag,
				mediaFormat: { ...AGENT_MEDIA_FORMAT },
				...(this.options.customParameters !== undefined ? { customParameters: this.options.customParameters } : {}),
			},
		});

		const decoder = this.runtime.createOpusDecoder({ sampleRate: AGENT_PCM_SAMPLE_RATE, channels: 1 });
		state.decoder = decoder;
		decoder.ready
			.then(() => {
				if (this.isClosed) {
					return;
				}
				state.decoderStatus = 'ready';
				const queued = state.pendingFrames;
				state.pendingFrames = [];
				for (const frame of queued) {
					this.decodeAndForward(tag, state, frame);
				}
			})
			.catch((error: unknown) => {
				state.decoderStatus = 'failed';
				state.pendingFrames = [];
				this.runtime.logger.error(`agent: failed to initialise decoder for tag ${tag}:`, error);
			});
		return state;
	}

	private decodeAndForward(tag: string, state: SourceState, opusFrame: Uint8Array): void {
		if (!state.decoder) {
			return;
		}
		try {
			const decoded = state.decoder.decodeFrame(opusFrame);
			if (decoded.errors.length > 0 || decoded.audioData.length === 0) {
				return;
			}
			this.sendToEndpoint({
				event: 'media',
				media: {
					tag,
					chunk: state.chunk++,
					timestamp: state.lastTimestamp,
					payload: bytesToBase64(decoded.audioData),
				},
			});
		} catch (error) {
			this.runtime.logger.error(`agent: failed to decode media for tag ${tag}:`, error);
		}
	}

	// -------------------------------------------------------------- customer leg

	private connectEndpoint(): void {
		if (this.isClosed) {
			return;
		}
		try {
			const endpointWs = this.options.createEndpointWebSocket(this.options.endpointUrl);
			this.endpointWs = endpointWs;

			endpointWs.addEventListener('open', () => {
				this.runtime.logger.info(`agent: connected to endpoint ${this.options.endpointUrl}`);
				this.endpointStatus = 'connected';
				const queued = this.pendingEndpointMessages;
				this.pendingEndpointMessages = [];
				for (const message of queued) {
					endpointWs.send(message);
				}
			});
			endpointWs.addEventListener('message', (event) => this.handleEndpointMessage(event.data));
			endpointWs.addEventListener('error', (event) => {
				const message = (event as { message?: string }).message ?? 'WebSocket error';
				this.runtime.logger.error(`agent: endpoint WebSocket error: ${message}`);
				this.endpointStatus = 'failed';
				this.emit('error', message);
				// Close the bridge leg: the Exporter's reconnect re-dials the endpoint (session retry).
				this.close();
			});
			endpointWs.addEventListener('close', () => {
				if (this.endpointStatus !== 'failed') {
					this.endpointStatus = 'closed';
				}
				this.close();
			});

			this.sendToEndpoint({
				event: 'info',
				application: 'opus-transcriber-proxy',
				mediaFormat: { ...AGENT_MEDIA_FORMAT },
				...(this.options.customParameters !== undefined ? { customParameters: this.options.customParameters } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.runtime.logger.error(`agent: failed to open endpoint WebSocket: ${message}`);
			this.endpointStatus = 'failed';
			this.emit('error', message);
			this.close();
		}
	}

	private sendToEndpoint(message: Record<string, unknown>): void {
		const serialized = JSON.stringify({ ...message, sequenceNumber: this.endpointSequenceNumber++ });
		if (this.endpointStatus === 'connected' && this.endpointWs) {
			try {
				this.endpointWs.send(serialized);
			} catch (error) {
				this.runtime.logger.error('agent: failed to send to endpoint:', error);
			}
		} else if (this.endpointStatus === 'pending') {
			if (this.pendingEndpointMessages.length < MAX_PENDING_ENDPOINT_MESSAGES) {
				this.pendingEndpointMessages.push(serialized);
			}
		}
	}

	private handleEndpointMessage(data: unknown): void {
		let message: any;
		try {
			message = JSON.parse(data as string);
		} catch {
			return;
		}
		if (!message || typeof message !== 'object') {
			return;
		}

		switch (message.event) {
			case 'media':
				this.handleAgentMedia(message);
				break;
			case 'clear': {
				const dropped = this.pacer.clear();
				this.runtime.logger.info(`agent: clear (barge-in), dropped ${dropped} queued frames`);
				break;
			}
			case 'mark':
				if (typeof message.mark?.name === 'string') {
					this.pacer.mark(message.mark.name);
				}
				break;
			case 'ping': {
				const pong: { event: string; id?: number } = { event: 'pong' };
				if (typeof message.id === 'number') {
					pong.id = message.id;
				}
				this.sendToEndpoint(pong);
				break;
			}
			case 'pong':
			case 'info':
				break;
			default:
				break;
		}
	}

	// -------------------------------------------------------------- return path

	private initializeEncoder(): void {
		try {
			this.encoder = this.runtime.createOpusEncoder({
				sampleRate: AGENT_PCM_SAMPLE_RATE,
				channels: 1,
				application: 'voip',
				bitrate: 64000,
				complexity: 5,
				// DTX lets libopus's VAD flag silence frames; they are dropped and bracket the talks.
				dtx: true,
			});
			this.encoder.ready
				.then(() => {
					if (this.isClosed) {
						return;
					}
					this.encoderStatus = 'ready';
					if (this.pendingReturnPcm.length > 0) {
						const queued = this.pendingReturnPcm;
						this.pendingReturnPcm = new Uint8Array(0);
						this.encodeReturnPcm(queued);
					}
				})
				.catch((error: unknown) => {
					this.encoderStatus = 'failed';
					this.runtime.logger.error('agent: failed to initialise encoder:', error);
					this.emit('error', 'Opus encoder initialisation failed');
					this.close();
				});
		} catch (error) {
			this.encoderStatus = 'failed';
			this.runtime.logger.error('agent: failed to create encoder:', error);
			this.emit('error', 'Opus encoder creation failed');
			this.close();
		}
	}

	private handleAgentMedia(message: any): void {
		const payload = message.media?.payload;
		if (typeof payload !== 'string' || payload.length === 0) {
			return;
		}
		if (this.agentTag === undefined) {
			// No `sources` from the bridge yet: the synthetic source isn't known, so audio can't be
			// attributed. Drop (the bridge sends `sources` immediately on connect).
			return;
		}

		let pcm: Uint8Array;
		try {
			pcm = base64ToBytes(payload);
		} catch {
			return;
		}

		if (this.encoderStatus === 'ready') {
			this.encodeReturnPcm(pcm);
		} else if (this.encoderStatus === 'pending') {
			if (this.pendingReturnPcm.length + pcm.length <= MAX_PENDING_PCM_BYTES) {
				const merged = new Uint8Array(this.pendingReturnPcm.length + pcm.length);
				merged.set(this.pendingReturnPcm);
				merged.set(pcm, this.pendingReturnPcm.length);
				this.pendingReturnPcm = merged;
			}
		}
	}

	private encodeReturnPcm(pcm: Uint8Array): void {
		if (!this.encoder) {
			return;
		}
		try {
			const frames = this.encoder.encodeFrame(pcm);
			for (const frame of frames) {
				// DTX frame: silence, not voice. Don't queue it — the pacer gap plus the RtpTimestamper's
				// gap insertion produce true silence downstream, and the talk timer ends the talk.
				if (!frame.inDtx) {
					this.pacer.push(frame.data);
				}
			}
		} catch (error) {
			this.runtime.logger.error('agent: failed to encode return audio:', error);
		}
	}

	/** Called by the pacer as each frame becomes due: stamp RTP timing and emit toward the bridge. */
	private sendAgentFrame(payload: Uint8Array): void {
		const tag = this.agentTag;
		if (tag === undefined) {
			return;
		}
		const { timestamp, sequenceNumber: rtpSequenceNumber, bufferAheadMs } = this.rtpTimestamper.nextFrameTimestamp();

		if (!this.talkActive) {
			this.talkActive = true;
			this.talkStartTimestamp = timestamp;
			this.talkBytes = 0;
			this.emit('talkStart', { tag, timestamp, sequenceNumber: this.envelopeSequenceNumber++ });
		}
		this.lastFrameTimestamp = timestamp;
		this.talkBytes += payload.length;
		this.armTalkSilenceTimer(bufferAheadMs);

		this.emit('audioFrame', {
			tag,
			chunk: rtpSequenceNumber,
			timestamp,
			payload: bytesToBase64(payload),
			sequenceNumber: this.envelopeSequenceNumber++,
		});
	}

	private armTalkSilenceTimer(playoutAheadMs: number): void {
		if (this.talkSilenceTimeoutMs <= 0) {
			return;
		}
		if (this.talkTimeout !== undefined) {
			clearTimeout(this.talkTimeout);
		}
		this.talkTimeout = setTimeout(() => {
			this.talkTimeout = undefined;
			this.endTalk();
		}, playoutAheadMs + this.talkSilenceTimeoutMs);
	}

	private endTalk(): void {
		if (!this.talkActive) {
			return;
		}
		this.talkActive = false;
		const tag = this.agentTag;
		if (tag === undefined) {
			return;
		}
		const stopTimestamp = this.lastFrameTimestamp + SAMPLES_PER_FRAME;
		const durationMs = Math.round(((stopTimestamp - this.talkStartTimestamp) * 1000) / RTP_CLOCK_RATE);
		this.emit('talkStop', {
			tag,
			timestamp: stopTimestamp,
			mediaInfo: { bytesSent: this.talkBytes, duration: durationMs },
			sequenceNumber: this.envelopeSequenceNumber++,
		});
	}
}
