import { OutgoingConnection } from './OutgoingConnection';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { config, type Provider } from './config';
import type { AudioEncoding } from './utils';
import * as fs from 'fs';
import logger from './logger';
import { DispatcherConnection, type DispatcherMessage } from './dispatcher';
import { buildDispatcherMessages } from './identity/dispatcherMessages';
import type { AttributedSegment } from './identity/types';
import { validateAudioFormat, type AudioFormat } from './AudioFormat';
import { getInstruments } from './telemetry/instruments';
import { buildServerInfo } from './serverInfo';

export interface TranscriptionMessage {
	transcript: Array<{ confidence?: number; text: string }>;
	is_interim: boolean;
	language?: string;
	message_id: string;
	type: 'transcription-result';
	event: 'transcription-result';
	participant: { id: string; tag?: string; name?: string };
	timestamp: number;
	speaker?: number;
	/** Per-word media-time offsets (seconds), when the backend provides them (xAI). Used for speaker attribution.
	 *  `speaker` is the backend diarization label when the backend diarizes (xAI/Deepgram). */
	words?: Array<{ text: string; start: number; end: number; speaker?: number }>;
	/**
	 * When true, this final is for live display only and must NOT be forwarded to the dispatcher/store.
	 * Set on the raw (mic-owner-attributed) final while identity is enabled: the per-speaker identity
	 * follow-up is the authoritative store attribution, so dispatching the raw too would mis-attribute a
	 * shared-mic speaker's words to the mic owner (JIT-16065).
	 */
	noDispatch?: boolean;
	/**
	 * When true, this final is for the STORE only and must NOT be shown in the live CC. Set on the
	 * per-speaker identity-attributed finals: the identified speaker isn't in the XMPP room, so the
	 * client would render it as "Guest" and duplicate the raw line. Keeping it out of the UI leaves the
	 * live CC identical to pre-identity behaviour; the attribution still reaches the stored transcript
	 * via the Worker's dispatch path (JIT-16065).
	 */
	dispatchOnly?: boolean;
	/**
	 * When true, a sibling final in the same diarized turn carries this turn's full per-word list and
	 * runs identity attribution over the whole window, so this (secondary per-speaker) final's content
	 * is already stored via that sibling. Skip its store-attribution to avoid duplicating speakers'
	 * words; the raw final is still shown live (noDispatch). Set on xAI diarized finals #2..N (JIT-16065).
	 */
	attributionDeferred?: boolean;
}

export interface TranscriberProxyOptions {
	language?: string;
	sessionId?: string;
	provider?: Provider;
	encoding?: AudioEncoding;
	sendBack?: boolean;
	sendBackInterim?: boolean;
	tags?: string[];
	openaiCustomUrl?: string;
	openaiCustomApiKey?: string;
	deepgramMipOptOut?: boolean;
	/** Per-connection xAI segmentation overrides (undefined = use config). */
	xaiEndpointing?: number;
	xaiSmartTurn?: number;
	xaiSmartTurnTimeout?: number;
	/** Per-connection xAI roll-own granular finalization overrides (undefined = use config). */
	xaiGranularFinals?: boolean;
	xaiGranularStabilityMs?: number;
	xaiGranularGuardWords?: number;
}

export class TranscriberProxy extends EventEmitter {
	private ws: WebSocket;
	private outgoingConnections: Map<string, OutgoingConnection>;
	private failedStartTags: Set<string> = new Set();
	private options: TranscriberProxyOptions;
	private dumpStream?: fs.WriteStream;
	private transcriptDumpStream?: fs.WriteStream;
	private sessionId?: string;
	private dispatcherConnection?: DispatcherConnection;
	private createdAt: number;
	private audioPacketCount = 0;
	private interimTranscriptionCount = 0;
	private finalTranscriptionCount = 0;
	private firstFrameLoggedTags = new Set<string>();

	constructor(ws: WebSocket, options: TranscriberProxyOptions) {
		super({ captureRejections: true });
		this.ws = ws;
		this.options = options;
		this.sessionId = options.sessionId;
		this.outgoingConnections = new Map<string, OutgoingConnection>();
		this.createdAt = Date.now();

		// Log session tags if provided
		if (options.tags && options.tags.length > 0) {
			logger.info(`Session ${this.sessionId} started with tags: ${options.tags.join(', ')}`);
		}

		// Initialize dump streams if enabled
		if (config.dumpWebSocketMessages || config.dumpTranscripts) {
			this.initializeDumpStreams();
		}

		// Initialize dispatcher connection if configured
		if (config.dispatcher.wsUrl && this.sessionId) {
			this.dispatcherConnection = new DispatcherConnection(this.sessionId);
			this.dispatcherConnection.connect().catch((error) => {
				logger.error(`Failed to connect to dispatcher for session ${this.sessionId}:`, error.message);
			});
		}

		// Set up WebSocket event listeners
		this.setupWebSocketListeners();
	}

	/**
	 * Set up WebSocket event listeners
	 * Can be called during construction or when reattaching a new WebSocket
	 */
	private setupWebSocketListeners(): void {
		this.ws.addEventListener('close', () => {
			this.ws.close();
			this.emit('closed');
		});

		this.ws.addEventListener('message', async (event) => {
			// Dump raw message if enabled
			if (this.dumpStream) {
				try {
					const dumpEntry = {
						timestamp: Date.now(),
						direction: 'incoming',
						data: event.data,
					};
					this.dumpStream.write(JSON.stringify(dumpEntry) + '\n');
				} catch (error) {
					logger.error('Failed to dump WebSocket message:', error);
				}
			}

			let parsedMessage;
			try {
				parsedMessage = JSON.parse(event.data as string);
			} catch (parseError) {
				logger.error('Failed to parse message as JSON:', parseError);
				parsedMessage = { raw: event.data, parseError: true };
			}

			if (parsedMessage && parsedMessage.event === 'ping') {
				const pongMessage: { event: string; id?: number } = { event: 'pong' };
				if (typeof parsedMessage.id === 'number') {
					pongMessage.id = parsedMessage.id;
				}
				this.ws.send(JSON.stringify(pongMessage));
			} else if (parsedMessage && parsedMessage.event === 'start') {
				this.handleStartEvent(parsedMessage);
			} else if (parsedMessage && parsedMessage.event === 'media') {
				this.handleMediaEvent(parsedMessage);
			} else if (parsedMessage && parsedMessage.event === 'info') {
				// Informational message from the client (e.g. JVB application/version). Log it for
				// runtime observability; no behavioural effect.
				logger.info(`Received info from client for session ${this.sessionId}: ${JSON.stringify(parsedMessage)}`);
			}
		});

		// Announce ourselves to the client (build/config/deployment details) now that the
		// connection is up. Called on both initial connect and reattach.
		this.sendServerInfo();
	}

	/**
	 * Send the server `info` message to the connected client. Carries git hash, effective provider,
	 * high-level config and deployment details for runtime observability.
	 */
	private sendServerInfo(): void {
		if (this.ws.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			const info = buildServerInfo({ sessionId: this.sessionId, provider: this.options.provider });
			logger.info(`Sending server info for session ${this.sessionId}: ${JSON.stringify(info)}`);
			this.ws.send(JSON.stringify(info));
		} catch (error) {
			logger.error('Failed to send server info:', error);
		}
	}

	private initializeDumpStreams(): void {
		// Create session directory if we have a sessionId
		const sessionDir = this.sessionId ? `${config.dumpBasePath}/${this.sessionId}` : config.dumpBasePath;

		try {
			// Create directory if it doesn't exist
			if (this.sessionId && !fs.existsSync(sessionDir)) {
				fs.mkdirSync(sessionDir, { recursive: true });
				logger.info(`Created dump directory: ${sessionDir}`);
			}

			// Initialize WebSocket message dump stream
			if (config.dumpWebSocketMessages) {
				const wsMessagePath = `${sessionDir}/media.jsonl`;
				this.dumpStream = fs.createWriteStream(wsMessagePath, { flags: 'a' });
				logger.info(`WebSocket message dump enabled: ${wsMessagePath}`);
			}

			// Initialize transcript dump stream
			if (config.dumpTranscripts) {
				const transcriptPath = `${sessionDir}/transcript.jsonl`;
				this.transcriptDumpStream = fs.createWriteStream(transcriptPath, { flags: 'a' });
				logger.info(`Transcript dump enabled: ${transcriptPath}`);
			}
		} catch (error) {
			logger.error(`Failed to initialize dump streams:`, error);
		}
	}

	private getConnection(tag: string): OutgoingConnection | undefined {
		return this.outgoingConnections.get(tag);
	}

	private createConnection(tag: string, mediaFormat: AudioFormat, diarize?: boolean): OutgoingConnection {
		// Create a new connection for this tag (no limit, no reuse).
		// `diarize` is a per-endpoint override from the start event (undefined = use
		// the global DEEPGRAM_DIARIZE / XAI_DIARIZE config).
		const newConnection = new OutgoingConnection(tag, mediaFormat, this.options, diarize);

		newConnection.onInterimTranscription = (message) => {
			this.interimTranscriptionCount++;
			this.emit('interim_transcription', message);
		};
		newConnection.onCompleteTranscription = (message) => {
			this.finalTranscriptionCount++;
			// Dump transcript if enabled
			if (this.transcriptDumpStream) {
				try {
					const dumpEntry = {
						timestamp: Date.now(),
						message: message,
					};
					this.transcriptDumpStream.write(JSON.stringify(dumpEntry) + '\n');
				} catch (error) {
					logger.error('Failed to dump transcript:', error);
				}
			}

			const identityEnabled = config.identity?.enabled === true;

			// While identity is enabled, the raw (mic-owner) final is for live display only — the
			// per-speaker identity follow-up below is the authoritative store attribution. Flag it so the
			// Worker forwards it to the client but NOT to the dispatcher (otherwise a shared-mic speaker's
			// words get stored under the mic owner). JIT-16065.
			if (identityEnabled) message.noDispatch = true;

			// Emit the transcription event for external listeners
			this.emit('transcription', message);

			const transcriptText = message.transcript.map((t) => t.text).join(' ');
			const sourceTag = message.participant?.id || tag;

			// Send to dispatcher immediately — UNLESS identity is enabled, in which case the
			// dispatcher send is deferred to the attribution result below (per-speaker + identity).
			if (this.dispatcherConnection && this.sessionId && !identityEnabled) {
				const dispatcherMessage: DispatcherMessage = {
					sessionId: this.sessionId,
					endpointId: message.participant?.id || tag,
					text: transcriptText,
					timestamp: message.timestamp,
					language: message.language,
				};
				this.dispatcherConnection.send(dispatcherMessage);
			}

			// Broadcast this transcript to all OTHER tags in the same session
			if (transcriptText.trim()) {
				this.broadcastTranscriptToOtherTags(sourceTag, transcriptText);
			}

			// Speaker-identity attribution: async, off the hot path. Emits a reconcile event and,
			// when identity is enabled + the dispatcher is connected, sends per-speaker messages with
			// a resolved-identity override (falling back to the plain transcript when nothing
			// resolved). Any failure is swallowed — transcription is never affected. Gated by
			// IDENTITY_ENABLED.
			// Secondary per-speaker finals of a diarized turn: their content is already attributed +
			// stored by the sibling final that carries the turn's full words, so running attribution here
			// too would store those speakers' words twice. The raw final is still shown live (noDispatch).
			if (identityEnabled && !message.attributionDeferred) {
				// Fallback text under the mic owner — used when attribution can't run (no words / non-16k
				// backend / error) so the store never loses the utterance. On the FIRST diarized final the
				// message carries the whole turn's `words` (all speakers) but its own `transcript` is just
				// the first speaker's text; the other speakers' finals are attributionDeferred (skipped
				// here). So reconstruct the whole-turn text from `words` when present — otherwise a failed
				// attribution on that final would drop speakers #2..N from the store entirely. JIT-16065.
				const fallbackText = message.words?.length ? message.words.map((w) => w.text).join(' ') : transcriptText;
				// A single fallback segment carrying that text. This identity_attribution (not the
				// noDispatch'd raw) is what the Worker forwards to the store.
				const fallbackSegment = (): AttributedSegment[] => [
					{ sessionSpeakerId: null, handle: null, identity: null, name: null, score: 0, text: fallbackText, start: 0, end: 0 },
				];
				const emitAttribution = (segments: AttributedSegment[]) => {
					this.emit('identity_attribution', {
						sessionId: this.sessionId,
						tag,
						participantId: message.participant?.id || tag,
						messageId: message.message_id,
						timestamp: message.timestamp,
						language: message.language,
						segments,
					});
				};
				// `handled` scopes the .catch to a rejection of identityAttributeFinal itself. Without it,
				// a throw INSIDE the .then (an 'identity_attribution' listener, or dispatcherConnection.send)
				// would fall through to .catch and emit the fallback a SECOND time — double-storing the turn.
				let handled = false;
				newConnection
					.identityAttributeFinal(message)
					.then((segments) => {
						handled = true;
						const effective = segments && segments.length > 0 ? segments : fallbackSegment();
						emitAttribution(effective);
						if (segments && segments.length > 0) {
							// debug, not info: this line carries transcript content + resolved speaker names
							// (PII). All other transcript logging is debug too; don't stream it to Loki at info.
							logger.debug(
								`[identity] ${tag}: ${segments
									.map((s) => `${s.name ?? s.identity ?? s.handle ?? '?'}="${s.text}"`)
									.join(' | ')}`,
							);
						}
						// Standalone-Node dispatcher path (unused under the CF Worker, which re-dispatches
						// the client-bound messages). buildDispatcherMessages already handles null → raw.
						if (this.dispatcherConnection && this.sessionId) {
							const base = {
								sessionId: this.sessionId,
								endpointId: message.participant?.id || tag,
								timestamp: message.timestamp,
								language: message.language,
							};
							for (const dm of buildDispatcherMessages(base, fallbackText, segments)) {
								this.dispatcherConnection.send(dm);
							}
						}
					})
					.catch(() => {
						if (!handled) emitAttribution(fallbackSegment());
					});
			}
		};
		newConnection.onClosed = (tag) => {
			this.outgoingConnections.delete(tag);
			// Metrics: decrement participant count
			getInstruments().participantsActive.add(-1);
		};
		newConnection.onError = (tag, error) => {
			this.emit('error', tag, error);
		};

		this.outgoingConnections.set(tag, newConnection);

		// Metrics: increment participant count
		getInstruments().participantsActive.add(1);

		logger.info(`Created outgoing connection for tag: ${tag} (total connections: ${this.outgoingConnections.size})`);
		return newConnection;
	}

	// Public for unit-test access; not intended as part of the public API.
	handleStartEvent(parsedMessage: any): void {
		const tag = parsedMessage.start?.tag;
		logger.debug(`Received start event: ${JSON.stringify(parsedMessage)}`);
		if (!tag) {
			logger.error(`Received start event with no tag: ${JSON.stringify(parsedMessage)}`);
			return;
		}

		let mediaFormat: AudioFormat;
		try {
			mediaFormat = validateAudioFormat(parsedMessage.start?.mediaFormat);
		} catch (error) {
			logger.error(`Invalid mediaFormat in start event for tag "${tag}": ${error instanceof Error ? error.message : String(error)}`);
			this.failedStartTags.add(tag);
			return;
		}

		this.failedStartTags.delete(tag);

		// Per-endpoint diarization flag. The bridge sets `start.diarize: true` only for
		// endpoints that carry multiple speakers (room systems, dial-in legs). Only an
		// explicit boolean overrides the global config; anything else falls back to it.
		const diarize = typeof parsedMessage.start?.diarize === 'boolean' ? parsedMessage.start.diarize : undefined;

		// If the start event says 'opus' but the URL parameter says 'ogg-opus', the
		// stream is containerised Ogg-Opus.  Some clients send a generic 'opus'
		// encoding in the start event without specifying the framing; the URL parameter
		// is the authoritative source for the container format.
		if (mediaFormat.encoding === 'opus' && this.options.encoding === 'ogg-opus') {
			mediaFormat = { ...mediaFormat, encoding: 'ogg' };
			logger.debug(`Tag "${tag}": promoted encoding from 'opus' to 'ogg' (URL parameter encoding=ogg-opus)`);
		}

		const connection = this.getConnection(tag);
		if (connection) {
			// A re-start updates the media format and may also change the per-endpoint
			// diarize flag; updateInputFormat applies the new diarize (reconnecting the
			// backend if it changed).
			connection.updateInputFormat(mediaFormat, diarize);
		} else {
			this.createConnection(tag, mediaFormat, diarize);
		}
	}

	// Public for unit-test access; not intended as part of the public API.
	handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (tag) {
			let connection = this.getConnection(tag);
			if (!connection) {
				if (this.failedStartTags.has(tag)) {
					logger.debug(`Dropping media event for tag "${tag}": start event was rejected`);
					return;
				}
				const encoding = this.options.encoding ?? 'opus';
				// channels: 2 reflects SDP negotiation: Opus is always offered as stereo in
				// SDP for compatibility, even when the actual content is mono.  The decoder
				// produces mono output regardless.
				const mediaFormat: AudioFormat = encoding === 'opus'
					? { encoding: 'opus', sampleRate: 48000, channels: 2 }
					: { encoding: 'ogg' };
				logger.warn(`Received media event for tag "${tag}" with no prior start event; creating connection with encoding "${encoding}"`);
				connection = this.createConnection(tag, mediaFormat);
			}
			const payloadB64 = parsedMessage.media?.payload;
			const hasAudio = typeof payloadB64 === 'string' && payloadB64.length > 0;
			if (hasAudio) {
				this.audioPacketCount++;
				if (!this.firstFrameLoggedTags.has(tag)) {
					// 64 base64 chars decode to at most 48 bytes; we only emit the first 16.
					const head = Buffer.from(payloadB64.slice(0, 64), 'base64');
					const headByteCount = Math.min(16, head.length);
					const headHex = head.subarray(0, headByteCount).toString('hex');
					const mediaSnapshot = { ...parsedMessage.media, payload: `<b64:${payloadB64.length} chars, first ${headByteCount} decoded bytes=${headHex}>` };
					// JSON-valued fields are quoted so that downstream logfmt-style parsers
					// don't misinterpret spaces inside the JSON payload (e.g. inside `tag`).
					logger.info(
						`First client frame sniff: sessionId=${this.sessionId} tag=${tag} provider=${this.options.provider ?? 'default'} urlEncoding=${this.options.encoding ?? 'opus'} startFormat='${JSON.stringify(connection.getInputFormat())}' media='${JSON.stringify(mediaSnapshot)}'`,
					);
					this.firstFrameLoggedTags.add(tag);
				}
			}
			connection.handleMediaEvent(parsedMessage);
		}
	}

	/**
	 * Broadcast a transcript from one tag to all other tags in the same session
	 * This allows participants to see what others are saying as context in their OpenAI session
	 * @param sourceTag - The participant ID who said this
	 * @param transcriptText - The text that was transcribed
	 */
	private broadcastTranscriptToOtherTags(sourceTag: string, transcriptText: string): void {
		// Check if transcript broadcasting is enabled
		if (!config.broadcastTranscripts) {
			return;
		}

		const contextMessage = `${sourceTag}: ${transcriptText}`;
		let broadcastCount = 0;

		this.outgoingConnections.forEach((connection, tag) => {
			// Don't inject context back to the same participant who said it
			// Compare using participantId, not the connection tag
			if (connection.participantId !== sourceTag) {
				connection.addTranscriptContext(contextMessage);
				broadcastCount++;
			}
		});

		if (broadcastCount > 0) {
			logger.debug(`Broadcasted "${contextMessage}" to ${broadcastCount} other tag(s) in the same session`);
		}
	}

	/**
	 * Get the current WebSocket connection
	 */
	getWebSocket(): WebSocket {
		return this.ws;
	}

	/**
	 * Get session options
	 */
	getOptions(): TranscriberProxyOptions {
		return this.options;
	}

	/**
	 * Get session duration in seconds
	 */
	getSessionDurationSec(): number {
		return (Date.now() - this.createdAt) / 1000;
	}

	/**
	 * Reattach this session to a new WebSocket connection
	 * Used for session resumption after temporary disconnection
	 */
	reattachWebSocket(newWs: WebSocket): void {
		logger.info(`Reattaching WebSocket to session ${this.sessionId}`);

		// Close old WebSocket (may already be closed)
		try {
			this.ws.close();
		} catch (e) {
			// Ignore - WebSocket might already be closed
			logger.debug('Old WebSocket already closed during reattach');
		}

		// Update reference
		this.ws = newWs;

		// Re-setup listeners on new WebSocket
		this.setupWebSocketListeners();

		// Treat a reattach as a new connection for diagnostic purposes: the client
		// may negotiate a different audio format on reconnect, so fire the
		// first-frame sniff again on the first real audio packet per tag.
		this.firstFrameLoggedTags.clear();

		// Reset chunk tracking on all connections so frames from the new client
		// aren't discarded as "reordered" (chunk numbers restart from 0)
		this.outgoingConnections.forEach((connection, tag) => {
			connection.resetChunkTracking();
		});

		logger.info(
			`WebSocket reattached to session ${this.sessionId}, ${this.outgoingConnections.size} active connections preserved`,
		);
	}

	close(): void {
		logger.info(
			`Session ended: sessionId=${this.sessionId} provider=${this.options.provider ?? 'default'} audioPackets=${this.audioPacketCount} interims=${this.interimTranscriptionCount} finals=${this.finalTranscriptionCount} durationSec=${this.getSessionDurationSec().toFixed(1)}`,
		);
		this.outgoingConnections.forEach((connection) => {
			connection.close();
		});
		this.outgoingConnections.clear();
		this.ws.close();

		// Close dispatcher connection if open
		if (this.dispatcherConnection) {
			this.dispatcherConnection.close();
			this.dispatcherConnection = undefined;
		}

		// Close dump streams if open
		if (this.dumpStream) {
			this.dumpStream.end();
			this.dumpStream = undefined;
		}
		if (this.transcriptDumpStream) {
			this.transcriptDumpStream.end();
			this.transcriptDumpStream = undefined;
		}

		this.emit('closed');
	}
}
