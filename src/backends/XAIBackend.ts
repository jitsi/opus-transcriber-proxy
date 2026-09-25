/**
 * xAI Speech-to-Text backend for transcription
 *
 * Uses xAI's WebSocket-based STT streaming API for real-time transcription.
 * Audio is sent as raw binary signed-16-bit little-endian PCM frames.
 * Responses: transcript.partial (interim) and transcript.done (final).
 */

import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import WsWebSocket from 'ws';
import { config } from '../config';
import logger from '../logger';
import type { TranscriptionBackend, BackendConfig, AudioFormat } from './TranscriptionBackend';
import type { TranscriptionMessage } from '../transcriberproxy';
import { writeMetric } from '../metrics';
import { getInstruments } from '../telemetry/instruments';
import { XAIGranularSegmenter, splitWords, type GranularResult } from './XAIGranularSegmenter';

// Reused across messages; TextDecoder is stateless for our usage (one full frame per call).
const textDecoder = new TextDecoder();

// PCM sample rate sent to xAI. 16 kHz is the model's native rate (per xAI STT docs),
// which avoids a server-side resample. Used for the request param, the desired decoder
// output format, and the idle-silence buffer — keep these in sync.
const XAI_SAMPLE_RATE = 16000;

// Extra silence (ms) injected beyond the endpointing threshold on idle commit, to be
// sure xAI's VAD crosses the silence boundary and emits the final. See forceCommit().
const XAI_IDLE_SILENCE_MARGIN_MS = 300;

// --- Handshake failure handling -----------------------------------------------------
//
// xAI rejects the WS upgrade with an HTTP response when its STT backend is unavailable.
// Every such rejection is retried except the ones below, where a retry provably cannot
// help: the credential is rejected, and it will be rejected identically on every
// attempt until someone changes the key.
//
// This is a denylist rather than an allowlist of retryable statuses because the
// allowlist has now been wrong twice, in the same direction both times. It started as
// 408/425/429/500/502/503/504 after the 2026-09-10 fleet-wide 503s; the Cloudflare 52x
// origin-failure codes had to be added after 09-04/09-08/09-09, because api.x.ai sits
// behind Cloudflare and its edge answers those when xAI's origin is unreachable; then
// on 2026-09-22 xAI answered *404* to every /v1/stt upgrade for 7 minutes fleet-wide
// (34 rejections across 5 colos), and 404 was explicitly listed as fail-fast on the
// reading that it meant "you asked for a URL that does not exist", i.e. our own
// misconfiguration. It did not: `server-timing: cfOrigin;dur=217` showed Cloudflare had
// reached an origin which answered the 404 itself, the body was empty with no error
// detail whatsoever, and the very same URL from the very same build connected again the
// moment the incident cleared. Nothing in an xAI rejection distinguishes "your request
// is wrong" from "our backend is missing", so the status cannot carry that decision.
//
// Failing fast on a genuinely malformed request was never worth much anyway: a bad
// XAI_STT_URL or query param breaks every connection forever, so it is exactly as loud
// whether or not we spend a couple of seconds retrying first. A transient rejection
// treated as fatal, by contrast, costs a conference its captions (a malformed URL that
// cannot even be parsed still fails fast — see connectOnce's construction catch).
const XAI_FATAL_UPGRADE_STATUSES = new Set([401, 403]);

const XAI_CONNECT_BACKOFF_MAX_MS = 4000;
const XAI_CONNECT_BACKOFF_JITTER = 0.25;

// The rejected upgrade's response body is read for diagnostics (xAI support asks for it
// alongside the request id). It is bounded only so that a hung read can't stall the
// retry loop behind it — the body itself is never load-bearing.
const XAI_ERROR_BODY_MAX_CHARS = 2048;
const XAI_ERROR_BODY_TIMEOUT_MS = 1000;

// Per-attempt handshake ceiling. `ws` sets no handshakeTimeout by default, so an xAI
// endpoint that accepts the TCP connection and then goes quiet would hang connect()
// until the OS gives up (minutes) with the participant's audio buffering behind it —
// and the retry loop would stack that serially. Bounds one attempt, so the worst case
// for the default 4 attempts is ~4x this plus ~1.75s of backoff.
const XAI_HANDSHAKE_TIMEOUT_MS = 5000;

// Ceiling on an honoured Retry-After. A participant's audio is buffering behind
// connect(), so we never hold it longer than this however long the server asks for.
// (Refusing to retry on a long Retry-After would not honour it either: the owner tears
// the connection down and the next media frame opens a fresh one immediately.)
const XAI_RETRY_AFTER_MAX_MS = XAI_CONNECT_BACKOFF_MAX_MS;

// Process-wide cooldown after connect() exhausts its attempts on a transient rejection.
// When that happens the OutgoingConnection is torn down and the participant's next media
// frame (~20 ms later) creates a fresh backend with no memory of the failure — so without
// this, an xAI outage degrades into a per-participant hammer loop at one attempt-burst per
// RTT, and any Retry-After xAI sent dies with the connection that received it. An outage
// is process-wide, so the cooldown is shared by every instance: a new connect() first
// waits out the remainder, bounded by XAI_RETRY_AFTER_MAX_MS like every other wait here.
let connectCooldownUntil = 0;

/** Clears the process-wide connect cooldown. Test hook only. */
export function resetXAIConnectCooldown(): void {
	connectCooldownUntil = 0;
}

// Response headers that may carry xAI's request id. Logged on both a successful and a
// rejected handshake — it is the identifier xAI support needs to trace a failed call.
const XAI_REQUEST_ID_HEADERS = ['x-request-id', 'x-requestid', 'request-id', 'x-amzn-requestid', 'cf-ray'];

/** A handshake failure, classified so connect() knows whether a retry can help. */
class XAIConnectError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
		readonly errorType: string = 'websocket_error',
		readonly status?: number,
		readonly requestId?: string,
		/** Delay the server asked for via Retry-After, if it sent a usable one. */
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = 'XAIConnectError';
	}
}

function pickRequestId(headers: IncomingMessage['headers']): string | undefined {
	for (const name of XAI_REQUEST_ID_HEADERS) {
		const value = headers[name];
		const single = Array.isArray(value) ? value[0] : value;
		if (single) return single;
	}
	return undefined;
}

/**
 * Parse a Retry-After header (RFC 9110: delay-seconds or an HTTP-date) into ms.
 * Undefined when absent or unparseable — the caller then falls back to its own backoff.
 */
function parseRetryAfterMs(header: string | string[] | undefined): number | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	if (!value) return undefined;

	const seconds = Number(value.trim());
	if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : 0;

	const date = Date.parse(value);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, date - Date.now());
}

/**
 * Read a rejected upgrade's response body for logging. Never rejects — a body we
 * couldn't read must not mask the HTTP status we already have — and gives up after
 * XAI_ERROR_BODY_TIMEOUT_MS so a hung read can't stall the retry waiting on it.
 */
function readUpgradeResponseBody(res: IncomingMessage): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	let body = '';

	// resolve() past the first call is a no-op, so no `done` bookkeeping is needed.
	// Dropping the 'data' listener matters though: destroy() is not synchronous, so
	// chunks can still arrive and would keep growing a string nobody reads.
	const finish = (note = ''): void => {
		clearTimeout(timer);
		res.removeAllListeners('data');
		res.destroy();
		resolve(body.trim() + note);
	};

	const timer = setTimeout(() => finish(' [truncated: read timed out]'), XAI_ERROR_BODY_TIMEOUT_MS);

	res.setEncoding('utf-8');
	res.on('data', (chunk: string) => {
		body += chunk;
		if (body.length >= XAI_ERROR_BODY_MAX_CHARS) finish(' [truncated]');
	});
	res.on('end', () => finish());
	res.on('error', (error: Error) => finish(` [read failed: ${error.message}]`));

	return promise;
}

/** How many leading/trailing emitted words to look for in the whole-turn text when aligning the rest. */
const TURN_ALIGN_ANCHOR_WORDS = 3;

/** How much of the emitted text to quote in the debug log that accompanies a reconciliation warning. */
const TURN_LOG_TAIL_CHARS = 120;

// How long after the idle silence to wait for xAI's speech_final before ending the turn without it.
// xAI answered the silence within ~0.5s when forceCommit() was verified; since 2026-09-19 it does
// not always answer at all.
const XAI_IDLE_TURN_END_GRACE_MS = 3000;

// UAX #29 word boundaries: splits languages written without spaces (zh/ja/th) into words, where a
// whitespace split would make each segment one token, and skips punctuation-only tokens ("—", "…").
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Don't let a timer keep the process alive; unref() is absent on the DOM/CF timer type. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	(timer as any)?.unref?.();
}

/** A word of xAI's `words` array as the text it renders to. */
function wordText(word: any): string {
	return String(word?.punctuated_word ?? word?.text ?? '');
}

/** The speaker of the last labelled word, or undefined when none is labelled. */
function lastSpeaker(words: any[]): number | undefined {
	for (let i = words.length - 1; i >= 0; i--) {
		if (words[i]?.speaker !== undefined) return words[i].speaker as number;
	}
	return undefined;
}

/**
 * A word reduced to what survives xAI re-punctuating and re-casing it, for aligning two renderings.
 * Deliberately not XAIGranularSegmenter's `normalize`: that one works on a whole string and strips
 * a fixed ASCII-ish punctuation list, so the two can disagree on the same word (e.g. combining marks
 * or other Unicode punctuation). Each is internally consistent; they never compare with each other.
 */
function normalizeWord(word: string): string {
	return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A word for alignment: normalized, with where it starts — a string index for text, an entry index for `words`. */
interface AlignWord {
	norm: string;
	at: number;
}

/** A transcript's words for alignment, by UAX #29 word boundaries. */
function textAlignWords(text: string): AlignWord[] {
	const out: AlignWord[] = [];
	for (const { segment, index, isWordLike } of wordSegmenter.segment(text)) {
		if (!isWordLike) continue;
		const norm = normalizeWord(segment);
		if (norm) out.push({ norm, at: index });
	}
	return out;
}

/** xAI `words` entries for alignment; an entry with no letters or digits in it is skipped. */
function entryAlignWords(words: any[]): AlignWord[] {
	const out: AlignWord[] = [];
	words.forEach((word, at) => {
		const norm = normalizeWord(wordText(word));
		if (norm) out.push({ norm, at });
	});
	return out;
}

/**
 * What the long-turn cap has emitted of the current turn — only what aligning the rest needs, so
 * it stays bounded however long a turn without a speech_final runs.
 */
interface EmittedTurn {
	/** Words emitted so far this turn. */
	count: number;
	/** The first TURN_ALIGN_ANCHOR_WORDS emitted words, normalized. */
	head: string[];
	/** The last TURN_ALIGN_ANCHOR_WORDS emitted words, normalized. */
	tail: string[];
	/** The end of the emitted text, for the debug log (transcript text is not logged above debug). */
	tailText: string;
	/** Speaker of the last labelled word emitted, when diarized. */
	speaker?: number;
}

function emptyEmittedTurn(): EmittedTurn {
	return { count: 0, head: [], tail: [], tailText: '' };
}

/**
 * Where the not-yet-emitted rest of a turn starts in its speech_final words, given what was
 * emitted. xAI's end-of-turn text is the committed segments joined — sometimes verbatim (every
 * staging turn read on 2026-09-23 was an exact space-join), sometimes re-punctuated and re-cased
 * (the `xai-live-turn.json` capture: segments ending `that.` / `person.` come back joined with
 * commas) — so a literal prefix comparison cannot be relied on, and a prefix cut at a non-word
 * boundary would split a word. Instead the last few emitted words are located in the whole-turn
 * words, at the occurrence nearest to where the emitted word count says they should be, and
 * everything after them is the rest (`anchor`); that handles both shapes.
 *
 * If xAI revised those words so they cannot be found, the speech_final's first words decide what
 * it is. Only when they are exactly the turn's first words is it the whole turn, and then as many
 * words as were emitted are dropped (`count`: can drop or repeat a word at the boundary).
 * Otherwise it is taken to carry only what followed, and all of it is the rest (`tail`). The head
 * test is strict on purpose: a turn and its tail can easily share one short word ("so", "I"), and
 * mistaking a tail for the whole turn drops up to everything that was emitted, while the opposite
 * mistake only repeats it. The caller warns on both fallbacks.
 */
function alignTurnRest(full: string[], emitted: EmittedTurn): { start: number; match: 'anchor' | 'count' | 'tail' } {
	if (emitted.count === 0) return { start: 0, match: 'anchor' };

	const anchor = emitted.tail;
	const expectedEnd = emitted.count;
	let bestEnd = -1;
	for (let i = 0; anchor.length > 0 && i + anchor.length <= full.length; i++) {
		if (!anchor.every((w, j) => full[i + j] === w)) continue;
		const end = i + anchor.length;
		if (bestEnd < 0 || Math.abs(end - expectedEnd) < Math.abs(bestEnd - expectedEnd)) bestEnd = end;
	}
	if (bestEnd >= 0) return { start: bestEnd, match: 'anchor' };

	const head = emitted.head;
	const startsLikeTurn = head.length > 0 && full.length >= head.length && head.every((w, i) => full[i] === w);
	if (!startsLikeTurn) return { start: 0, match: 'tail' };
	return { start: Math.min(emitted.count, full.length), match: 'count' };
}

export class XAIBackend implements TranscriptionBackend {
	private ws?: WsWebSocket;
	private status: 'pending' | 'connected' | 'failed' | 'closed' = 'pending';
	private backendConfig?: BackendConfig;
	private participantInfo: any;
	private tag: string;
	private apiKey: string;
	private wsUrl: string;

	// Consumer-side roll-own granular finalization (off by default). When enabled, we commit a
	// stable prefix of xAI's growing hypothesis incrementally instead of only on end-of-turn
	// speech_final, so a long turn interleaves in order with other speakers' short acks. See
	// XAIGranularSegmenter for the algorithm and the GT-meeting ordering bug it fixes.
	private segmenter?: XAIGranularSegmenter;
	private granularTimer?: ReturnType<typeof setTimeout>;
	private lastLanguage?: string;

	// Long-turn cap for the default (one final per turn) mode — see config.xai.maxTurnMs. A turn
	// runs from its first partial to its speech_final. Segments xAI commits (is_final) during the
	// turn wait in pendingSegments; once the turn is older than maxTurnMs they are emitted as a
	// final — by turnTimer, or by the commit that finds the turn already past the cap — and
	// `emitted` records what went out so the speech_final (which carries the whole turn) emits only
	// the rest (see alignTurnRest).
	private turnStartedAt?: number;
	private turnTimer?: ReturnType<typeof setTimeout>;
	private pendingSegments: Array<{ text: string; words?: any[] }> = [];
	private emitted: EmittedTurn = emptyEmittedTurn();
	// Ends the turn when xAI sends no speech_final after the idle silence (see forceCommit()).
	private idleTurnEndTimer?: ReturnType<typeof setTimeout>;
	// A turn ended after the last audio was sent, so there is nothing for an idle silence to finalize.
	private turnEndedSinceAudio = false;

	/**
	 * xAI's request id for the current stream, from the handshake response headers.
	 * Included in every failure log for this stream so a report to xAI support can name
	 * the exact call. Undefined if xAI sent no recognised request-id header.
	 */
	private requestId?: string;

	/**
	 * Cuts short the backoff wait between handshake attempts. Set while connect() is
	 * sleeping, called by close() so a torn-down connection doesn't leave connect()
	 * parked for the remainder of the delay.
	 */
	private abortConnectWait?: () => void;

	onInterimTranscription?: (message: TranscriptionMessage) => void;
	onCompleteTranscription?: (message: TranscriptionMessage, midUtterance?: boolean) => void;
	onError?: (errorType: string, errorMessage: string, recoverable?: boolean) => void;
	onClosed?: () => void;

	constructor(tag: string, participantInfo: any) {
		this.tag = tag;
		this.participantInfo = participantInfo;
		this.apiKey = config.xai.apiKey;
		this.wsUrl = config.xai.sttUrl;
	}

	async connect(backendConfig: BackendConfig): Promise<void> {
		this.backendConfig = backendConfig;
		this.resetTurn();

		if (!this.apiKey) {
			throw new Error('XAI_API_KEY not configured');
		}

		// Roll-own granular finalization is purely consumer-side: it does NOT change the xAI URL
		// (endpointing/smart_turn are unchanged). It only changes how transcript.partial events are
		// turned into finals. Gated by config/per-connection flag; scoped to the non-diarized path
		// (one WS per participant), since diarization needs per-speaker hypotheses.
		const granularEnabled = backendConfig.xaiGranularFinals ?? config.xai.granularFinals;
		if (granularEnabled && config.xai.diarize) {
			logger.warn(`xAI granular finals requested but diarize is on for tag ${this.tag}; disabled (per-speaker hypotheses unsupported)`);
		} else if (granularEnabled) {
			const stabilityMs = backendConfig.xaiGranularStabilityMs ?? config.xai.granularStabilityMs;
			const guardWords = backendConfig.xaiGranularGuardWords ?? config.xai.granularGuardWords;
			const minWords = config.xai.granularMinWords;
			this.segmenter = new XAIGranularSegmenter({ stabilityMs, guardWords, minWords });
			logger.info(
				`xAI granular finals ENABLED for tag ${this.tag} (stability=${stabilityMs}ms guard=${guardWords}w min=${minWords}w)`,
			);
		}

		const url = this.buildStreamUrl(backendConfig);
		const attempts = Math.max(1, config.xai.connectAttempts);
		let lastError: unknown;
		let attemptsMade = 0;

		// A recent connect() in this process exhausted its retries on a transient
		// rejection: wait out what is left of the cooldown before the first attempt (see
		// connectCooldownUntil). close() cuts the wait short like any backoff wait.
		const cooldownMs = connectCooldownUntil - Date.now();
		if (cooldownMs > 0) {
			logger.warn(
				`xAI connect for tag ${this.tag} deferred ${cooldownMs}ms: xAI recently rejected a handshake as temporarily unavailable`,
			);
			await this.waitBeforeRetry(cooldownMs);
		}

		// Bounded retry with backoff. A rejected upgrade used to be fatal: the
		// OutgoingConnection was torn down and the next media event immediately opened a
		// fresh connection, i.e. an unbacked-off retry loop that also dropped the client
		// WebSocket. Retrying here rides out a short provider blip in place instead.
		// (Status is read through getStatus() so it is re-read after each await, not
		// narrowed: close() during a wait means the owner has given up on us.)
		for (let attempt = 1; attempt <= attempts && this.getStatus() !== 'closed'; attempt++) {
			attemptsMade = attempt;
			try {
				await this.connectOnce(url, attempt, attempts);
				return;
			} catch (error) {
				lastError = error;
				const retryable = error instanceof XAIConnectError ? error.retryable : true;
				if (!retryable || this.getStatus() === 'closed') break;

				const retryAfterMs = error instanceof XAIConnectError ? error.retryAfterMs : undefined;
				const delayMs = this.retryDelayMs(retryAfterMs, attempt);

				if (attempt === attempts) {
					// Out of attempts on a transient failure. The owner will tear this
					// connection down and the participant's next media frame opens a fresh
					// one, so leave the delay we would have waited as a process-wide cooldown
					// for it — otherwise an outage becomes a hammer loop with no backoff.
					connectCooldownUntil = Math.max(connectCooldownUntil, Date.now() + delayMs);
					break;
				}

				logger.warn(
					`xAI handshake failed for tag ${this.tag} (attempt ${attempt}/${attempts}): ` +
						`${error instanceof Error ? error.message : String(error)}; retrying in ${delayMs}ms` +
						`${retryAfterMs !== undefined ? ' (Retry-After)' : ''}`,
				);
				await this.waitBeforeRetry(delayMs);
			}
		}

		if (this.getStatus() === 'closed') {
			// close() ran while we were waiting or mid-handshake: the owner gave up on this
			// connection (participant left, session torn down). That is not a provider
			// failure, so no error log, no metric and no onError — which is already detached.
			const reason = lastError instanceof Error ? lastError.message : 'closed before the handshake completed';
			logger.info(`xAI connect abandoned for tag ${this.tag} after ${attemptsMade} attempt(s): ${reason}`);
			throw lastError instanceof Error ? lastError : new Error(reason);
		}

		const errorType = lastError instanceof XAIConnectError ? lastError.errorType : 'websocket_error';
		const message = lastError instanceof Error ? lastError.message : String(lastError);
		logger.error(`xAI connect failed for tag ${this.tag} after ${attemptsMade} attempt(s): ${message}`);
		writeMetric(undefined, {
			name: 'xai_api_error',
			worker: 'opus-transcriber-proxy',
			errorType,
		});
		// The errorType stays 'websocket_error' for a handshake rejection so the
		// otp_backend_errors_total{type=...} series (and the alerts on it) keep their
		// existing meaning; the status code and request id ride along in the message.
		this.onError?.(errorType, message);
		this.status = 'failed';
		this.close();
		throw lastError instanceof Error ? lastError : new Error(message);
	}

	/** Sleep between handshake attempts, interruptible by close(). */
	private waitBeforeRetry(delayMs: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, delayMs);
		this.abortConnectWait = () => {
			clearTimeout(timer);
			resolve();
		};
		return promise.finally(() => {
			this.abortConnectWait = undefined;
		});
	}

	/**
	 * Delay before the next handshake attempt. A Retry-After xAI sent wins over our own
	 * backoff, capped at XAI_RETRY_AFTER_MAX_MS — a participant's audio is buffering
	 * behind connect(), so we hold it no longer than that however long the server asks.
	 */
	private retryDelayMs(retryAfterMs: number | undefined, attempt: number): number {
		if (retryAfterMs === undefined) return this.backoffDelayMs(attempt);
		if (retryAfterMs > XAI_RETRY_AFTER_MAX_MS) {
			logger.warn(
				`xAI asked for a ${retryAfterMs}ms Retry-After for tag ${this.tag}; ` +
					`capping at ${XAI_RETRY_AFTER_MAX_MS}ms (audio is buffering behind connect())`,
			);
			return XAI_RETRY_AFTER_MAX_MS;
		}
		return retryAfterMs;
	}

	/** Exponential backoff with jitter, capped, for handshake retry `attempt` (1-based). */
	private backoffDelayMs(attempt: number): number {
		const base = Math.min(config.xai.connectBackoffMs * 2 ** (attempt - 1), XAI_CONNECT_BACKOFF_MAX_MS);
		const jitter = base * XAI_CONNECT_BACKOFF_JITTER * (Math.random() * 2 - 1);
		return Math.max(0, Math.round(base + jitter));
	}

	private buildStreamUrl(backendConfig: BackendConfig): string {
		const params = new URLSearchParams({
			sample_rate: XAI_SAMPLE_RATE.toString(),
			encoding: 'pcm',
			interim_results: 'true',
		});

		const language = backendConfig.language || config.xai.language;
		if (language) {
			params.set('language', language);
		}

		if (config.xai.diarize) {
			params.set('diarize', 'true');
		}

		// Endpointing (silence-based finalization) is the correct finalizer for our
		// one-stream-per-participant topology; always sent. Per-connection override
		// (`endpointing` URL param) wins over the XAI_ENDPOINTING config default.
		const endpointing = backendConfig.xaiEndpointing ?? config.xai.endpointing;
		params.set('endpointing', endpointing.toString());

		// smart_turn is end-of-turn detection for a multi-speaker single stream. We
		// run one WS per participant, so there are no turns — it's opt-in (disabled
		// by default; it otherwise holds finals across mid-sentence pauses, producing
		// very long chunks). Sent only when configured via XAI_SMART_TURN or the
		// `smart_turn` URL param. smart_turn_timeout requires smart_turn.
		const smartTurn = backendConfig.xaiSmartTurn ?? config.xai.smartTurn;
		if (smartTurn !== undefined) {
			params.set('smart_turn', smartTurn.toString());
			const smartTurnTimeout = backendConfig.xaiSmartTurnTimeout ?? config.xai.smartTurnTimeout;
			params.set('smart_turn_timeout', smartTurnTimeout.toString());
		}

		return `${this.wsUrl}?${params.toString()}`;
	}

	/**
	 * One handshake attempt. Resolves when the socket is open; rejects with an
	 * XAIConnectError describing whether a retry can help. A failed attempt's socket is
	 * abandoned: its late error/close events are logged at debug and must not reach the
	 * owner's callbacks, or a retried connection would be torn down under us.
	 */
	private async connectOnce(url: string, attempt: number, attempts: number): Promise<void> {
		// The socket settles this from its event handlers, so the resolvers have to
		// outlive the call.
		const { promise, resolve, reject } = Promise.withResolvers<void>();

		// No API key or params are in the URL (auth is an Authorization header), so it
		// is safe to log in full — and it is the endpoint + params xAI support asks for.
		logger.info(`Opening xAI WebSocket for tag ${this.tag} (attempt ${attempt}/${attempts}): ${url}`);

		let ws: WsWebSocket;
		try {
			// Use the `ws` npm package so we can pass Authorization header.
			// The global WebSocket (undici) does not support custom headers.
			ws = new WsWebSocket(url, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
				handshakeTimeout: XAI_HANDSHAKE_TIMEOUT_MS,
			});
		} catch (error) {
			// Synchronous construction failure (e.g. a malformed XAI_STT_URL) — a retry
			// cannot help, so fail fast and keep the historical 'connection_failed' type.
			logger.error(`Failed to create xAI WebSocket connection for tag ${this.tag}:`, error);
			throw new XAIConnectError(error instanceof Error ? error.message : 'Unknown error', false, 'connection_failed');
		}

		// Published before the socket is open so close() can tear a half-open handshake
		// down. Safe against sendAudio()/forceCommit() reaching an abandoned socket
		// because status stays 'pending' for the whole retry loop and both of those
		// require 'connected' — and fail() clears this.ws before the next attempt.
		this.ws = ws;
		this.requestId = undefined;

		let settled = false;
		let abandoned = false;
		// Set the moment an HTTP rejection arrives, before its body has been read. That
		// status is the reason worth reporting, so a socket dying during the read must not
		// settle the attempt with a generic transport error instead.
		let rejectionPending = false;

		const fail = (error: XAIConnectError): void => {
			if (settled) return;
			settled = true;
			abandoned = true;
			this.ws = undefined;
			try {
				ws.terminate();
			} catch {
				// Already dead — nothing to tear down.
			}
			reject(error);
		};

		// xAI's request id for a SUCCESSFUL handshake: recorded so any later failure on
		// this stream (e.g. "ASR stream timed out") can be traced in xAI's own logs.
		ws.on('upgrade', (res: IncomingMessage) => {
			this.requestId = pickRequestId(res.headers);
			logger.info(`xAI handshake accepted for tag ${this.tag}: requestId=${this.requestId ?? 'none'}`);
		});

		// The upgrade was answered with an HTTP response instead of a 101. `ws` emits its
		// generic "Unexpected server response: <code>" error ONLY when nothing listens for
		// 'unexpected-response'; with this listener attached we own the abort, and in
		// exchange we get the status, headers (request id) and body xAI support needs.
		ws.on('unexpected-response', (req: { destroy: () => void }, res: IncomingMessage) => {
			rejectionPending = true;
			void this.reportUpgradeRejection(res, url, attempt, attempts).then((error) => {
				// fail() first: it marks the attempt settled/abandoned, so the transport
				// error that aborting the request may raise can't replace this HTTP status
				// as the rejection reason. terminate() inside fail() already aborts the
				// request; destroy() is the documented way to release it from here.
				fail(error);
				req.destroy();
			});
		});

		ws.addEventListener('open', () => {
			logger.info(`xAI WebSocket connected for tag: ${this.tag} (requestId=${this.requestId ?? 'none'})`);
			this.status = 'connected';
			settled = true;
			resolve();
		});

		ws.addEventListener('message', async (event) => {
			await this.handleMessage(event.data);
		});

		ws.addEventListener('error', (event) => {
			const errorMessage = (event as any)?.message || 'WebSocket error';

			if (abandoned) {
				// Fallout from tearing down an already-failed attempt's socket.
				logger.debug(`Late error on abandoned xAI socket for tag ${this.tag}: ${errorMessage}`);
				return;
			}

			if (rejectionPending) {
				// The HTTP status from 'unexpected-response' is the better reason; this is just
				// the socket dying underneath the body read.
				logger.debug(`Transport error while reporting an xAI upgrade rejection for tag ${this.tag}: ${errorMessage}`);
				return;
			}

			if (!settled) {
				// Pre-open transport failure (DNS/TCP/TLS/reset) — transient by nature, so
				// retryable. An HTTP rejection arrives via 'unexpected-response' instead.
				logger.warn(
					`xAI WebSocket error during handshake for tag ${this.tag} (attempt ${attempt}/${attempts}): ${errorMessage}`,
				);
				// Per-attempt metric, deliberately distinct from the 'websocket_error' reported
				// once after the last attempt: this counts handshake tries, that counts
				// connections the caller actually lost. (`ws` reports its handshakeTimeout as
				// an error event too — "Opened handshake has timed out".)
				writeMetric(undefined, {
					name: 'xai_api_error',
					worker: 'opus-transcriber-proxy',
					errorType: 'handshake_error',
				});
				getInstruments().backendHandshakeFailuresTotal.add(1, {
					provider: 'xai',
					reason: /timed out/i.test(errorMessage) ? 'timeout' : 'transport',
				});
				fail(new XAIConnectError(errorMessage, true));
				return;
			}

			// Error on a live stream — unchanged fatal path.
			logger.error(`xAI WebSocket error for tag ${this.tag} (requestId=${this.requestId ?? 'none'}): ${errorMessage}`);
			writeMetric(undefined, {
				name: 'xai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: 'websocket_error',
			});
			// Before onError, as on the API-error path: the owner detaches our callbacks inside it.
			this.flushHeldSegments(this.lastLanguage, 'errored while a segment was held');
			this.onError?.('websocket_error', 'WebSocket connection error');
			this.status = 'failed';
			this.close();
		});

		ws.addEventListener('close', (event) => {
			if (abandoned) {
				logger.debug(`Abandoned xAI handshake socket closed for tag ${this.tag}: code=${event.code}`);
				return;
			}

			if (rejectionPending) {
				logger.debug(`Socket closed while reporting an xAI upgrade rejection for tag ${this.tag}: code=${event.code}`);
				return;
			}

			if (!settled) {
				// Closed before the handshake completed, without an 'error' event.
				getInstruments().backendHandshakeFailuresTotal.add(1, { provider: 'xai', reason: 'transport' });
				fail(new XAIConnectError(`WebSocket closed during handshake (code=${event.code})`, true));
				return;
			}

			logger.info(
				`xAI WebSocket closed for tag ${this.tag}: code=${event.code} reason=${event.reason || 'none'} wasClean=${event.wasClean} requestId=${this.requestId ?? 'none'}`,
			);
			// close() fires onClosed exactly once and is idempotent, so the
			// error → close() → 'close' event → close() sequence cannot double-fire.
			this.close();
		});

		return promise;
	}

	/**
	 * Log everything xAI support needs to trace a rejected upgrade — status, request id,
	 * retry-after, response headers and body — and classify it for retry, carrying the
	 * server's Retry-After through so connect() can prefer it over its own backoff.
	 */
	private async reportUpgradeRejection(res: IncomingMessage, url: string, attempt: number, attempts: number): Promise<XAIConnectError> {
		const status = res.statusCode ?? 0;
		const requestId = pickRequestId(res.headers);
		const retryAfterMs = parseRetryAfterMs(res.headers['retry-after']);
		const retryable = !XAI_FATAL_UPGRADE_STATUSES.has(status);
		const willRetry = retryable && attempt < attempts;

		// The full headers + body are what a report to xAI support needs, so they go on
		// the first attempt (the one that also names the request id support will look
		// for) and on the final one. Not on every intermediate retry: in a fleet-wide
		// outage every participant makes several attempts every few seconds, and shipping
		// ~3 KB per attempt to the log pipeline at error level is its own incident. For
		// the same reason an attempt that will be retried logs at warn — only the failure
		// the caller actually sees is an error.
		const includeDetail = attempt === 1 || !willRetry;
		let body = '';
		if (includeDetail) {
			body = await readUpgradeResponseBody(res);
		} else {
			res.destroy();
		}

		const line =
			`xAI handshake rejected for tag ${this.tag} (attempt ${attempt}/${attempts}): ` +
			`status=${status} ${res.statusMessage ?? ''} requestId=${requestId ?? 'none'} ` +
			`retryAfter=${res.headers['retry-after'] ?? 'none'} retryable=${retryable} url=${url}` +
			(includeDetail ? ` headers=${JSON.stringify(res.headers)} body=${JSON.stringify(body)}` : '');
		if (willRetry) {
			logger.warn(line);
		} else {
			logger.error(line);
		}
		writeMetric(undefined, {
			name: 'xai_api_error',
			worker: 'opus-transcriber-proxy',
			errorType: `upgrade_http_${status}`,
		});
		// The writeMetric above is a debug-log shim; this is the series dashboards see.
		// Label cardinality is bounded by the HTTP status space.
		getInstruments().backendHandshakeFailuresTotal.add(1, { provider: 'xai', reason: `http_${status}` });

		return new XAIConnectError(
			`xAI handshake rejected: HTTP ${status} (requestId=${requestId ?? 'none'})`,
			retryable,
			'websocket_error',
			status,
			requestId,
			retryAfterMs,
		);
	}

	async sendAudio(audioBase64: string): Promise<void> {
		if (!this.ws || this.status !== 'connected') {
			throw new Error(`Cannot send audio: connection not ready (status: ${this.status})`);
		}

		// The speaker is talking again: a turn in progress continues, and the next idle has work to do.
		this.turnEndedSinceAudio = false;
		this.clearIdleTurnEnd();

		try {
			const audioBuffer = Buffer.from(audioBase64, 'base64');
			this.ws.send(audioBuffer);
		} catch (error) {
			logger.error(`Failed to send audio to xAI for tag ${this.tag}`, error);
			throw error;
		}
	}

	forceCommit(): void {
		// Finalize the trailing utterance when the stream goes idle WITHOUT closing it.
		//
		// xAI exposes no flush/commit message (unlike OpenAI's input_audio_buffer.commit
		// or Deepgram's Finalize) — only `audio.done`, which makes xAI close the WS
		// (code 1006). Closing forces a full OutgoingConnection teardown + cold-start of
		// the next utterance (clipped post-pause burst, lost context, churn). #94 instead
		// made this a no-op, but then the trailing utterance before a pause/mute was never
		// finalized once audio stopped.
		//
		// Finalization is driven by `endpointing`: xAI's VAD emits speech_final once it
		// sees `endpointing` ms of silence in the audio. When the client stops sending
		// (pause/mute) no further frames arrive, so the VAD never crosses the threshold.
		// We bridge that by injecting a short tail of digital silence — enough to exceed
		// the endpointing window — which makes xAI finalize the pending utterance while
		// the WS stays open for the next one. (Same idea as jitsi/skynet's idle flush
		// worker, adapted: we can't force-transcribe xAI's model locally.)
		if (!this.ws || this.status !== 'connected') {
			return;
		}
		if (this.turnEndedSinceAudio) {
			// xAI already ended the turn after the last audio we sent (a speech_final that left
			// nothing to emit, e.g. because the long-turn cap had emitted it all, clears no idle
			// timer in the owner). There is nothing left to finalize.
			logger.debug(`Skipping idle silence for tag ${this.tag}: the turn already ended after the last audio`);
			return;
		}
		const endpointingMs = this.backendConfig?.xaiEndpointing ?? config.xai.endpointing;
		const silenceMs = endpointingMs + XAI_IDLE_SILENCE_MARGIN_MS;
		// Signed 16-bit mono PCM (2 bytes/sample) at the stream rate; a zero-filled buffer is silence.
		const silence = Buffer.alloc(Math.round((XAI_SAMPLE_RATE * silenceMs) / 1000) * 2);
		try {
			this.ws.send(silence);
			logger.debug(`Injected ${silenceMs}ms idle silence to flush xAI final (WS kept open) for tag ${this.tag}`);
		} catch (error) {
			logger.error(`Failed to inject idle silence for tag ${this.tag}`, error);
		}
		this.armIdleTurnEnd(silenceMs + XAI_IDLE_TURN_END_GRACE_MS);
	}

	/**
	 * End a turn in progress if xAI answers the idle silence with no speech_final. Otherwise the
	 * turn — and what the long-turn cap recorded as emitted from it — would stay open across the
	 * silence: every segment the speaker commits minutes later would go out at once as past the
	 * cap, and the next speech_final would be aligned against the stale record. What xAI committed
	 * is flushed; interim text it never committed is lost, as it always was without a speech_final.
	 * New audio cancels this (the speaker resumed); so does the turn ending any other way.
	 */
	private armIdleTurnEnd(delayMs: number): void {
		this.clearIdleTurnEnd();
		if (this.turnStartedAt === undefined) return;
		this.idleTurnEndTimer = setTimeout(() => {
			this.idleTurnEndTimer = undefined;
			if (this.status !== 'connected' || this.turnStartedAt === undefined) return;
			logger.info(`xAI sent no speech_final for ${this.tag} within ${delayMs}ms of the idle silence; ending the turn`);
			this.flushHeldSegments(this.lastLanguage, 'ended on idle without speech_final', false);
			this.resetTurn();
			this.turnEndedSinceAudio = true;
		}, delayMs);
		unrefTimer(this.idleTurnEndTimer);
	}

	private clearIdleTurnEnd(): void {
		if (this.idleTurnEndTimer) {
			clearTimeout(this.idleTurnEndTimer);
			this.idleTurnEndTimer = undefined;
		}
	}

	updatePrompt(_prompt: string): void {
		// xAI STT does not support dynamic prompt updates via the streaming API
		logger.warn(`Cannot update prompt for ${this.tag}: xAI STT does not support dynamic prompts`);
	}

	close(): void {
		logger.debug(`Closing xAI backend for tag: ${this.tag}`);
		this.clearGranularTimer();
		// A held segment is committed text that nothing else will ever emit. Flush it if the owner
		// is still listening: after xAI closed the socket under us it is; on an owner-driven close
		// the callbacks are already detached, and there is nobody to send it to.
		if (this.onCompleteTranscription) this.flushHeldSegments(this.lastLanguage, 'closed while a segment was held');
		this.resetTurn();
		// If connect() is between attempts, stop it waiting; status is set below and the
		// loop bails on the next check.
		this.abortConnectWait?.();
		// Null callbacks before tearing down the socket so events fired during/after
		// ws.close() (and any re-entrant close() call) are dropped; onClosed fires once.
		const onClosed = this.onClosed;
		this.onClosed = undefined;
		this.onError = undefined;
		this.ws?.close();
		this.ws = undefined;
		this.status = 'closed';
		onClosed?.();
	}

	getStatus(): 'pending' | 'connected' | 'failed' | 'closed' {
		return this.status;
	}

	getDesiredAudioFormat(_inputFormat: AudioFormat): AudioFormat {
		return { encoding: 'l16', sampleRate: XAI_SAMPLE_RATE };
	}

	private async handleMessage(data: any): Promise<void> {
		let parsedMessage: any;
		try {
			let messageText: string | undefined;
			if (typeof data === 'string') {
				messageText = data;
			} else if (data instanceof ArrayBuffer) {
				messageText = textDecoder.decode(data);
			} else if (Buffer.isBuffer(data)) {
				messageText = data.toString('utf-8');
			} else if (data instanceof Blob) {
				messageText = await data.text();
			} else if (typeof data === 'object' && data !== null) {
				parsedMessage = data;
			} else {
				logger.error(`Unsupported message data type for tag ${this.tag}: ${typeof data}`);
				return;
			}

			if (!parsedMessage && messageText) {
				parsedMessage = JSON.parse(messageText);
			}

			logger.debug(`xAI event for ${this.tag}: ${JSON.stringify(parsedMessage)}`);
		} catch (parseError) {
			logger.error(`Failed to parse xAI message as JSON for tag ${this.tag}:`, parseError);
			return;
		}

		const type = parsedMessage?.type;
		if (type === 'transcript.partial') {
			this.handlePartial(parsedMessage);
		} else if (type === 'transcript.done') {
			this.handleDone(parsedMessage);
		} else if (type === 'error') {
			logger.error(`xAI API error for ${this.tag} (requestId=${this.requestId ?? 'none'}): ${JSON.stringify(parsedMessage)}`);
			const message: string = parsedMessage.message || JSON.stringify(parsedMessage);
			// xAI closes the ASR stream after a stretch of silence/inactivity. The exact
			// message observed on wss://api.x.ai/v1/stt (2026-06-16) is:
			//   {type:"error", message:"ASR stream timed out"}
			// This is a transient, stream-level condition for a still-active participant,
			// so we flag it recoverable and OutgoingConnection reopens the stream in place
			// instead of dropping the participant (JIT-15901).
			// NOTE: the match is on the message text. If xAI changes the wording this
			// silently reverts to the fatal path. The full parsedMessage is logged at
			// error level just above, so if the "ASR stream timed out" error rate climbs
			// after an xAI API change, audit that log and update this matcher.
			const recoverable = /timed out/i.test(message);
			// Before onError: the owner detaches our callbacks inside it, so a segment still held
			// (committed by xAI, never speech_final'd) would otherwise be lost with the stream.
			this.flushHeldSegments(this.lastLanguage, 'errored while a segment was held');
			writeMetric(undefined, {
				name: 'xai_api_error',
				worker: 'opus-transcriber-proxy',
				errorType: recoverable ? 'stream_timeout' : 'api_error',
			});
			this.onError?.('api_error', message, recoverable);
			this.close();
		} else {
			logger.debug(`Unhandled xAI message type for ${this.tag}: ${type}`);
		}
	}

	private handlePartial(msg: any): void {
		const text: string = msg.text ?? '';
		const language: string | undefined = msg.language || undefined;

		// Roll-own granular finalization: commit a stable prefix of the growing hypothesis
		// incrementally so a long turn interleaves in order with other speakers' acks. Never set
		// on the diarized path (it needs per-speaker hypotheses).
		if (this.segmenter) {
			if (!text.trim()) return;
			this.handlePartialGranular(text, msg.is_final === true, msg.speech_final === true, language);
			return;
		}

		// Default (one final per turn): within a turn xAI commits segments with is_final=true
		// (text resets after each), and speech_final=true ends the turn carrying the whole turn's
		// text — normally the only final. transcript.done fires at stream end, usually empty.
		// An empty speech_final still ends the turn: otherwise a segment held from it, or the
		// count of what was already emitted, would leak into the next turn.
		if (msg.speech_final === true) {
			this.endTurn(text, msg.words, language);
			return;
		}
		if (!text.trim()) return;
		if (language) this.lastLanguage = language;

		this.startTurn();
		if (msg.is_final === true && this.commitSegment(text, msg.words, language)) {
			// The segment just went out as a final; an interim of the same text would follow it.
			return;
		}
		this.emitText(text, msg.words, language, true);
	}

	/**
	 * Mark the start of a turn on its first partial and, if the long-turn cap is on, arm a timer
	 * for it. A segment committed inside the cap waits for the next commit or the speech_final;
	 * if neither comes (the speaker stopped, and xAI sent no speech_final) the timer flushes it
	 * once the turn reaches the cap instead of stranding it until the stream closes.
	 */
	private startTurn(): void {
		if (this.turnStartedAt !== undefined) return;
		this.turnStartedAt = Date.now();
		const maxTurnMs = config.xai.maxTurnMs;
		if (!(maxTurnMs > 0)) return;
		this.turnTimer = setTimeout(() => {
			this.turnTimer = undefined;
			if (this.status !== 'connected') return;
			if (this.pendingSegments.length === 0) {
				// Nothing to emit: xAI committed no segment (is_final) in a whole cap's worth of
				// turn. Said out loud so a run with no finals can be told apart from one where the
				// cap never had anything to flush.
				logger.info(`xAI turn for ${this.tag} reached ${maxTurnMs}ms with no committed segment and no speech_final`);
				return;
			}
			this.flushHeldSegments(this.lastLanguage, `reached ${maxTurnMs}ms without speech_final`);
		}, maxTurnMs);
		unrefTimer(this.turnTimer);
	}

	/**
	 * Hold a segment xAI committed (is_final) until the turn ends. If the turn has already run
	 * past maxTurnMs, emit everything held as a final now instead of waiting for a speech_final
	 * that may never come. Returns true when it emitted.
	 */
	private commitSegment(text: string, words: any[] | undefined, language: string | undefined): boolean {
		this.pendingSegments.push({ text, words: Array.isArray(words) && words.length > 0 ? words : undefined });

		const maxTurnMs = config.xai.maxTurnMs;
		const turnAgeMs = Date.now() - (this.turnStartedAt ?? Date.now());
		logger.debug(
			`xAI committed a segment for ${this.tag} (turn age ${turnAgeMs}ms, ${this.pendingSegments.length} held)`,
		);
		if (!(maxTurnMs > 0) || turnAgeMs < maxTurnMs) return false;

		// A partial need not carry `language`; the early final should still say what language it is.
		this.flushHeldSegments(language ?? this.lastLanguage, `is ${turnAgeMs}ms old without speech_final`);
		return true;
	}

	/**
	 * Emit everything held as one final (split per speaker when diarized) and record it as
	 * emitted, so the turn's speech_final emits only the rest. No-op when nothing is held.
	 * `midUtterance` is false only when the turn is over: an early final leaves the utterance
	 * unfinished, and the owner must keep its idle force-commit armed to finalize the rest.
	 */
	private flushHeldSegments(language: string | undefined, reason: string, midUtterance = true): void {
		if (this.pendingSegments.length === 0) return;
		const segments = this.pendingSegments;
		this.pendingSegments = [];
		const segmentText = segments.map((s) => s.text.trim()).join(' ');
		// A segment xAI sent without `words` still belongs to the turn's speaker: its text stands in
		// as unlabelled words, which emitDiarized gives to the speaker before them.
		const segmentWords = segments.some((s) => s.words)
			? segments.flatMap((s) => s.words ?? splitWords(s.text).map((text) => ({ text })))
			: undefined;
		logger.debug(`xAI turn for ${this.tag} ${reason}; emitting ${segments.length} committed segment(s) as a final`);
		// Recorded in the units the speech_final will be aligned in: `words` entries when diarized,
		// the text's words otherwise.
		if (this.isDiarizedWords(segmentWords)) {
			this.emitDiarized(segmentWords!, language, false, this.emitted.speaker, midUtterance);
			this.recordEmitted(entryAlignWords(segmentWords!), segmentText, lastSpeaker(segmentWords!));
		} else {
			this.emitText(segmentText, segmentWords, language, false, midUtterance);
			this.recordEmitted(textAlignWords(segmentText), segmentText);
		}
	}

	private recordEmitted(words: AlignWord[], text: string, speaker?: number): void {
		const emitted = this.emitted;
		const normalized = words.map((w) => w.norm);
		emitted.count += normalized.length;
		emitted.head = [...emitted.head, ...normalized].slice(0, TURN_ALIGN_ANCHOR_WORDS);
		emitted.tail = [...emitted.tail, ...normalized].slice(-TURN_ALIGN_ANCHOR_WORDS);
		emitted.tailText = `${emitted.tailText} ${text}`.slice(-TURN_LOG_TAIL_CHARS);
		if (speaker !== undefined) emitted.speaker = speaker;
	}

	/**
	 * End the turn on speech_final (or a transcript.done at stream end). Emits the whole turn,
	 * exactly as before the long-turn cap existed, unless part of it already went out early — then
	 * only the rest. The rest is aligned in the same units it is cut in: the `words` entries when
	 * diarized, the text's words otherwise.
	 */
	private endTurn(text: string, words: any[] | undefined, language: string | undefined): void {
		if (!text.trim()) {
			// xAI has nothing more for this turn, so what it committed is all there is.
			this.flushHeldSegments(language ?? this.lastLanguage, 'ended with an empty speech_final', false);
		} else if (this.emitted.count === 0) {
			this.emitText(text, words, language, false);
		} else if (this.isDiarizedWords(words)) {
			const entries = entryAlignWords(words!);
			const { start, match } = alignTurnRest(entries.map((w) => w.norm), this.emitted);
			this.warnUnalignedRest(match, entries.length, text);
			const restAt = start < entries.length ? entries[start].at : words!.length;
			const rest = words!.slice(restAt);
			// A rest that starts on an unlabelled word continues the speaker it was emitted under.
			const priorSpeaker = lastSpeaker(words!.slice(0, restAt)) ?? this.emitted.speaker;
			if (rest.length > 0) this.emitDiarized(rest, language ?? this.lastLanguage, false, priorSpeaker);
		} else {
			const textWords = textAlignWords(text);
			const { start, match } = alignTurnRest(textWords.map((w) => w.norm), this.emitted);
			this.warnUnalignedRest(match, textWords.length, text);
			if (start < textWords.length) {
				// Cut the original text rather than re-joining words, which would put spaces into a
				// language written without them. `words` only supplies confidence here, and lines up
				// with the text only when the counts agree.
				const restWords = Array.isArray(words) && words.length === textWords.length ? words.slice(start) : undefined;
				this.emitText(text.slice(textWords[start].at).trim(), restWords, language ?? this.lastLanguage, false);
			}
		}
		this.resetTurn();
		this.turnEndedSinceAudio = true;
	}

	/**
	 * The fallbacks in alignTurnRest can drop or repeat words, so say when one was taken. Counts
	 * only at warn: transcript text goes to the log pipeline at debug only.
	 */
	private warnUnalignedRest(match: 'anchor' | 'count' | 'tail', fullWords: number, text: string): void {
		if (match === 'anchor') return;
		if (match === 'tail') {
			logger.warn(
				`xAI speech_final for ${this.tag} (${fullWords} words) neither contains the last words already emitted for the turn nor starts with its first words; emitting it whole as the rest of the turn (${this.emitted.count} words already emitted)`,
			);
		} else {
			const nothingLeft =
				fullWords <= this.emitted.count
					? `; it carries ${fullWords} words but ${this.emitted.count} were already emitted, so nothing more is emitted`
					: '';
			logger.warn(
				`xAI speech_final for ${this.tag} does not contain the last words already emitted for the turn; falling back to dropping ${this.emitted.count} words by count${nothingLeft}`,
			);
		}
		logger.debug(`xAI turn reconciliation for ${this.tag}: emitted "…${this.emitted.tailText}"; speech_final "${text}"`);
	}

	private resetTurn(): void {
		if (this.turnTimer) {
			clearTimeout(this.turnTimer);
			this.turnTimer = undefined;
		}
		this.clearIdleTurnEnd();
		this.turnStartedAt = undefined;
		this.pendingSegments = [];
		this.emitted = emptyEmittedTurn();
	}

	/** Diarization re-splits per speaker, when the words carry speaker labels. */
	private isDiarizedWords(words: any[] | undefined): boolean {
		return config.xai.diarize && Array.isArray(words) && words.some((w) => w?.speaker !== undefined);
	}

	private emitText(
		text: string,
		words: any[] | undefined,
		language: string | undefined,
		isInterim: boolean,
		midUtterance = false,
	): void {
		if (this.isDiarizedWords(words)) {
			this.emitDiarized(words!, language, isInterim, undefined, midUtterance);
			return;
		}
		const confidence = this.avgConfidence(words);
		const transcript = config.xai.includeLanguage && language && !isInterim ? `${text} [${language}]` : text;
		const message = this.createMessage(transcript, confidence, Date.now(), randomUUID(), isInterim, undefined, language);
		if (isInterim) {
			this.onInterimTranscription?.(message);
		} else {
			this.onCompleteTranscription?.(message, midUtterance);
		}
	}

	/**
	 * Granular path: feed the partial to the segmenter, emit any newly committed segments as
	 * finals and the remainder as an interim, then (re)arm a timer so a now-stable prefix still
	 * commits if the speaker pauses and interims stop arriving. speech_final flushes the trailing
	 * remainder and ends the turn (the segmenter reconciles it against what was already committed,
	 * so the whole-turn re-emit is NOT reprinted).
	 */
	private handlePartialGranular(
		text: string,
		isFinalSeg: boolean,
		speechFinal: boolean,
		language: string | undefined,
	): void {
		if (language) this.lastLanguage = language;
		const result = this.segmenter!.pushPartial(text, isFinalSeg, speechFinal, Date.now());
		this.emitGranular(result, language ?? this.lastLanguage);
		if (result.endOfTurn) {
			// Turn ended (the segmenter already reset its per-turn state inside endTurn); just stop
			// the pending flush timer — there is nothing left to flush for this turn.
			this.clearGranularTimer();
			this.turnEndedSinceAudio = true;
		} else {
			this.scheduleGranularFlush();
		}
	}

	/**
	 * Emit committed segments as finals and the in-progress remainder as a single interim.
	 *
	 * Granular emissions deliberately carry NO confidence. A committed segment is a stable prefix
	 * reconstructed across MANY transcript.partial events, so no single partial's per-word
	 * confidence corresponds to it (and the timer/pause path has no partial at all). Attaching the
	 * current partial's average would be misleading, so we omit it — createMessage drops the field
	 * when confidence is undefined.
	 *
	 * Commits made before the end of the turn are mid-utterance: xAI has not finalized the audio
	 * behind them, so the owner keeps its idle force-commit armed to flush the rest after a pause.
	 */
	private emitGranular(result: GranularResult, language: string | undefined): void {
		for (const segment of result.commits) {
			const transcript = config.xai.includeLanguage && language ? `${segment} [${language}]` : segment;
			this.onCompleteTranscription?.(
				this.createMessage(transcript, undefined, Date.now(), randomUUID(), false, undefined, language),
				!result.endOfTurn,
			);
		}
		if (result.interim) {
			this.onInterimTranscription?.(
				this.createMessage(result.interim, undefined, Date.now(), randomUUID(), true, undefined, language),
			);
		}
	}

	/**
	 * Arm a single timer to fire when the next word becomes freeze-eligible. The per-partial
	 * freeze handles active speech; this timer covers the case where interims stop (a pause)
	 * before the held prefix has aged past the stability window.
	 */
	private scheduleGranularFlush(): void {
		this.clearGranularTimer();
		if (!this.segmenter) return;
		const due = this.segmenter.nextDueTime();
		if (due == null) return;
		const delay = Math.max(0, due - Date.now());
		this.granularTimer = setTimeout(() => {
			this.granularTimer = undefined;
			if (!this.segmenter || this.status !== 'connected') return;
			const result = this.segmenter.flushDue(Date.now());
			if (result.commits.length > 0 || result.interim) {
				this.emitGranular(result, this.lastLanguage);
			}
			this.scheduleGranularFlush();
		}, delay);
		unrefTimer(this.granularTimer);
	}

	private clearGranularTimer(): void {
		if (this.granularTimer) {
			clearTimeout(this.granularTimer);
			this.granularTimer = undefined;
		}
	}

	private handleDone(msg: any): void {
		const text: string = msg.text ?? '';
		const language: string | undefined = msg.language || undefined;

		// Granular mode: transcript.done re-emits the whole turn at stream end. If a turn is still
		// in progress (ended by the stream closing rather than a speech_final) flush only its
		// uncommitted tail; if the turn already ended via speech_final, ignore it (re-emitting the
		// whole turn would duplicate what was already committed).
		if (this.segmenter) {
			if (!text.trim()) return;
			if (this.segmenter.hasActiveTurn()) {
				const result = this.segmenter.pushPartial(text, true, true, Date.now());
				this.emitGranular(result, language ?? this.lastLanguage);
			}
			this.clearGranularTimer();
			return;
		}

		// A stream that ends mid-turn: flush the turn, minus anything the long-turn cap already
		// emitted. An empty one (the usual stream-end notification) still ends a turn in progress,
		// like an empty speech_final: it flushes what xAI committed and stops the cap timer. With no
		// turn in progress, a turn that ended after the last audio sent is all it can be repeating,
		// so it is ignored; otherwise its text was never seen in a partial and is emitted.
		if (this.turnStartedAt === undefined && this.turnEndedSinceAudio) {
			if (text.trim()) logger.debug(`Ignoring xAI transcript.done for ${this.tag}: the turn already ended after the last audio`);
			return;
		}
		this.endTurn(text, msg.words, language);
	}

	/**
	 * Emit the words as one message per run of consecutive same-speaker words. A word with no
	 * `speaker` belongs to the speaker of the word before it: since 2026-09-19 xAI's committed
	 * segments (is_final) often leave their trailing words unlabelled while the speech_final
	 * labels every word, and treating "no label" as a speaker change would cut one sentence into
	 * two finals, the second with no speaker at all. Leading unlabelled words take `priorSpeaker`
	 * (the speaker the words before this slice were emitted under), else the first label found.
	 */
	private emitDiarized(
		words: any[],
		language: string | undefined,
		isInterim: boolean,
		priorSpeaker?: number,
		midUtterance = false,
	): void {
		const segments: Array<{ speaker: number; words: any[] }> = [];
		let current: number | undefined = priorSpeaker ?? words.find((w) => w?.speaker !== undefined)?.speaker;
		for (const word of words) {
			const speaker: number = word.speaker ?? current;
			current = speaker;
			const last = segments[segments.length - 1];
			if (last && last.speaker === speaker) {
				last.words.push(word);
			} else {
				segments.push({ speaker, words: [word] });
			}
		}

		const languageSuffix = config.xai.includeLanguage && language ? ` [${language}]` : '';
		const now = Date.now();

		for (const segment of segments) {
			let text = segment.words
				.map((w: any) => w.punctuated_word ?? w.text)
				.join(' ')
				.trim();

			if (!text) continue;
			if (languageSuffix) text += languageSuffix;

			const confidence = this.avgConfidence(segment.words);

			logger.debug(
				`Received ${isInterim ? 'interim' : 'final'} transcription from xAI for ${this.tag} speaker ${segment.speaker}: ${text}`,
			);

			const message = this.createMessage(text, confidence, now, randomUUID(), isInterim, segment.speaker, language);
			if (isInterim) {
				this.onInterimTranscription?.(message);
			} else {
				this.onCompleteTranscription?.(message, midUtterance);
			}
		}
	}

	private avgConfidence(words: any[] | undefined): number | undefined {
		if (!Array.isArray(words) || words.length === 0) return undefined;
		const vals = words.map((w: any) => w.confidence).filter((c: any) => typeof c === 'number');
		if (vals.length === 0) return undefined;
		return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
	}

	private createMessage(
		transcript: string,
		confidence: number | undefined,
		timestamp: number,
		message_id: string,
		isInterim: boolean,
		speaker?: number,
		language?: string,
	): TranscriptionMessage {
		return {
			transcript: [
				{
					...(confidence !== undefined && { confidence }),
					text: transcript,
				},
			],
			is_interim: isInterim,
			message_id,
			type: 'transcription-result',
			event: 'transcription-result',
			participant: this.participantInfo,
			timestamp,
			...(speaker !== undefined && { speaker }),
			...(language !== undefined && { language }),
		};
	}
}
