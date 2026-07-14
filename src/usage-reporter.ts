import type { Logger } from './translate/runtime';

/**
 * Live audio-translation usage reporter.
 *
 * Each translated direction (one TranslatorConnection = one source→language
 * stream) reports its translated audio duration on close. We coalesce those
 * reports and POST them to a configured usage-reporting endpoint, authenticating
 * each request with the bearer token the JVB forwarded to us on the connection
 * (the `X-Translation-Token` header). The receiving service is responsible for
 * resolving that token and recording the usage.
 *
 * Batching: flush at 50 buffered events or 1000 ms, whichever comes first.
 * Best-effort — a dropped flush loses at most a second of buffered reports,
 * which is acceptable for metering.
 *
 * Disabled (no-op) when the usage URL is unset, so dev/replay runs and
 * deployments without the reporting endpoint configured cost nothing.
 *
 * Runtime-agnostic: this module imports no Node-only APIs (no config, no logger,
 * no `node:*`). The url and a Logger are injected per report via `deps`, so it is
 * safe to bundle into both the Node container and the Cloudflare Worker.
 */

export interface TranslationUsageEvent {
	/** Bearer token from the connection; the receiving service resolves it. */
	token: string;
	/** Seconds of audio translated for this direction. */
	durationSeconds: number;
	/** ISO target language — local logging only; NOT included in the POST body. */
	targetLanguage: string;
}

/** Dependencies injected by the host runtime on each report. */
export interface UsageReporterDeps {
	/** Usage-reporting endpoint. Unset → reporting is a no-op (warn once, drop). */
	url: string | undefined;
	/** Logger surface (runtime.logger). */
	logger: Logger;
}

const FLUSH_MAX_EVENTS = 50;
const FLUSH_MAX_AGE_MS = 1000;

// These are deliberately module-level (process/isolate-wide) singletons, shared across every
// concurrent connection rather than per-connection. That is intentional: the usage URL
// (`translationUsageUrl`) is a deployment-wide constant, so a single stashed url+logger is always
// correct, and batching events from concurrent connections into one flush is the whole point (fewer
// POSTs, grouped by token). `warnedUnconfigured` likewise suppresses the "no URL" warning for the
// lifetime of the process/isolate rather than warning per report.
let buffer: TranslationUsageEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let warnedUnconfigured = false;
// Stashed from the latest report so a timer/shutdown flush can POST without its own deps.
let reportUrl: string | undefined;
let reportLogger: Logger | null = null;

/**
 * Queue one direction's translated duration for reporting. Cheap and synchronous;
 * the actual POST happens on the next flush. Events with no token (e.g. the
 * dev/replay `?lang=` path) or non-positive duration are dropped silently. When a
 * token IS present but the usage URL is unset, we warn once and drop.
 */
export function reportTranslationUsage(event: TranslationUsageEvent, deps: UsageReporterDeps): void {
	// Stash the latest url+logger so a later timer/shutdown flush can POST on its own.
	reportUrl = deps.url;
	reportLogger = deps.logger;

	if (!deps.url) {
		if (!warnedUnconfigured) {
			warnedUnconfigured = true;
			deps.logger.warn('translation usage URL not set; translation usage will not be reported');
		}
		return;
	}
	if (!event.token) return; // dev/replay path or ungated session — nothing to attribute
	if (!(event.durationSeconds > 0)) return;

	buffer.push(event);
	if (buffer.length >= FLUSH_MAX_EVENTS) {
		void flushTranslationUsage();
	} else if (!flushTimer) {
		flushTimer = setTimeout(() => void flushTranslationUsage(), FLUSH_MAX_AGE_MS);
		// Don't keep the process alive solely for a pending flush. `unref` exists on Node's Timeout but
		// not on the Worker's numeric timer id, so probe for it (the cast bridges both return types).
		(flushTimer as unknown as { unref?: () => void }).unref?.();
	}
}

/** Test-only: clear module-level state between cases. */
export function _resetForTesting(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	buffer = [];
	warnedUnconfigured = false;
	reportUrl = undefined;
	reportLogger = null;
}

/** Flush all buffered events now (used on a timer and at shutdown). */
export async function flushTranslationUsage(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (buffer.length === 0) return;

	const url = reportUrl;
	const logger = reportLogger;
	if (!url || !logger) {
		// Should not happen (events are only buffered when a url was present), but stay defensive.
		buffer = [];
		return;
	}

	const batch = buffer;
	buffer = [];

	// Each POST authenticates with a single token, so group by token.
	const byToken = new Map<string, TranslationUsageEvent[]>();
	for (const ev of batch) {
		const arr = byToken.get(ev.token);
		if (arr) arr.push(ev);
		else byToken.set(ev.token, [ev]);
	}

	await Promise.all([...byToken].map(([token, events]) => postBatch(url, token, events, logger)));
}

// Bound each POST so a slow/unreachable endpoint can't stall the process — notably
// at SIGTERM, where flushTranslationUsage() is awaited during shutdown.
const POST_TIMEOUT_MS = 5000;

async function postBatch(url: string, token: string, events: TranslationUsageEvent[], logger: Logger): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: 'POST',
			signal: controller.signal,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				// Only duration_seconds is sent; targetLanguage is local-only (see the interface).
				events: events.map((e) => ({ duration_seconds: e.durationSeconds })),
			}),
		});
		if (!response.ok) {
			logger.warn(`translation usage report failed: HTTP ${response.status}`);
			return;
		}
		const totalSeconds = events.reduce((sum, e) => sum + e.durationSeconds, 0);
		logger.debug(`reported ${events.length} translation usage event(s), ${totalSeconds.toFixed(1)}s total`);
	} catch (err) {
		logger.error('translation usage report error', err as Error);
	} finally {
		clearTimeout(timeout);
	}
}
