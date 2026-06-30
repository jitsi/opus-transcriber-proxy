import logger from './logger';
import { config } from './config';

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
 * Disabled (no-op) when TRANSLATION_USAGE_URL is unset, so dev/replay runs and
 * deployments without the reporting endpoint configured cost nothing.
 */

export interface TranslationUsageEvent {
	/** Bearer token from the connection; the receiving service resolves it. */
	token: string;
	/** Seconds of audio translated for this direction. */
	durationSeconds: number;
	/** ISO target language (for logging only; the endpoint bills on duration). */
	targetLanguage: string;
}

const FLUSH_MAX_EVENTS = 50;
const FLUSH_MAX_AGE_MS = 1000;

let buffer: TranslationUsageEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let warnedUnconfigured = false;

/**
 * Queue one direction's translated duration for reporting. Cheap and synchronous;
 * the actual POST happens on the next flush. Silently ignores events with no token
 * (e.g. the dev/replay `?lang=` path) or non-positive duration.
 */
export function reportTranslationUsage(event: TranslationUsageEvent): void {
	if (!config.translationUsage.url) {
		if (!warnedUnconfigured) {
			warnedUnconfigured = true;
			logger.warn('TRANSLATION_USAGE_URL not set; translation usage will not be reported');
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
		// Don't keep the process alive solely for a pending flush.
		flushTimer.unref?.();
	}
}

/** Flush all buffered events now (used on a timer and at shutdown). */
export async function flushTranslationUsage(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (buffer.length === 0) return;

	const batch = buffer;
	buffer = [];

	// Each POST authenticates with a single `tt_` token, so group by token.
	const byToken = new Map<string, TranslationUsageEvent[]>();
	for (const ev of batch) {
		const arr = byToken.get(ev.token);
		if (arr) arr.push(ev);
		else byToken.set(ev.token, [ev]);
	}

	await Promise.all([...byToken].map(([token, events]) => postBatch(token, events)));
}

async function postBatch(token: string, events: TranslationUsageEvent[]): Promise<void> {
	try {
		const response = await fetch(config.translationUsage.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
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
		logger.error('translation usage report error:', err instanceof Error ? err.message : String(err));
	}
}
