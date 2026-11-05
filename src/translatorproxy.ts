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

import { TranslatorConnection, normalizeTargetLanguage } from './TranslatorConnection';
import type { TranslatorCloseReason } from './TranslatorConnection';
import { defaultTranslationProvider, type TranslationProviderId } from './translate/provider';
import { Emitter } from './translate/emitter';
import type { IWebSocket, TranslationRuntime } from './translate/runtime';
import { reportTranslationUsage } from './usage-reporter';

export interface TranslatorProxyOptions {
	/**
	 * Target languages active when the connection opens. Seeded from the URL
	 * (`?lang=en` or `?lang=en,de`) for the dev/replay path only. The JVB does
	 * NOT use this — it drives synthetic sources via `sources` control events.
	 */
	initialLanguages?: string[];
	/**
	 * Speech-to-speech provider for every direction of this connection (the `provider` URL
	 * parameter), validated by the caller with resolveTranslationProvider. Undefined → the
	 * deployment default (`runtime.config.provider`, else `openai`).
	 */
	provider?: TranslationProviderId;
	/**
	 * Translation usage token (the JVB-forwarded `X-Translation-Token`). Threaded to
	 * the usage reporter so reported translation usage can be attributed downstream.
	 * Absent on the dev/replay `?lang=` path — usage is then not reported.
	 */
	translationToken?: string;
}

// Per-direction reopen backoff after a connection failed (ms): base, doubling, capped. A direction whose
// connection closed with an error, or was closed by the provider before it ever took audio, is not re-dialled
// on the very next 20 ms frame, or an outage would turn into one connect attempt (a billable session start on
// xAI) per frame per direction. A benign close (idle, or a provider-side close after audio flowed) is not paced.
const REOPEN_BACKOFF_BASE_MS = 1000;
const REOPEN_BACKOFF_MAX_MS = 15000;

/**
 * Bridges a single export WebSocket (the bridge's dedicated translation socket)
 * to one or more provider translation sessions (OpenAI or xAI, see ./translate/provider.ts).
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
/**
 * workerd's error for a peer whose connection went away without a Close frame it could deliver: how the
 * JVB's normal close arrives in the Worker (see TranslatorProxy.onBridgeClosed). Not a failure.
 */
const BENIGN_BRIDGE_ERROR_RE = /Network connection lost/;

export class TranslatorProxy extends Emitter {
	private readonly ws: IWebSocket;
	private options: TranslatorProxyOptions;
	private readonly runtime: TranslationRuntime;

	/**
	 * input source name -> (language -> connection). Connections created from `sources`
	 * requests and from the dev path both live here, keyed by their input source name so
	 * a single `media` event fans to every language for that source.
	 */
	private connections: Map<string, Map<string, TranslatorConnection>>;

	/**
	 * The authoritative desired state from the last `sources` event: input source name ->
	 * (language -> request string, the output tag). A direction whose connection has gone away (the
	 * provider closed it, the idle close, a failure) is reopened from here on the source's next
	 * media frame, so a muted participant or a provider's session limit does not end translation
	 * until the next `sources` event happens to arrive.
	 */
	private desired: Map<string, Map<string, string>> = new Map();

	/** `${source}.${language}` -> { notBefore, backoffMs } for directions whose connection failed. */
	private reopenBackoff: Map<string, { notBefore: number; backoffMs: number }> = new Map();
	/**
	 * Directions ("{source}.{language}") closed by the idle close and not reopened since. A `sources`
	 * event does not reopen them: on a wall-clock-billed provider that would start a paid session for a
	 * muted participant on every join or leave in the conference, to be idle-closed again. The source's
	 * next media frame reopens them, as for any other close.
	 */
	private idleClosed: Set<string> = new Set();

	/** Dev/replay path only: languages applied to every incoming source. */
	private devLanguages: Set<string>;

	private readonly provider: TranslationProviderId;

	/**
	 * Monotonic mediajson wire-envelope sequence number for outbound `media`, scoped to this proxy
	 * (i.e. this WebSocket, which carries every synthetic source). The per-source RTP sequence number
	 * is the separate `chunk` field produced by each connection's RtpTimestamper.
	 */
	private envelopeSequenceNumber = 0;

	/** Set by the bridge socket's close event; the teardown runs once. */
	private bridgeClosed = false;
	/** Set by {@link close}, so the close event it causes is reported as the proxy's own. */
	private closedLocally = false;
	/** The message of the bridge socket's `error` event, if one preceded its close (see onBridgeClosed). */
	private bridgeError?: string;

	constructor(ws: IWebSocket, options: TranslatorProxyOptions, runtime: TranslationRuntime) {
		super();
		this.ws = ws;
		this.options = options;
		this.runtime = runtime;
		this.connections = new Map<string, Map<string, TranslatorConnection>>();
		this.devLanguages = new Set<string>(options.initialLanguages ?? []);
		this.provider = options.provider ?? defaultTranslationProvider(runtime.config);

		this.ws.addEventListener('close', (event) => this.onBridgeClosed(event));

		this.ws.addEventListener('error', (event) => {
			// Both runtimes follow an error with a close event, so the message is kept for the close line,
			// which has the code to say what it meant. workerd's "Network connection lost." is how a bridge
			// that closed normally arrives in the Worker (see onBridgeClosed), so it is not an error of the
			// session; any other error (a reset connection, a bad frame) still is.
			this.bridgeError = (event as { message?: string }).message ?? 'WebSocket error';
			const level = BENIGN_BRIDGE_ERROR_RE.test(this.bridgeError) ? 'debug' : 'error';
			this.runtime.logger[level](`TranslatorProxy bridge WebSocket error: ${this.bridgeError}`);
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
	 * The bridge socket closed: tear down every direction (nothing a direction still holds in its pacer
	 * can reach anyone) and report it. One info line carries the close code and, when an `error` event
	 * preceded the close, its message. The JVB sends its Close frame and cuts the TCP connection at once,
	 * without waiting for the reply (`Exporter.stop`), so in the Worker every normal bridge close comes
	 * with workerd's error "Network connection lost.", before or after the close event (measured both
	 * ways), and reporting that as an error made each healthy session's end look like a failure. A peer
	 * that completes the handshake gets a clean close with its code and no error in both runtimes. A
	 * close that {@link close} asked for is reported as the proxy's own, so a rollout does not read as
	 * a run of bridge disconnects. The reason is the peer's string and is quoted, so it cannot break
	 * the line. Neither runtime dispatches a second close event; the guard only keeps a stray one from
	 * emitting `closed` twice.
	 */
	private onBridgeClosed(event: { code?: number; reason?: string; wasClean?: boolean } | undefined): void {
		if (this.bridgeClosed) {
			return;
		}
		this.bridgeClosed = true;
		const who = this.closedLocally ? 'TranslatorProxy closed the bridge WebSocket' : 'TranslatorProxy bridge WebSocket closed';
		const afterError = this.bridgeError !== undefined ? ` after error: ${this.bridgeError}` : '';
		this.runtime.logger.info(
			`${who}: code=${event?.code ?? 'none'} reason=${JSON.stringify(event?.reason ?? '')} wasClean=${event?.wasClean ?? 'unknown'}${afterError}`,
		);
		this.closeAllConnections(/* releaseQueuedAudio */ false);
		this.emit('closed');
	}

	/**
	 * Close every active translation connection — each flushes its final usage delta on close — and
	 * clear the map. Idempotent (connection close is guarded). Shared by {@link onBridgeClosed} (which
	 * passes `releaseQueuedAudio` false: the socket the audio would go to has closed) and by
	 * {@link close}.
	 */
	private closeAllConnections(releaseQueuedAudio = true): void {
		for (const byLanguage of this.connections.values()) {
			for (const conn of byLanguage.values()) {
				conn.close(releaseQueuedAudio);
			}
		}
		this.connections.clear();
	}

	/**
	 * Synchronously tear down the proxy: close all connections (flushing their final usage deltas) and
	 * the bridge socket. Used by graceful shutdown so the last per-direction delta is buffered before
	 * the usage reporter is drained.
	 */
	close(): void {
		// closeAllConnections() buffers each direction's final usage delta synchronously (so a shutdown
		// caller can drain the reporter right after). ws.close() then fires the bridge 'close' handler,
		// which calls closeAllConnections() again on the now-empty map (harmless no-op) and emits 'closed'.
		this.closeAllConnections();
		this.closedLocally = true;
		try {
			this.ws.close();
		} catch {
			// bridge already closing/closed
		}
	}

	/**
	 * Send the server `info` message to the connected client right after connect (mirrors the
	 * transcription path). Carries git hash / runtime / deployment details; the CF Worker augments
	 * it in-place with a `worker` block. `provider` names the speech-to-speech provider of this connection.
	 */
	private sendServerInfo(): void {
		try {
			const info = this.runtime.buildServerInfo(this.provider);
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
		this.desired = desired;
		// Forget the reopen pacing and idle state of directions no longer requested, so the maps do not
		// grow with every participant who ever joined a long-lived socket.
		this.forgetDirections(
			(inputSourceName, language) => !desired.get(inputSourceName)?.has(language) && !this.devLanguages.has(language),
		);

		// Close any session no longer requested.
		for (const [inputSourceName, byLanguage] of this.connections) {
			const desiredLanguages = desired.get(inputSourceName);
			for (const [language, conn] of byLanguage) {
				if (desiredLanguages === undefined || !desiredLanguages.has(language)) {
					// The bridge no longer has this synthetic source, so audio still queued for it has no listener.
					conn.close(/* releaseQueuedAudio */ false);
					byLanguage.delete(language);
				}
			}
			if (byLanguage.size === 0) {
				this.connections.delete(inputSourceName);
			}
		}

		// Open any newly-requested session. A direction the idle close ended, or one whose last connection
		// failed and is in its reopen backoff, is left to the source's next media frame (handleMediaEvent):
		// `sources` fires on every join and leave, and re-dialling on each would defeat both.
		for (const [inputSourceName, byLanguage] of desired) {
			for (const [language, request] of byLanguage) {
				if (this.idleClosed.has(`${inputSourceName}.${language}`) || !this.mayReopen(inputSourceName, language)) {
					continue;
				}
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
		this.forgetDirections((inputSourceName, language) => language === normalized && !this.desired.get(inputSourceName)?.has(language));
		for (const [inputSourceName, byLanguage] of this.connections) {
			const conn = byLanguage.get(normalized);
			if (conn !== undefined) {
				conn.close(/* releaseQueuedAudio */ false);
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
			return normalizeTargetLanguage(language, this.provider);
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
		this.idleClosed.delete(`${inputSourceName}.${language}`);

		// Wire the usage reporter only when a token is present (the JVB-forwarded X-Translation-Token).
		// Without a token there is nothing to attribute, so we pass no onUsageReport at all — that also
		// means the connection starts no periodic reporting timer on the dev/replay `?lang=` path.
		const token = this.options.translationToken;
		const conn = new TranslatorConnection(
			inputSourceName,
			{
				targetLanguage: language,
				provider: this.provider,
				...(token
					? {
							onUsageReport: (durationSeconds: number, targetLanguage: string) =>
								reportTranslationUsage(
									{ token, durationSeconds, targetLanguage },
									{ url: this.runtime.config.translationUsageUrl, logger: this.runtime.logger },
								),
						}
					: {}),
			},
			this.runtime,
		);

		conn.onClosed = (_tag, reason) => {
			const map = this.connections.get(inputSourceName);
			// Only act if this connection is still the registered one: a reconcile may already have closed it
			// and registered a replacement under the same key, and a late close from the old socket must then
			// neither unregister the replacement nor touch the direction's reopen backoff.
			if (map === undefined || map.get(language) !== conn) {
				return;
			}
			map.delete(language);
			if (map.size === 0) {
				this.connections.delete(inputSourceName);
			}
			this.noteClosed(inputSourceName, language, reason);
		};
		conn.onError = (_tag, error) => {
			this.emit('error', outputTag, error);
		};
		// The session has carried enough audio to count as healthy: a later failure starts the pacing from
		// the base wait again, instead of doubling a backoff left over from a failure long before.
		conn.onSessionUsable = () => {
			if (this.connections.get(inputSourceName)?.get(language) === conn) {
				this.reopenBackoff.delete(`${inputSourceName}.${language}`);
			}
		};
		conn.onTranscription = (transcript, targetLanguage, isInterim) => {
			this.emit('transcription', { transcript, targetLanguage, tag: inputSourceName, isInterim });
		};
		conn.onAudioFrame = (_tag, chunk, timestamp, payload, audioLevel, vad) => {
			this.emit('audioFrame', {
				tag: outputTag,
				language,
				chunk,
				timestamp,
				payload,
				audioLevel,
				vad,
				sequenceNumber: this.envelopeSequenceNumber++,
			});
		};
		// Talk boundaries bracketing the run of audioFrames. Reuse the wire-envelope sequence counter so start/stop
		// interleave correctly with the media frames they wrap on the single outbound WebSocket.
		conn.onTalkStart = (_tag, timestamp) => {
			this.emit('talkStart', { tag: outputTag, timestamp, sequenceNumber: this.envelopeSequenceNumber++ });
		};
		conn.onTalkStop = (_tag, timestamp, mediaInfo) => {
			this.emit('talkStop', { tag: outputTag, timestamp, mediaInfo, sequenceNumber: this.envelopeSequenceNumber++ });
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
			if (this.mayReopen(tag, language)) {
				this.ensureConnection(tag, language, `${tag}.${language}`);
			}
		}
		// Reopen any requested direction whose connection has gone away (see `desired`).
		const requested = this.desired.get(tag);
		if (requested !== undefined) {
			for (const [language, request] of requested) {
				if (this.connections.get(tag)?.get(language) === undefined && this.mayReopen(tag, language)) {
					this.ensureConnection(tag, language, request);
				}
			}
		}

		const byLanguage = this.connections.get(tag);
		if (byLanguage === undefined || byLanguage.size === 0) {
			return;
		}
		for (const conn of byLanguage.values()) {
			conn.handleMediaEvent(parsedMessage);
		}
	}

	/**
	 * Record how a direction's connection ended, for the reopen pacing: a failure arms (and doubles)
	 * the direction's backoff; a benign close clears it. Logged at info so a direction cycling on
	 * idle closes is visible without being an error.
	 */
	private noteClosed(inputSourceName: string, language: string, reason: TranslatorCloseReason | undefined): void {
		const key = `${inputSourceName}.${language}`;
		if (reason === 'error' || reason === 'rejected') {
			const prev = this.reopenBackoff.get(key);
			const backoffMs = prev === undefined ? REOPEN_BACKOFF_BASE_MS : Math.min(prev.backoffMs * 2, REOPEN_BACKOFF_MAX_MS);
			this.reopenBackoff.set(key, { notBefore: Date.now() + backoffMs, backoffMs });
			this.runtime.logger.info(`translation direction ${key} ${reason === 'rejected' ? 'was closed by the provider before it was usable' : 'failed'}; reopening on media not before ${backoffMs}ms`);
			return;
		}
		this.reopenBackoff.delete(key);
		if (reason === 'idle') {
			this.idleClosed.add(key);
		}
		if (reason === 'idle' || reason === 'remote') {
			this.runtime.logger.info(`translation direction ${key} closed (${reason}); reopens on the source's next media`);
		}
	}

	/** Drop the reopen pacing and idle state of every direction `gone` says is no longer wanted. */
	private forgetDirections(gone: (inputSourceName: string, language: string) => boolean): void {
		for (const key of [...this.reopenBackoff.keys(), ...this.idleClosed]) {
			const dot = key.lastIndexOf('.');
			if (gone(key.slice(0, dot), key.slice(dot + 1))) {
				this.reopenBackoff.delete(key);
				this.idleClosed.delete(key);
			}
		}
	}

	/** Whether a direction with no connection may be (re)opened now, per its failure backoff. */
	private mayReopen(inputSourceName: string, language: string): boolean {
		const entry = this.reopenBackoff.get(`${inputSourceName}.${language}`);
		return entry === undefined || Date.now() >= entry.notBefore;
	}

	private activeConnectionCount(): number {
		let count = 0;
		for (const byLanguage of this.connections.values()) {
			count += byLanguage.size;
		}
		return count;
	}
}
