import { TranslatorConnection, normalizeTargetLanguage } from './TranslatorConnection';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import logger from './logger';

export interface TranslatorProxyOptions {
	/**
	 * Target languages active when the connection opens. Seeded from the URL
	 * (`?lang=en` or `?lang=en,de`) for simple/dev clients (e.g. the replay tool).
	 * May be empty when the client drives languages dynamically via
	 * `start-translation` / `stop-translation` control frames (e.g. JVB).
	 */
	initialLanguages?: string[];
	provider?: string;
}

/**
 * Bridges a single export WebSocket (the bridge's dedicated translation socket)
 * to one or more OpenAI translation sessions. One {@link TranslatorConnection}
 * is maintained per (speaker tag, target language) pair, so a speaker can be
 * translated into multiple languages over the same socket and the cost scales
 * with (speakers x languages), independent of the number of listeners.
 *
 * Active languages are controlled at runtime by the peer:
 *   {"event":"start-translation","translation":{"language":"en"}}
 *   {"event":"stop-translation","translation":{"language":"en"}}
 * Omitting a "tag" means the request applies to every speaker on this socket.
 */
export class TranslatorProxy extends EventEmitter {
	private readonly ws: WebSocket;
	/** tag -> (language -> connection). */
	private translatorConnections: Map<string, Map<string, TranslatorConnection>>;
	/** The set of target languages currently being translated for every speaker. */
	private activeLanguages: Set<string>;
	private options: TranslatorProxyOptions;

	constructor(ws: WebSocket, options: TranslatorProxyOptions) {
		super({ captureRejections: true });
		this.ws = ws;
		this.options = options;
		this.translatorConnections = new Map<string, Map<string, TranslatorConnection>>();
		this.activeLanguages = new Set<string>(options.initialLanguages ?? []);

		this.ws.addEventListener('close', () => {
			for (const byLanguage of this.translatorConnections.values()) {
				for (const conn of byLanguage.values()) {
					conn.close();
				}
			}
			this.translatorConnections.clear();
			this.emit('closed');
		});

		this.ws.addEventListener('message', (event) => {
			let parsedMessage;
			try {
				parsedMessage = JSON.parse(event.data as string);
			} catch (parseError) {
				parsedMessage = { raw: event.data, parseError: true };
			}

			if (!parsedMessage || typeof parsedMessage !== 'object') {
				return;
			}

			switch (parsedMessage.event) {
				case 'ping': {
					const pongMessage: { event: string; id?: number } = { event: 'pong' };
					if (typeof parsedMessage.id === 'number') {
						pongMessage.id = parsedMessage.id;
					}
					this.ws.send(JSON.stringify(pongMessage));
					break;
				}
				case 'media':
					this.handleMediaEvent(parsedMessage);
					break;
				case 'start-translation':
					this.handleStartTranslation(parsedMessage.translation?.language);
					break;
				case 'stop-translation':
					this.handleStopTranslation(parsedMessage.translation?.language);
					break;
				default:
					break;
			}
		});
	}

	/** Add a target language to translate every speaker into. */
	private handleStartTranslation(language: unknown): void {
		const normalized = this.normalize(language);
		if (normalized === undefined) {
			return;
		}
		if (this.activeLanguages.has(normalized)) {
			logger.debug(`start-translation: language ${normalized} already active`);
			return;
		}
		this.activeLanguages.add(normalized);
		logger.info(`start-translation: now translating into ${normalized} (active: ${[...this.activeLanguages].join(', ')})`);
		// Connections are created lazily on the next media event for each speaker.
	}

	/** Stop translating into a target language and tear down its sessions. */
	private handleStopTranslation(language: unknown): void {
		const normalized = this.normalize(language);
		if (normalized === undefined) {
			return;
		}
		this.activeLanguages.delete(normalized);
		for (const [tag, byLanguage] of this.translatorConnections) {
			const conn = byLanguage.get(normalized);
			if (conn !== undefined) {
				conn.close();
				byLanguage.delete(normalized);
			}
			if (byLanguage.size === 0) {
				this.translatorConnections.delete(tag);
			}
		}
		logger.info(`stop-translation: stopped translating into ${normalized} (active: ${[...this.activeLanguages].join(', ')})`);
	}

	private normalize(language: unknown): string | undefined {
		if (typeof language !== 'string' || language.length === 0) {
			logger.warn(`Ignoring translation control message with missing/invalid language: ${String(language)}`);
			return undefined;
		}
		try {
			return normalizeTargetLanguage(language);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn(`Ignoring translation control message with unsupported language "${language}": ${msg}`);
			return undefined;
		}
	}

	private getConnection(tag: string, language: string): TranslatorConnection {
		let byLanguage = this.translatorConnections.get(tag);
		if (byLanguage === undefined) {
			byLanguage = new Map<string, TranslatorConnection>();
			this.translatorConnections.set(tag, byLanguage);
		}

		const existing = byLanguage.get(language);
		if (existing !== undefined) {
			return existing;
		}

		const newConnection = new TranslatorConnection(tag, {
			targetLanguage: language,
		});

		newConnection.onClosed = (closedTag) => {
			const map = this.translatorConnections.get(closedTag);
			if (map !== undefined) {
				map.delete(language);
				if (map.size === 0) {
					this.translatorConnections.delete(closedTag);
				}
			}
		};
		newConnection.onError = (errorTag, error) => {
			this.emit('error', errorTag, error);
		};
		newConnection.onTranscription = (transcript, targetLanguage) => {
			this.emit('transcription', { transcript, targetLanguage, tag });
		};
		newConnection.onAudioFrame = (frameTag, chunk, timestamp, payload, sequenceNumber) => {
			this.emit('audioFrame', { tag: frameTag, language, chunk, timestamp, payload, sequenceNumber });
		};

		byLanguage.set(language, newConnection);
		return newConnection;
	}

	handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (!tag || this.activeLanguages.size === 0) {
			return;
		}
		for (const language of this.activeLanguages) {
			this.getConnection(tag, language).handleMediaEvent(parsedMessage);
		}
	}
}
