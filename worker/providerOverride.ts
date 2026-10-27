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
 * Operator-controlled transcription provider override, read from Workers KV.
 *
 * Why this exists: the container picks its provider from `PROVIDERS_PRIORITY`, a Worker variable
 * baked into the container's environment at container start. Changing it needs a Worker release,
 * which is too slow during a provider outage. This path instead rewrites the `provider` URL
 * parameter per connection, which the container already understands, so an operator can move new
 * sessions to a secondary provider with one `wrangler kv key put` and no release.
 *
 * Two rules are load-bearing:
 *
 * 1. **An explicit `provider` parameter is never overridden.** A caller that names a provider has
 *    made a deliberate choice (a test rig, a pinned monitor, or `openai_custom`, which carries the
 *    customer's own endpoint and their own API key). Overriding that would route a customer's audio
 *    to a provider they did not choose.
 *
 * 2. **Every rejection degrades to "no override", never to a broken session.** The container closes
 *    the socket with 1002 when it is handed an invalid or unavailable provider, so a typo in KV
 *    would otherwise take all transcription down. Each check below falls back to the configured
 *    default instead.
 *
 * The override is temporary by design: an entry must carry an expiry, and the expiry is checked
 * here at read time rather than being left to KV's own expiration (which the edge cache can lag).
 * When it lapses, new sessions go back to the configured default, which re-tests the primary
 * provider automatically — no operator has to remember to switch back.
 */

/**
 * Providers an override may select. `openai_custom` and `dummy` are deliberately excluded:
 * `openai_custom` is meaningless without the per-request URL and key that only the caller can
 * supply, and `dummy` produces no real transcription.
 */
export const OVERRIDABLE_PROVIDERS = ['openai', 'deepgram', 'gemini', 'xai'] as const;

export type OverridableProvider = (typeof OVERRIDABLE_PROVIDERS)[number];

/** KV key holding the override for the `/transcribe` path. */
export const PROVIDER_OVERRIDE_KEY = 'transcribe:provider-override';

/**
 * Longest window an override may ask for. A longer one is refused outright rather than clamped:
 * the point of the cap is to force an operator to re-arm (and so to re-check the primary), and
 * silently shortening a 7-day request to 24h would look like it had been accepted as asked.
 */
export const MAX_OVERRIDE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Edge-cache TTL for the KV read. Costs up to this long for a newly written override to take
 * effect at a given colo, which is well inside the response time of an outage, and keeps the read
 * off the KV origin for the overwhelming majority of connections.
 */
export const OVERRIDE_CACHE_TTL_SECONDS = 60;

/** The minimal KV surface this module needs. Keeps the module easy to fake in tests. */
export interface ProviderOverrideKv {
	get(key: string, options: { type: 'json'; cacheTtl?: number }): Promise<unknown>;
}

/** Just enough of the Worker env to resolve an override. */
export interface ProviderOverrideEnv {
	CONFIG_KV?: ProviderOverrideKv;
	OPENAI_API_KEY?: string;
	DEEPGRAM_API_KEY?: string;
	GEMINI_API_KEY?: string;
	XAI_API_KEY?: string;
}

export type OverrideDecision =
	| { applied: true; provider: OverridableProvider; until: number; reason?: string }
	| { applied: false; level: 'debug' | 'info' | 'error'; why: string };

function isOverridableProvider(value: unknown): value is OverridableProvider {
	return typeof value === 'string' && (OVERRIDABLE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Whether the deployment has the credential this provider needs. Mirrors the container's own
 * `isProviderAvailable`, evaluated against the Worker env (which holds the same secrets it
 * forwards to the container). Without this check an override naming a provider whose key is unset
 * would close every session with 1002.
 */
export function providerIsConfigured(env: ProviderOverrideEnv, provider: OverridableProvider): boolean {
	switch (provider) {
		case 'openai':
			return !!env.OPENAI_API_KEY;
		case 'deepgram':
			return !!env.DEEPGRAM_API_KEY;
		case 'gemini':
			return !!env.GEMINI_API_KEY;
		case 'xai':
			return !!env.XAI_API_KEY;
	}
}

/**
 * Decide what a KV entry means, with no I/O. `raw` is whatever the KV read produced (already
 * JSON-parsed, so `null` covers both "no such key" and "stored null").
 */
export function decideProviderOverride(
	raw: unknown,
	opts: {
		hasProviderParam: boolean;
		isConfigured: (provider: OverridableProvider) => boolean;
		now: number;
	},
): OverrideDecision {
	// Rule 1: an explicit parameter always wins. Checked before the entry is even inspected, so a
	// malformed entry cannot produce a misleading error log for a connection it could never affect.
	if (opts.hasProviderParam) {
		return { applied: false, level: 'debug', why: 'request names a provider explicitly' };
	}

	if (raw === null || raw === undefined) {
		return { applied: false, level: 'debug', why: 'no override set' };
	}

	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { applied: false, level: 'error', why: `override is not a JSON object (got ${typeof raw})` };
	}

	const entry = raw as Record<string, unknown>;

	if (!isOverridableProvider(entry.provider)) {
		return {
			applied: false,
			level: 'error',
			why: `override names an unusable provider: ${JSON.stringify(entry.provider)}. Valid: ${OVERRIDABLE_PROVIDERS.join(', ')}`,
		};
	}
	const provider = entry.provider;

	// An entry with no expiry is refused rather than treated as permanent. "Forever" is exactly the
	// state this mechanism is meant to make impossible.
	if (typeof entry.until !== 'number' || !Number.isFinite(entry.until)) {
		return { applied: false, level: 'error', why: `override has no usable "until" timestamp (got ${JSON.stringify(entry.until)})` };
	}
	const until = entry.until;

	if (opts.now >= until) {
		return { applied: false, level: 'info', why: `override expired at ${new Date(until).toISOString()}` };
	}

	if (until - opts.now > MAX_OVERRIDE_WINDOW_MS) {
		return {
			applied: false,
			level: 'error',
			why: `override window exceeds the ${MAX_OVERRIDE_WINDOW_MS}ms cap (until ${new Date(until).toISOString()})`,
		};
	}

	if (!opts.isConfigured(provider)) {
		return { applied: false, level: 'error', why: `override names provider '${provider}', which has no API key configured` };
	}

	const reason = typeof entry.reason === 'string' ? entry.reason : undefined;
	return { applied: true, provider, until, reason };
}

/**
 * Read the override from KV and decide whether it applies to this request.
 *
 * A KV failure is swallowed deliberately: an optional operator convenience must never stop a call
 * from being set up.
 */
export async function resolveProviderOverride(request: Request, env: ProviderOverrideEnv, now: number = Date.now()): Promise<OverrideDecision> {
	const hasProviderParam = new URL(request.url).searchParams.has('provider');

	// Checked before the KV read so an explicitly-pinned connection costs nothing.
	if (hasProviderParam) {
		return { applied: false, level: 'debug', why: 'request names a provider explicitly' };
	}

	if (!env.CONFIG_KV) {
		return { applied: false, level: 'debug', why: 'CONFIG_KV binding is not configured' };
	}

	let raw: unknown;
	try {
		raw = await env.CONFIG_KV.get(PROVIDER_OVERRIDE_KEY, { type: 'json', cacheTtl: OVERRIDE_CACHE_TTL_SECONDS });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { applied: false, level: 'error', why: `KV read failed: ${msg}` };
	}

	return decideProviderOverride(raw, {
		hasProviderParam,
		isConfigured: (provider) => providerIsConfigured(env, provider),
		now,
	});
}

/**
 * Return a copy of the request with the `provider` parameter set. The container reads this
 * parameter already, so the override needs no container-side change at all.
 *
 * Copying from the original request preserves the `Upgrade: websocket` header and the body, which
 * is what keeps the WebSocket handshake intact through the rewrite.
 */
export function applyProviderOverride(request: Request, provider: OverridableProvider): Request {
	const url = new URL(request.url);
	url.searchParams.set('provider', provider);
	return new Request(url.toString(), request);
}

/** One-line description of a decision, for the Worker log. */
export function describeOverrideDecision(decision: OverrideDecision): string {
	if (decision.applied) {
		const reason = decision.reason ? `, reason=${decision.reason}` : '';
		return `Provider override applied: provider=${decision.provider}, until=${new Date(decision.until).toISOString()}${reason}`;
	}
	return `Provider override not applied: ${decision.why}`;
}
