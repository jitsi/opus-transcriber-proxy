import { OutgoingConnection } from './OutgoingConnection';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { config, type Provider } from './config';
import type { AudioEncoding } from './utils';
import * as fs from 'fs';
import logger from './logger';
import { DispatcherConnection, type DispatcherMessage } from './dispatcher';
import { validateAudioFormat, type AudioFormat } from './AudioFormat';
import { getInstruments } from './telemetry/instruments';
import { buildServerInfo } from './serverInfo';
import { isValidTargetLanguage, needsTranslation, type TextTranslationRequest, type TextTranslator, type TranslationTurn } from './textTranslate/TextTranslator';
import {
	createTextTranslator,
	getDefaultTextTranslationProvider,
	isTextTranslationProviderAvailable,
	isValidTextTranslationProvider,
	usesConversationContext,
	type TextTranslationProvider,
} from './textTranslate/factory';
import { buildTextTranslationMessage, transcriptionText } from './textTranslate/messages';
import { ConversationHistory } from './textTranslate/ConversationHistory';

export interface TranscriptionMessage {
	transcript: Array<{ confidence?: number; text: string }>;
	is_interim: boolean;
	language?: string;
	message_id: string;
	type: 'transcription-result';
	event: 'transcription-result';
	participant: { id: string; tag?: string };
	timestamp: number;
	speaker?: number;
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
	/** Per-connection text-translation provider override (undefined = the configured default). */
	textTranslationProvider?: TextTranslationProvider;
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

	/**
	 * Target languages for text translation, from the most recent `sources` control event. The
	 * event carries the authoritative full set, so this is replaced wholesale on each one. Empty
	 * (the default) means no translation is requested.
	 */
	private targetLanguages: string[] = [];

	/** Created on the first requested language, so a session that never requests one costs nothing. */
	private textTranslator?: TextTranslator;
	/** The provider `textTranslator` was created for; also decides whether it gets context. */
	private textTranslationProvider?: TextTranslationProvider;
	private translationCount = 0;

	/**
	 * Recent finals of this session, passed to the translator as context.
	 *
	 * Filled for every final while text translation is enabled — not only while a language is
	 * requested — so that a participant who turns subtitles on mid-meeting gets context-aware
	 * translations from their first transcript.
	 */
	private readonly conversationHistory = new ConversationHistory({
		maxTurns: config.textTranslation.historyTurns,
		maxChars: config.textTranslation.historyMaxChars,
		includeSpeakers: config.textTranslation.includeSpeakers,
	});

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
			} else if (parsedMessage && parsedMessage.event === 'sources') {
				this.handleSourcesEvent(parsedMessage);
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

	private createConnection(tag: string, mediaFormat: AudioFormat): OutgoingConnection {
		// Create a new connection for this tag (no limit, no reuse)
		const newConnection = new OutgoingConnection(tag, mediaFormat, this.options);

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

			// Emit the transcription event for external listeners
			this.emit('transcription', message);

			// Fan out text translations of this final. Asynchronous: each translation is emitted as a
			// separate 'translation' event when it completes, after the original above.
			this.translateTranscription(message);

			// Send to dispatcher if connected
			if (this.dispatcherConnection && this.sessionId) {
				const transcriptText = message.transcript.map((t) => t.text).join(' ');
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
			const sourceTag = message.participant?.id || tag;
			const transcriptText = message.transcript.map((t) => t.text).join(' ');

			if (transcriptText.trim()) {
				this.broadcastTranscriptToOtherTags(sourceTag, transcriptText);
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
			connection.updateInputFormat(mediaFormat);
		} else {
			this.createConnection(tag, mediaFormat);
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
	 * Handle the `sources` control event from the bridge.
	 *
	 * On a `transcriber` connect the bridge sends the conference's aggregated text-translation
	 * target languages as bare language codes in `requests` — jicofo puts them on the colibri2
	 * `<connect>`'s `<requests>` list and the bridge forwards them verbatim. (On a `translator`
	 * connect the same field carries `<source>.<language>` synthetic source names instead; the two
	 * are told apart by the connect type, i.e. by which endpoint the socket is on.)
	 *
	 * `requests` is the authoritative full set, so it replaces the current one: an event with an
	 * empty list stops all translation.
	 */
	// Public for unit-test access; not intended as part of the public API.
	handleSourcesEvent(parsedMessage: any): void {
		const requests: unknown = parsedMessage?.requests;
		const requested: string[] = Array.isArray(requests) ? requests : [];

		const languages: string[] = [];
		for (const language of requested) {
			if (!isValidTargetLanguage(language)) {
				logger.warn(`Ignoring invalid text translation language in sources event: ${JSON.stringify(language)}`);
				continue;
			}
			if (!languages.includes(language)) {
				languages.push(language);
			}
		}

		if (languages.length > 0 && !config.textTranslation.enabled) {
			logger.warn(
				`Session ${this.sessionId}: ignoring requested text translation languages [${languages.join(', ')}] — text translation is disabled (set ENABLE_TEXT_TRANSLATION=true)`,
			);
			this.targetLanguages = [];
			return;
		}

		if (languages.length > 0 && !this.textTranslator) {
			// The connection's own provider when it asked for one (already validated in server.ts),
			// otherwise the first available entry of TEXT_TRANSLATION_PROVIDERS_PRIORITY.
			const provider = this.options.textTranslationProvider ?? getDefaultTextTranslationProvider();
			if (!provider || !isValidTextTranslationProvider(provider) || !isTextTranslationProviderAvailable(provider)) {
				logger.error(
					`Session ${this.sessionId}: cannot translate into [${languages.join(', ')}] — no text translation provider is available (checked TEXT_TRANSLATION_PROVIDERS_PRIORITY=${config.textTranslation.providersPriority.join(',')}); set an API key for one of them`,
				);
				this.targetLanguages = [];
				return;
			}
			this.textTranslator = createTextTranslator(provider);
			this.textTranslationProvider = provider;
			logger.info(
				`Session ${this.sessionId}: created "${provider}" text translator (context: ${usesConversationContext(provider) ? `${config.textTranslation.historyTurns} turns, speakers ${config.textTranslation.includeSpeakers ? 'on' : 'off'}` : 'not supported by this provider'})`,
			);
		}

		if (languages.join(',') === this.targetLanguages.join(',')) {
			return;
		}
		logger.info(
			`Session ${this.sessionId}: text translation languages [${this.targetLanguages.join(', ')}] -> [${languages.join(', ')}]`,
		);
		this.targetLanguages = languages;
	}

	/**
	 * Translate a final transcript into every requested target language and emit one `translation`
	 * event per language.
	 *
	 * Only finals are translated: the client treats a `translation-result` as final and has no
	 * interim handling for it, and translating every interim would multiply provider cost for text
	 * that is about to be revised.
	 *
	 * Translation is asynchronous and deliberately not awaited by the caller, so a slow translation
	 * never delays the original transcript. A translation that arrives after a later transcript is
	 * still rendered correctly: the client keys on `message_id`, not arrival order.
	 *
	 * Every requested language gets its own request, all sharing one history snapshot, and the turn
	 * is appended to the history afterwards — a turn is not its own context.
	 */
	private translateTranscription(message: TranscriptionMessage): void {
		const text = transcriptionText(message);
		if (!text || !config.textTranslation.enabled) {
			return;
		}

		// Undefined when speaker labels are disabled, in which case nothing about who spoke is built
		// or sent at all.
		const speaker = this.conversationHistory.speakerLabel(message.participant?.id ?? '');
		const turn: TranslationTurn = {
			...(speaker && { speaker }),
			text,
			...(message.language && { language: message.language }),
		};
		// Snapshot before recording this turn, and share it across the languages below: the
		// translations complete out of order, and all of them describe the same point in the
		// conversation.
		const history = this.textTranslationProvider && usesConversationContext(this.textTranslationProvider)
			? this.conversationHistory.snapshot()
			: [];
		// Record every final, even when no language is requested and even for a turn skipped below:
		// it is still context for the turns that follow.
		this.conversationHistory.add(turn);

		const translator = this.textTranslator;
		if (!translator || this.targetLanguages.length === 0) {
			return;
		}

		// Snapshot the languages: the set can change while the translations are in flight, and a
		// translation must be emitted for the language it was requested for.
		for (const language of [...this.targetLanguages]) {
			if (!needsTranslation(language, message.language)) {
				logger.debug(
					`Session ${this.sessionId}: skipping ${language} translation, transcript is already in ${message.language}`,
				);
				continue;
			}
			const request: TextTranslationRequest = { turn, targetLanguage: language, history };
			translator
				.translate(request)
				.then((translated) => {
					if (!translated) {
						return;
					}
					this.translationCount++;
					this.emit('translation', buildTextTranslationMessage(message, language, translated));
				})
				.catch((error) => {
					// A failed translation drops that language for this transcript only; the original
					// transcript has already been delivered. The reason is interpolated rather than
					// passed as a second argument, which the log format drops — and the reason (a
					// provider quota, a dead model, a timeout) is the whole value of this line.
					logger.error(
						`Session ${this.sessionId}: failed to translate transcript into ${language}: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
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
			`Session ended: sessionId=${this.sessionId} provider=${this.options.provider ?? 'default'} audioPackets=${this.audioPacketCount} interims=${this.interimTranscriptionCount} finals=${this.finalTranscriptionCount} translations=${this.translationCount} durationSec=${this.getSessionDurationSec().toFixed(1)}`,
		);

		this.textTranslator?.close?.();
		this.textTranslator = undefined;
		this.textTranslationProvider = undefined;
		this.targetLanguages = [];
		this.conversationHistory.clear();
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
