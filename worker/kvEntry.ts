/*
 * Copyright @ 2026 - present 8x8, Inc.
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
/**
 * The parts of an operator KV entry that every kind of override shares: the stored string is a
 * JSON object, and it carries an `until` expiry in milliseconds since the epoch. Used by the
 * provider overrides (worker/providerOverride.ts) and the config overrides
 * (worker/configOverride.ts), which differ only in the rest of the entry and in how long an entry
 * may last.
 */

/**
 * Edge-cache TTL for the KV reads. Costs up to this long for a newly written override to take
 * effect at a given colo, which is well inside the response time of an outage, and keeps the read
 * off the KV origin for the overwhelming majority of connections.
 */
export const OVERRIDE_CACHE_TTL_SECONDS = 60;

/**
 * Smallest `until` that can be a real millisecond timestamp (2001-09-09). Anything below it is a
 * seconds-granularity value, which is the likeliest operator slip — `--ttl` on the same command
 * line takes seconds. Treating it as a merely expired override would be the worst outcome: the
 * operator believes the override is armed, it is reported at `info`, and the override quietly does
 * nothing. It is refused as malformed instead, at `error`.
 */
export const MIN_PLAUSIBLE_UNTIL_MS = 1_000_000_000_000;

/** The `until` value that means "no expiry", where an override kind allows one. */
export const INDEFINITE_UNTIL = -1;

/** Why an entry is not applied. `error` is an operator mistake that is silently doing nothing. */
export type Rejection = { level: 'debug' | 'info' | 'error'; why: string };

/**
 * Parse a stored entry into a JSON object. `raw` is the stored string, or `null` for "no such
 * key". Parsing happens here rather than in the KV read so that an operator's typo gets its own
 * "not valid JSON" message instead of being reported as a KV failure — which would send them
 * looking at infrastructure health rather than at the value they just wrote.
 */
export function parseEntryObject(raw: string | null | undefined): { entry: Record<string, unknown> } | Rejection {
	if (raw === null || raw === undefined || raw.trim() === '') {
		return { level: 'debug', why: 'no override set' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { level: 'error', why: `override is not valid JSON: ${msg}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { level: 'error', why: `override is not a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})` };
	}
	return { entry: parsed as Record<string, unknown> };
}

/**
 * Check an entry's `until`. It is mandatory: an entry with no expiry is refused rather than treated
 * as permanent, so "forever" is always a deliberate choice (`INDEFINITE_UNTIL`, where allowed) and
 * never the result of a forgotten field. Checked here at read time rather than left to KV's own
 * expiration, which the edge cache can lag.
 *
 * `maxWindowMs` refuses (does not clamp) an expiry further away than that; omitted, any future
 * expiry is accepted. Returns `undefined` when the entry may be applied.
 */
export function checkUntil(
	value: unknown,
	opts: { now: number; maxWindowMs?: number; allowIndefinite?: boolean },
): Rejection | undefined {
	const indefinite = opts.allowIndefinite ? `, or ${INDEFINITE_UNTIL} for no expiry` : '';
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return { level: 'error', why: `override has no usable "until" timestamp (got ${JSON.stringify(value)})${indefinite}` };
	}
	if (opts.allowIndefinite && value === INDEFINITE_UNTIL) {
		return undefined;
	}
	// A seconds-granularity value cannot be a legitimately expired override, so it is refused as
	// malformed rather than reported as expired — see MIN_PLAUSIBLE_UNTIL_MS.
	if (value < MIN_PLAUSIBLE_UNTIL_MS) {
		return {
			level: 'error',
			why: `override "until" is not a millisecond timestamp (got ${value}); use milliseconds since the epoch${indefinite}`,
		};
	}
	if (opts.now >= value) {
		return { level: 'info', why: `override expired at ${new Date(value).toISOString()}` };
	}
	if (opts.maxWindowMs !== undefined && value - opts.now > opts.maxWindowMs) {
		return {
			level: 'error',
			why: `override window exceeds the ${opts.maxWindowMs}ms cap (until ${new Date(value).toISOString()})`,
		};
	}
	return undefined;
}

/** The entry's free-text `reason`, when it has one. */
export function entryReason(entry: Record<string, unknown>): string | undefined {
	return typeof entry.reason === 'string' ? entry.reason : undefined;
}
