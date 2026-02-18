import { OutgoingConnection } from './OutgoingConnection';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { config, type Provider } from './config';
import type { AudioEncoding } from './utils';
import * as fs from 'fs';
import logger from './logger';
import { DispatcherConnection, type DispatcherMessage } from './dispatcher';
import { getInstruments } from './telemetry/instruments';
import { parse } from 'node:path';

export interface TranscriptionMessage {
	transcript: Array<{ confidence?: number; text: string }>;
	is_interim: boolean;
	language?: string;
	message_id: string;
	type: 'transcription-result';
	event: 'transcription-result';
	participant: { id: string; ssrc?: string };
	timestamp: number;
}

export interface TranscriberProxyOptions {
	language: string | null;
	sessionId?: string;
	provider?: Provider;
	encoding?: AudioEncoding;
	sendBack?: boolean;
	sendBackInterim?: boolean;
	tags?: string[];
}

export class TranscriberProxy extends EventEmitter {
	private ws: WebSocket;
	private outgoingConnections: Map<string, OutgoingConnection>;
	private options: TranscriberProxyOptions;
	private dumpStream?: fs.WriteStream;
	private transcriptDumpStream?: fs.WriteStream;
	private sessionId?: string;
	private dispatcherConnection?: DispatcherConnection;
	private createdAt: number;

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
			}
		});
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

	private getConnection(tag: string): OutgoingConnection | null {
		// Check if connection already exists for this tag
		const connection = this.outgoingConnections.get(tag);
		if (connection !== undefined) {
			return connection;
		}
		logger.error(`No existing connection found for tag: ${tag}`);
		return null;
	}

	private createConnection(tag: string, mediaFormat?: any): OutgoingConnection {
		// Create a new connection for this tag (no limit, no reuse)
		const newConnection = new OutgoingConnection(tag, mediaFormat, this.options);

		newConnection.onInterimTranscription = (message) => {
			this.emit('interim_transcription', message);
		};
		newConnection.onCompleteTranscription = (message) => {
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

	handleStartEvent(parsedMessage: any): void {
		const tag = parsedMessage.start?.tag;
		logger.info(`Received start event: ${JSON.stringify(parsedMessage)}`);
		if (tag) {
			const mediaFormat = parsedMessage.start.mediaFormat;
			const connection = this.getConnection(tag);
			if (connection) {
				connection.updateInputFormat(mediaFormat);
			} else {
				this.createConnection(tag, mediaFormat);
			}
		}
	}

	handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (tag) {
			const connection = this.getConnection(tag);
			if (connection) {
				connection.handleMediaEvent(parsedMessage);
			}
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
