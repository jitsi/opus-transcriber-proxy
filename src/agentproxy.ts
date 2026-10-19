import { AgentPacer } from './agent/AgentPacer';
import { closeReason } from './agent/closeReason';
import { AgentFanIn, DEFAULT_AGENT_FAN_IN } from './agent/fanIn';
import { AgentEncoding, opusPacketDurationMs } from './agent/mediaFormat';
import { computeAudioLevel } from './OpusEncoder/audioLevel';
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
// Opus on the customer leg: RTP Opus packets as the bridge exports them, relayed without decoding.
const AGENT_OPUS_MEDIA_FORMAT = { encoding: 'audio/opus', sampleRate: RTP_CLOCK_RATE, channels: 1 };
// libopus emits a packet of at most 2 bytes for a DTX (silence) frame.
const MAX_OPUS_DTX_PACKET_BYTES = 2;
// RFC 6716 §3.2.1: one Opus frame is at most 1275 bytes, and a 20 ms packet from an encoder is one frame.
const MAX_OPUS_PACKET_BYTES = 1275;
// RFC 6464 level at or above which a decoded agent packet is silence: encoded digital silence and libopus's
// comfort-noise refreshes decode to about -100..-117 dBov, speech to well above -90.
const OPUS_SILENCE_LEVEL = 95;

// Wire-protocol identity in `info`; bump major only on a breaking change (see AGENT_PROTOCOL.md).
export const AGENT_PROTOCOL = 'jitsi-agent-media';
export const AGENT_PROTOCOL_VERSION = '1.1';

/** Application close code on the bridge leg after the agent's `end`: the session is over, not to be redialed. */
export const CLOSE_CODE_AGENT_ENDED = 4001;
/**
 * Application close code on the bridge leg when the dial to the customer endpoint failed, or the agent broke the
 * media contract: redialing would repeat it.
 */
export const CLOSE_CODE_ENDPOINT_UNREACHABLE = 4002;

/** A short, stable reason for a failed dial, fitting the 123-byte WebSocket close reason. */
export function dialFailureReason(message: string): string {
	const refused = /Unexpected server response: (\d+)/.exec(message);
	return closeReason(refused ? `endpoint refused: HTTP ${refused[1]}` : `endpoint unreachable: ${message}`);
}

// Bounds on buffering while the codecs / customer socket initialise (mirrors TranslatorConnection).
const MAX_PENDING_OPUS_FRAMES = 500; // ~10 s of 20 ms frames per source
const MAX_PENDING_PCM_BYTES = AGENT_PCM_SAMPLE_RATE * 2 * 10; // 10 s of return PCM
const MAX_PENDING_ENDPOINT_MESSAGES = 1000; // JSON messages queued before the customer socket opens
const MAX_QUEUED_AGENT_FRAMES = 3000; // 60 s of agent audio waiting in the pacer
/** WebSocket close code towards the agent when it broke the media contract. */
const CLOSE_CODE_POLICY_VIOLATION = 1008;

export interface AgentProxyOptions {
	/** The customer's WebSocket endpoint to dial out to. */
	endpointUrl: string;
	/** Identify the dial to a customer server hosting many bots; carried in `info`. */
	agentId?: string;
	conference?: string;
	meetingId?: string;
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
	/** The customer-leg encoding the invite asked for. Default `audio/l16`. */
	encoding?: AgentEncoding;
	/** Which participants' audio the agent hears (see [AgentFanIn]). Default `per-source`. */
	fanIn?: AgentFanIn;
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
	/** Once-only warnings for this source. */
	warnedDroppingFailed?: boolean;
	warnedPendingFull?: boolean;
}

/** A message queued for the customer until its socket opens; control messages are never dropped, media is. */
interface PendingEndpointMessage {
	control: boolean;
	serialized: string;
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
 *  - With `audio/opus` neither direction is transcoded: participant packets go out as exported, and the
 *    agent's 20 ms packets are paced and returned as sent. Only the agent's single stream is decoded,
 *    for the audio level the bridge's speaker detection needs.
 *  - The bridge's `speakers` events (exported sources in recent-speaker order, the dominant speaker first)
 *    are passed on to the customer. With the `dominant` fan-in only the first listed source's audio is
 *    forwarded, so the agent hears one speaker at a time without measuring levels itself.
 *
 * A failure on the customer leg closes the bridge socket: the bridge's Exporter reconnects with
 * backoff, which re-dials the customer endpoint (session-level retry for free).
 */
export class AgentProxy extends Emitter {
	private readonly ws: IWebSocket;
	private readonly options: AgentProxyOptions;

	/** Per-dial id, so the customer can tell a redial from a new session. */
	private readonly sessionId = globalThis.crypto.randomUUID();
	private readonly runtime: TranslationRuntime;

	private readonly sources = new Map<string, SourceState>();

	/** Opus on the customer leg (no transcoding); otherwise PCM16. */
	private readonly opus: boolean;
	private readonly fanIn: AgentFanIn;
	/** Exported sources in recent-speaker order as the bridge last reported them; undefined until it has. */
	private speakers?: string[];
	private warnedNoSpeakers = false;
	private readonly mediaFormat: Record<string, unknown>;
	/** Opus mode: decodes the agent's packets for their audio level only. */
	private levelDecoder?: IOpusDecoder<typeof AGENT_PCM_SAMPLE_RATE>;
	private levelDecoderReady = false;
	private warnedPacerFull = false;
	/** How the customer socket is closed, when not normally. */
	private endpointClose?: { code: number; reason: string };

	/** The agent's synthetic source name, from the bridge's `sources.requests`. */
	private agentTag?: string;

	private endpointWs?: IWebSocket;
	private endpointStatus: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private pendingEndpointMessages: PendingEndpointMessage[] = [];
	private warnedPendingEndpointFull = false;
	private warnedReturnPcmFull = false;
	/** A session ends once: `failed` or `ended`, whichever comes first; later terminal events are not reported. */
	private terminalReported = false;

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
		this.opus = options.encoding === 'audio/opus';
		this.fanIn = options.fanIn ?? DEFAULT_AGENT_FAN_IN;
		this.mediaFormat = this.opus ? AGENT_OPUS_MEDIA_FORMAT : AGENT_MEDIA_FORMAT;
		this.pacer = new AgentPacer({ leadMs: options.paceLeadMs });
		this.pacer.onFrame = (payload, audioLevel) => this.sendAgentFrame(payload, audioLevel);
		this.pacer.onMark = (name) => this.sendToEndpoint({ event: 'mark', mark: { name } });

		this.ws.addEventListener('close', () => this.close());
		this.ws.addEventListener('error', (event) => {
			const message = (event as { message?: string }).message ?? 'WebSocket error';
			this.runtime.logger.error(`AgentProxy bridge WebSocket error: ${message}`);
		});
		this.ws.addEventListener('message', (event) => this.handleBridgeMessage(event.data));

		if (this.opus) {
			this.initializeLevelDecoder();
		} else {
			this.initializeEncoder();
		}
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
	close(code?: number, reason?: string): void {
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
		this.levelDecoder?.free();
		try {
			this.endpointWs?.close(this.endpointClose?.code, this.endpointClose?.reason);
		} catch {
			// already closing/closed
		}
		try {
			this.ws.close(code, reason);
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
			case 'speakers':
				this.handleSpeakers(message);
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
		// A sources update carries new exports (consent changes); jicofo never empties requests without expiring
		// the connect, so an empty list is a malformed update, not a request to drop the agent's tag.
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

	/**
	 * The bridge's speaker order: the exported sources, the dominant speaker first. Passed on to the customer as a
	 * hint in every fan-in, and the selector for the `dominant` one.
	 */
	private handleSpeakers(message: any): void {
		const speakers: string[] = Array.isArray(message.speakers)
			? message.speakers.filter((s: unknown): s is string => typeof s === 'string' && s !== this.agentTag)
			: [];
		const silence = message.silence === true;
		if (this.fanIn === 'dominant' && speakers[0] !== this.speakers?.[0]) {
			this.runtime.logger.info(`agent: dominant speaker is now ${speakers[0] ?? 'nobody'}`);
		}
		this.speakers = speakers;
		this.sendToEndpoint({ event: 'speakers', speakers, silence });
	}

	/** Whether this source's audio goes to the agent under the fan-in policy. */
	private fansIn(tag: string): boolean {
		if (this.fanIn !== 'dominant') {
			return true;
		}
		if (this.speakers === undefined) {
			// A bridge from before speaker orders: every exported source, as per-source would.
			if (!this.warnedNoSpeakers) {
				this.warnedNoSpeakers = true;
				this.runtime.logger.warn('agent: dominant fan-in but the bridge sends no speaker order; forwarding every source');
			}
			return true;
		}
		return tag === this.speakers[0];
	}

	private handleBridgeMedia(message: any): void {
		const tag = message.media?.tag;
		const payload = message.media?.payload;
		if (typeof tag !== 'string' || tag.length === 0 || typeof payload !== 'string') {
			return;
		}
		// Don't feed the agent its own (or another agent's) audio back. The bridge already excludes
		// synthetic sources from exports; this is a local safety net.
		if (tag === this.agentTag || !this.fansIn(tag)) {
			return;
		}
		if (this.opus) {
			this.forwardOpus(tag, message.media);
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
			} else if (!state.warnedPendingFull) {
				state.warnedPendingFull = true;
				this.runtime.logger.warn(`agent: dropping media for tag ${tag} while its decoder initialises (${MAX_PENDING_OPUS_FRAMES} frames queued)`);
				this.runtime.writeMetric({ name: 'agent_media_dropped', worker: 'opus-transcriber-proxy', errorType: 'decoder_pending' });
			}
		} else if (!state.warnedDroppingFailed) {
			// The customer got a `stop` for the tag when its decoder failed; say once that its media goes nowhere.
			state.warnedDroppingFailed = true;
			this.runtime.logger.warn(`agent: dropping media for tag ${tag}: its decoder failed to initialise`);
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
				mediaFormat: { ...this.mediaFormat },
				...(this.options.customParameters !== undefined ? { customParameters: this.options.customParameters } : {}),
			},
		});
		if (this.opus) {
			return state;
		}

		const decoder = this.runtime.createOpusDecoder({ sampleRate: AGENT_PCM_SAMPLE_RATE, channels: 1 });
		state.decoder = decoder;
		decoder.ready
			.then(() => {
				if (this.isClosed) {
					// free() before ready is a no-op, so close() could not release it.
					decoder.free();
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
				this.runtime.writeMetric({ name: 'agent_decoder_failure', worker: 'opus-transcriber-proxy' });
				// The customer was told the stream starts; tell it the stream is over rather than go silent.
				if (!this.isClosed) {
					this.sendToEndpoint({ event: 'stop', stop: { tag } });
				}
			});
		return state;
	}

	/** Opus mode: the participant's packet goes out as exported, keeping the bridge's numbering so gaps show loss. */
	private forwardOpus(tag: string, media: { chunk?: unknown; timestamp?: unknown; payload: string }): void {
		if (!Number.isInteger(media.chunk) || !Number.isInteger(media.timestamp)) {
			return;
		}
		this.ensureSource(tag);
		this.sendToEndpoint({ event: 'media', media: { tag, chunk: media.chunk, timestamp: media.timestamp, payload: media.payload } });
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
					endpointWs.send(message.serialized);
				}
				this.emit('lifecycle', { state: 'active' });
			});
			endpointWs.addEventListener('message', (event) => this.handleEndpointMessage(event.data));
			endpointWs.addEventListener('error', (event) => {
				const message = (event as { message?: string }).message ?? 'WebSocket error';
				this.runtime.logger.error(`agent: endpoint WebSocket error: ${message}`);
				if (this.endpointStatus === 'pending') {
					this.failDial(message);
					return;
				}
				this.endpointStatus = 'failed';
				this.emit('error', message);
				// Mid-session loss: a normal close lets the bridge redial (session retry).
				this.close();
			});
			endpointWs.addEventListener('close', () => {
				if (this.endpointStatus === 'pending') {
					this.failDial('endpoint closed before the handshake completed');
					return;
				}
				if (this.endpointStatus !== 'failed') {
					this.endpointStatus = 'closed';
				}
				this.close();
			});

			this.sendToEndpoint({
				event: 'info',
				protocol: AGENT_PROTOCOL,
				version: AGENT_PROTOCOL_VERSION,
				application: 'opus-transcriber-proxy',
				mediaFormat: { ...this.mediaFormat },
				fanIn: this.fanIn,
				sessionId: this.sessionId,
				...(this.options.agentId !== undefined ? { agentId: this.options.agentId } : {}),
				...(this.options.conference !== undefined ? { conference: this.options.conference } : {}),
				...(this.options.meetingId !== undefined ? { meetingId: this.options.meetingId } : {}),
				...(this.options.customParameters !== undefined ? { customParameters: this.options.customParameters } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.runtime.logger.error(`agent: failed to open endpoint WebSocket: ${message}`);
			this.failDial(message);
		}
	}

	/** The customer endpoint could not be reached: terminal for this leg, so the bridge does not redial into the same failure. */
	private failDial(message: string): void {
		if (this.endpointStatus === 'failed') {
			return;
		}
		this.endpointStatus = 'failed';
		const reason = dialFailureReason(message);
		this.emit('error', message);
		// Close the bridge leg before reporting: the report makes jicofo drop the connect within milliseconds, and the
		// bridge should see our terminal code rather than its own close racing it.
		this.close(CLOSE_CODE_ENDPOINT_UNREACHABLE, reason);
		this.reportTerminal('failed', reason);
	}

	/** Emits the session's terminal lifecycle state, once: an `end` after a failure, or a second `end`, changes nothing. */
	private reportTerminal(state: 'failed' | 'ended', reason: string): void {
		if (this.terminalReported) {
			return;
		}
		this.terminalReported = true;
		this.emit('lifecycle', { state, reason });
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
			this.queueEndpointMessage(message.event !== 'media', serialized);
		}
	}

	/**
	 * Queues a message until the customer socket opens. The queue is shared by every source, so when it is full a
	 * control message (`start`, `speakers`, ...) evicts the oldest queued media rather than being dropped: media the
	 * customer never gets is a gap, a `start` it never gets is a tag it was never told about.
	 */
	private queueEndpointMessage(control: boolean, serialized: string): void {
		if (this.pendingEndpointMessages.length >= MAX_PENDING_ENDPOINT_MESSAGES) {
			const oldestMedia = control ? this.pendingEndpointMessages.findIndex((m) => !m.control) : -1;
			if (oldestMedia >= 0) {
				this.pendingEndpointMessages.splice(oldestMedia, 1);
			} else if (!control) {
				if (!this.warnedPendingEndpointFull) {
					this.warnedPendingEndpointFull = true;
					this.runtime.logger.warn(`agent: dropping media while the endpoint connects (${MAX_PENDING_ENDPOINT_MESSAGES} messages queued)`);
				}
				this.runtime.writeMetric({ name: 'agent_media_dropped', worker: 'opus-transcriber-proxy', errorType: 'endpoint_pending' });
				return;
			}
		}
		this.pendingEndpointMessages.push({ control, serialized });
	}

	private handleEndpointMessage(data: unknown): void {
		if (this.isClosed) {
			// `ws` still delivers messages while closing; nothing said now may change what was reported.
			return;
		}
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
			case 'end':
				this.runtime.logger.info('agent: end (agent-initiated teardown)');
				this.close(CLOSE_CODE_AGENT_ENDED, 'agent ended');
				this.reportTerminal('ended', 'agent ended');
				break;
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
			const encoder = this.encoder;
			encoder.ready
				.then(() => {
					if (this.isClosed) {
						encoder.free();
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
		if (this.opus) {
			this.relayAgentOpus(pcm);
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
			} else if (!this.warnedReturnPcmFull) {
				this.warnedReturnPcmFull = true;
				this.runtime.logger.warn(`agent: dropping agent audio while the encoder initialises (${MAX_PENDING_PCM_BYTES} bytes queued)`);
				this.runtime.writeMetric({ name: 'agent_media_dropped', worker: 'opus-transcriber-proxy', errorType: 'encoder_pending' });
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
					this.pushAgentFrame(frame.data, frame.audioLevel);
				}
			}
		} catch (error) {
			this.runtime.logger.error('agent: failed to encode return audio:', error);
		}
	}

	private initializeLevelDecoder(): void {
		try {
			const decoder = this.runtime.createOpusDecoder({ sampleRate: AGENT_PCM_SAMPLE_RATE, channels: 1 });
			this.levelDecoder = decoder;
			decoder.ready
				.then(() => {
					if (this.isClosed) {
						decoder.free();
						return;
					}
					this.levelDecoderReady = true;
				})
				.catch((error: unknown) => {
					// Audio still flows, just without a level or a validity check.
					this.runtime.logger.warn(`agent: failed to initialise the level decoder: ${String(error)}`);
				});
		} catch (error) {
			this.runtime.logger.warn(`agent: failed to create the level decoder: ${String(error)}`);
		}
	}

	/**
	 * Opus mode: one 20 ms packet per agent `media`, paced and returned unchanged. DTX packets and packets that
	 * decode to silence are dropped (ending the talk); a packet that breaks the contract ends the session.
	 */
	private relayAgentOpus(packet: Uint8Array): void {
		if (packet.length <= MAX_OPUS_DTX_PACKET_BYTES) {
			return;
		}
		if (opusPacketDurationMs(packet) !== FRAME_DURATION_MS || packet.length > MAX_OPUS_PACKET_BYTES) {
			this.failAgent(`agent audio must be ${FRAME_DURATION_MS} ms Opus packets of at most ${MAX_OPUS_PACKET_BYTES} bytes`);
			return;
		}
		const level = this.measureAgentPacket(packet);
		if (level === 'invalid') {
			this.failAgent('agent sent an Opus packet that does not decode');
			return;
		}
		if (level !== undefined && level >= OPUS_SILENCE_LEVEL) {
			return;
		}
		this.pushAgentFrame(packet, level);
	}

	/** The packet's RFC 6464 level, 'invalid' when it does not decode, or undefined before the decoder is ready. */
	private measureAgentPacket(packet: Uint8Array): number | 'invalid' | undefined {
		if (!this.levelDecoderReady || !this.levelDecoder) {
			return undefined;
		}
		try {
			const decoded = this.levelDecoder.decodeFrame(packet);
			return decoded.errors.length === 0 && decoded.audioData.length > 0 ? computeAudioLevel(decoded.audioData) : 'invalid';
		} catch {
			return 'invalid';
		}
	}

	/** Queues a frame for pacing, dropping it when the agent has sent far more than real time. */
	private pushAgentFrame(payload: Uint8Array, audioLevel?: number): void {
		if (this.pacer.queuedFrames >= MAX_QUEUED_AGENT_FRAMES) {
			if (!this.warnedPacerFull) {
				this.warnedPacerFull = true;
				this.runtime.logger.warn(`agent: more than ${MAX_QUEUED_AGENT_FRAMES} frames queued; dropping agent audio`);
			}
			return;
		}
		this.pacer.push(payload, audioLevel);
	}

	/** The agent broke the media contract: tell it why and end the session; a redial would only repeat it. */
	private failAgent(reason: string): void {
		if (this.isClosed) {
			return;
		}
		this.runtime.logger.warn(`agent: ${reason}`);
		this.endpointClose = { code: CLOSE_CODE_POLICY_VIOLATION, reason: closeReason(reason) };
		this.endpointStatus = 'failed';
		this.close(CLOSE_CODE_ENDPOINT_UNREACHABLE, closeReason(reason));
		this.reportTerminal('failed', reason);
	}

	/** Called by the pacer as each frame becomes due: stamp RTP timing and emit toward the bridge. */
	private sendAgentFrame(payload: Uint8Array, audioLevel?: number): void {
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
			audioLevel,
			// Every queued frame passed a DTX check, so it is voice.
			vad: true,
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
