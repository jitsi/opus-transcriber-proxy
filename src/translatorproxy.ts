import { TranslatorConnection, normalizeTargetLanguage } from './TranslatorConnection';
import { EventEmitter } from 'node:events';
import type { IWebSocket, TranslationRuntime } from './translate/runtime';

export interface TranslatorProxyOptions {
	/**
	 * Target languages active when the connection opens. Seeded from the URL
	 * (`?lang=en` or `?lang=en,de`) for the dev/replay path only. The JVB does
	 * NOT use this — it drives synthetic sources via `sources` control events.
	 */
	initialLanguages?: string[];
	provider?: string;
}

/**
 * Bridges a single export WebSocket (the bridge's dedicated translation socket)
 * to one or more OpenAI translation sessions.
 *
 * Driven by the JVB via the `sources` control event (PR jitsi/jitsi-videobridge#2419):
 *   {"event":"sources","exports":["523834112-a0"],"requests":["523834112-a0.en"]}
 * `requests` is the authoritative full set of synthetic sources to produce. Each
 * request is a synthetic source name encoding an input (export) source name plus a
 * target language, separated by the last ".", e.g. "523834112-a0.en" ->
 * input source "523834112-a0", language "en". One {@link TranslatorConnection} is
 * maintained per (input source, language); returned audio is tagged with the
 * request string verbatim so the bridge's findSyntheticAudioSource(tag) matches.
 *
 * Incoming `media` is keyed by the export (input) source name — the bridge tags its
 * outbound media by source name — and is fanned to every translation session for
 * that source, producing one translated stream per requested language.
 *
 * The legacy `start-translation` / `stop-translation` control frames and the
 * `?lang=` URL parameter are retained as the dev/replay path only. They apply a
 * language to every incoming source (conference-wide) and tag returned audio as
 * `{inputSource}.{language}`.
 */
export class TranslatorProxy extends EventEmitter {
	private readonly ws: IWebSocket;
	private options: TranslatorProxyOptions;
	private readonly runtime: TranslationRuntime;

	/**
	 * input source name -> (language -> connection). Connections created from `sources`
	 * requests and from the dev path both live here, keyed by their input source name so
	 * a single `media` event fans to every language for that source.
	 */
	private connections: Map<string, Map<string, TranslatorConnection>>;

	/** Dev/replay path only: languages applied to every incoming source. */
	private devLanguages: Set<string>;

	/**
	 * Monotonic mediajson wire-envelope sequence number for outbound `media`, scoped to this proxy
	 * (i.e. this WebSocket, which carries every synthetic source). The per-source RTP sequence number
	 * is the separate `chunk` field produced by each connection's RtpTimestamper.
	 */
	private envelopeSequenceNumber = 0;

	constructor(ws: IWebSocket, options: TranslatorProxyOptions, runtime: TranslationRuntime) {
		super({ captureRejections: true });
		this.ws = ws;
		this.options = options;
		this.runtime = runtime;
		this.connections = new Map<string, Map<string, TranslatorConnection>>();
		this.devLanguages = new Set<string>(options.initialLanguages ?? []);

		this.ws.addEventListener('close', () => {
			for (const byLanguage of this.connections.values()) {
				for (const conn of byLanguage.values()) {
					conn.close();
				}
			}
			this.connections.clear();
			this.emit('closed');
		});

		this.ws.addEventListener('error', (event) => {
			const message = (event as { message?: string; }).message ?? 'WebSocket error';
			this.runtime.logger.error(`TranslatorProxy bridge WebSocket error: ${message}`);
		});

		this.ws.addEventListener('message', (event) => {
			let parsedMessage;
			try {
				parsedMessage = JSON.parse(event.data as string);
			} catch {
				return;
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
				case 'sources':
					this.handleSources(parsedMessage.exports ?? [], parsedMessage.requests ?? []);
					break;
				case 'start-translation':
					this.handleStartTranslation(parsedMessage.translation?.language);
					break;
				case 'stop-translation':
					this.handleStopTranslation(parsedMessage.translation?.language);
					break;
				case 'info':
					// Informational message from the client (e.g. JVB application/version/region). Log it.
					this.runtime.logger.info(`Received info from client on /translate: ${JSON.stringify(parsedMessage)}`);
					break;
				default:
					break;
			}
		});

		this.sendServerInfo();
	}

	/**
	 * Send the server `info` message to the connected client right after connect (mirrors the
	 * transcription path). Carries git hash / runtime / deployment details; the CF Worker augments
	 * it in-place with a `worker` block. Translation always runs on OpenAI, so the provider is fixed.
	 */
	private sendServerInfo(): void {
		try {
			const info = this.runtime.buildServerInfo();
			if (info === undefined) {
				return;
			}
			this.runtime.logger.info(`Sending server info on /translate: ${JSON.stringify(info)}`);
			this.ws.send(JSON.stringify(info));
		} catch (error) {
			this.runtime.logger.error('Failed to send server info on /translate:', error);
		}
	}

	/**
	 * Reconcile the set of active translation sessions against the authoritative `requests`
	 * list from a `sources` event: open sessions for newly-requested synthetic sources, close
	 * sessions that are no longer requested.
	 */
	private handleSources(exports: unknown, requests: unknown): void {
		const exportList: string[] = Array.isArray(exports) ? exports.filter((s): s is string => typeof s === 'string') : [];
		const requestList: string[] = Array.isArray(requests) ? requests.filter((s): s is string => typeof s === 'string') : [];

		// Desired state: input source -> (language -> request string verbatim, used as the output tag).
		const desired = new Map<string, Map<string, string>>();
		for (const request of requestList) {
			const parsed = this.parseRequest(request);
			if (parsed === undefined) {
				continue;
			}
			const { inputSourceName, language } = parsed;
			if (exportList.length > 0 && !exportList.includes(inputSourceName)) {
				this.runtime.logger.warn(`sources: request "${request}" references input source "${inputSourceName}" not in exports`);
			}
			let byLanguage = desired.get(inputSourceName);
			if (byLanguage === undefined) {
				byLanguage = new Map<string, string>();
				desired.set(inputSourceName, byLanguage);
			}
			byLanguage.set(language, request);
		}

		// Close any session no longer requested.
		for (const [inputSourceName, byLanguage] of this.connections) {
			const desiredLanguages = desired.get(inputSourceName);
			for (const [language, conn] of byLanguage) {
				if (desiredLanguages === undefined || !desiredLanguages.has(language)) {
					conn.close();
					byLanguage.delete(language);
				}
			}
			if (byLanguage.size === 0) {
				this.connections.delete(inputSourceName);
			}
		}

		// Open any newly-requested session.
		for (const [inputSourceName, byLanguage] of desired) {
			for (const [language, request] of byLanguage) {
				this.ensureConnection(inputSourceName, language, request);
			}
		}

		this.runtime.logger.info(
			`sources: reconciled exports=${exportList.length} requests=${requestList.length} active=${this.activeConnectionCount()}`,
		);
	}

	/**
	 * Split a synthetic source name "{inputSource}.{language}" into its parts. The language
	 * is the substring after the LAST ".", so input source names (e.g. "523834112-a0") that
	 * contain no "." are recovered intact.
	 */
	private parseRequest(request: string): { inputSourceName: string; language: string } | undefined {
		const dot = request.lastIndexOf('.');
		if (dot <= 0 || dot === request.length - 1) {
			this.runtime.logger.warn(`sources: cannot parse language from request "${request}"`);
			return undefined;
		}
		const inputSourceName = request.slice(0, dot);
		const language = this.normalize(request.slice(dot + 1));
		if (language === undefined) {
			return undefined;
		}
		return { inputSourceName, language };
	}

	/** Add a target language to translate every incoming source into (dev/replay path). */
	private handleStartTranslation(language: unknown): void {
		const normalized = this.normalize(language);
		if (normalized === undefined) {
			return;
		}
		if (this.devLanguages.has(normalized)) {
			return;
		}
		this.devLanguages.add(normalized);
		this.runtime.logger.info(`start-translation: now translating every source into ${normalized}`);
		// Connections are created lazily on the next media event for each source.
	}

	/** Stop translating into a target language and tear down its sessions (dev/replay path). */
	private handleStopTranslation(language: unknown): void {
		const normalized = this.normalize(language);
		if (normalized === undefined) {
			return;
		}
		this.devLanguages.delete(normalized);
		for (const [inputSourceName, byLanguage] of this.connections) {
			const conn = byLanguage.get(normalized);
			if (conn !== undefined) {
				conn.close();
				byLanguage.delete(normalized);
			}
			if (byLanguage.size === 0) {
				this.connections.delete(inputSourceName);
			}
		}
		this.runtime.logger.info(`stop-translation: stopped translating into ${normalized}`);
	}

	private normalize(language: unknown): string | undefined {
		if (typeof language !== 'string' || language.length === 0) {
			this.runtime.logger.warn(`Ignoring translation request with missing/invalid language: ${String(language)}`);
			return undefined;
		}
		try {
			return normalizeTargetLanguage(language);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.runtime.logger.warn(`Ignoring translation request with unsupported language "${language}": ${msg}`);
			return undefined;
		}
	}

	/**
	 * Ensure a translation session exists for (inputSourceName, language). Returned audio
	 * is emitted tagged with `outputTag` — the synthetic source name verbatim (from a
	 * `sources` request, or `{inputSource}.{language}` for the dev path).
	 */
	private ensureConnection(inputSourceName: string, language: string, outputTag: string): TranslatorConnection {
		let byLanguage = this.connections.get(inputSourceName);
		if (byLanguage === undefined) {
			byLanguage = new Map<string, TranslatorConnection>();
			this.connections.set(inputSourceName, byLanguage);
		}

		const existing = byLanguage.get(language);
		if (existing !== undefined) {
			return existing;
		}

		const conn = new TranslatorConnection(inputSourceName, { targetLanguage: language }, this.runtime);

		conn.onClosed = () => {
			const map = this.connections.get(inputSourceName);
			if (map !== undefined) {
				map.delete(language);
				if (map.size === 0) {
					this.connections.delete(inputSourceName);
				}
			}
		};
		conn.onError = (_tag, error) => {
			this.emit('error', outputTag, error);
		};
		conn.onTranscription = (transcript, targetLanguage, isInterim) => {
			this.emit('transcription', { transcript, targetLanguage, tag: inputSourceName, isInterim });
		};
		conn.onAudioFrame = (_tag, chunk, timestamp, payload) => {
			this.emit('audioFrame', { tag: outputTag, language, chunk, timestamp, payload, sequenceNumber: this.envelopeSequenceNumber++ });
		};

		byLanguage.set(language, conn);
		return conn;
	}

	private handleMediaEvent(parsedMessage: any): void {
		const tag = parsedMessage.media?.tag;
		if (typeof tag !== 'string' || tag.length === 0) {
			return;
		}

		// Dev/replay path: lazily ensure a session for every active dev language for this source.
		for (const language of this.devLanguages) {
			this.ensureConnection(tag, language, `${tag}.${language}`);
		}

		const byLanguage = this.connections.get(tag);
		if (byLanguage === undefined || byLanguage.size === 0) {
			return;
		}
		for (const conn of byLanguage.values()) {
			conn.handleMediaEvent(parsedMessage);
		}
	}

	private activeConnectionCount(): number {
		let count = 0;
		for (const byLanguage of this.connections.values()) {
			count += byLanguage.size;
		}
		return count;
	}
}
