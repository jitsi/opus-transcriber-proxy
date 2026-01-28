import { OutgoingConnection } from './OutgoingConnection';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { config, type Provider } from './config';
import * as fs from 'fs';
import logger from './logger';
import { SessionStats } from './SessionStats';

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
}

export class TranscriberProxy extends EventEmitter {
	private readonly ws: WebSocket;
	private outgoingConnections: Map<string, OutgoingConnection>;
	private options: TranscriberProxyOptions;
	private dumpStream?: fs.WriteStream;
	private transcriptDumpStream?: fs.WriteStream;
	private sessionId?: string;
	private stats?: SessionStats; // Session statistics tracker

	constructor(ws: WebSocket, options: TranscriberProxyOptions) {
		super({ captureRejections: true });
		this.ws = ws;
		this.options = options;
		this.sessionId = options.sessionId;
		this.outgoingConnections = new Map<string, OutgoingConnection>();

		// set up stats tracking if it's turned on
		if (config.enableSessionStats && this.sessionId) {
			this.stats = new SessionStats(this.sessionId, options.provider || 'default');
			logger.debug(`Session stats enabled for session: ${this.sessionId}`);
		}

		// Initialize dump streams if enabled
		if (config.dumpWebSocketMessages || config.dumpTranscripts) {
			this.initializeDumpStreams();
		}

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

	private getConnection(tag: string): OutgoingConnection {
		// Check if connection already exists for this tag
		const connection = this.outgoingConnections.get(tag);
		if (connection !== undefined) {
			return connection;
		}

		// Create a new connection for this tag (no limit, no reuse)
		const newConnection = new OutgoingConnection(tag, this.options);

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

			// Broadcast this transcript to all OTHER tags in the same session
			const sourceTag = message.participant?.id || tag;
			const transcriptText = message.transcript.map((t) => t.text).join(' ');

			if (transcriptText.trim()) {
				this.broadcastTranscriptToOtherTags(sourceTag, transcriptText);
			}
		};
		newConnection.onClosed = (tag) => {
			this.outgoingConnections.delete(tag);
			this.stats?.setActiveConnections(this.outgoingConnections.size);
		};
		newConnection.onError = (tag, error) => {
			this.stats?.incrementConnectionErrors();
			this.emit('error', tag, error);
		};


		// hook up stats callbacks
		if (this.stats) {
			newConnection.onPacketReceived = () => this.stats!.incrementPacketsReceived();
			newConnection.onPacketDecoded = () => this.stats!.incrementPacketsDecoded();
			newConnection.onPacketLost = (count) => this.stats!.incrementPacketsLost(count);
			newConnection.onDecodeError = () => this.stats!.incrementDecodeErrors();
		}

		this.outgoingConnections.set(tag, newConnection);
		this.stats?.setActiveConnections(this.outgoingConnections.size);
		logger.info(`Created outgoing connection for tag: ${tag} (total connections: ${this.outgoingConnections.size})`);
		return newConnection;
	}

	handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (tag) {
			const connection = this.getConnection(tag);
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

	close(): void {
		this.outgoingConnections.forEach((connection) => {
			connection.close();
		});
		this.outgoingConnections.clear();
		this.ws.close();

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

	// get stats for this session
	getStats(): SessionStats | undefined {
		return this.stats;
	}
}
