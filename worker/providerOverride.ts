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
 * Operator-controlled provider overrides, read from Workers KV.
 *
 * Why this exists: each service picks its default provider from a priority variable (the
 * container's `PROVIDERS_PRIORITY` and `TEXT_TRANSLATION_PROVIDERS_PRIORITY`, the Worker's
 * `TRANSLATION_PROVIDER`), which is fixed at deploy, and for the container baked into its
 * environment at container start. Changing one needs a release, which is too slow during a
 * provider outage. This path instead rewrites the service's provider URL parameter per connection,
 * which the server already understands, so an operator can move new sessions to a secondary
 * provider with one `wrangler kv key put` and no release.
 *
 * Every service with more than one backend has a **slot**: a KV key, the URL parameter the server
 * parses, the providers an override may name, and how to tell whether this deployment holds the
 * credentials for one. The three slots are `/transcribe`'s transcription provider, `/translate`'s
 * speech-to-speech provider, and `/transcribe`'s text-translation provider. `/agent` has no slot:
 * its one endpoint is the customer's, chosen per agent.
 *
 * Two rules are load-bearing:
 *
 * 1. **An explicit parameter is never overridden.** A caller that names a provider has made a
 *    deliberate choice (a test rig, a pinned monitor, or `openai_custom`, which carries the
 *    customer's own endpoint and their own API key). Overriding that would route a customer's audio
 *    to a provider they did not choose.
 *
 * 2. **Every rejection degrades to "no override", never to a broken session.** The container closes
 *    the socket with 1002 when it is handed an invalid or unavailable transcription provider, and
 *    the Worker refuses a `/translate` upgrade with 400/503 for one, so a typo in KV would otherwise
 *    take the service down. Each check below falls back to the configured default instead.
 *
 * The override is temporary by design: an entry must carry an expiry, and the expiry is checked
 * here at read time rather than being left to KV's own expiration (which the edge cache can lag).
 * When it lapses, new sessions go back to the configured default, which re-tests the primary
 * provider automatically — no operator has to remember to switch back.
 */

/** The services with more than one backend, each with its own KV key. */
export type OverrideSlotId = 'transcribe' | 'translate' | 'text-translation';

/** Just enough of the Worker env to resolve an override: the KV binding and the provider keys. */
export interface ProviderOverrideEnv {
	CONFIG_KV?: ProviderOverrideKv;
	OPENAI_API_KEY?: string;
	DEEPGRAM_API_KEY?: string;
	GEMINI_API_KEY?: string;
	XAI_API_KEY?: string;
	OPENAI_TRANSLATION_API_KEY?: string;
	XAI_TRANSLATION_API_KEY?: string;
	TEXT_TRANSLATION_OPENAI_API_KEY?: string;
	TEXT_TRANSLATION_XAI_API_KEY?: string;
	TEXT_TRANSLATION_GEMINI_API_KEY?: string;
	TEXT_TRANSLATION_GOOGLE_API_KEY?: string;
	TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON?: string;
}

/** The minimal KV surface this module needs. Keeps the module easy to fake in tests. */
export interface ProviderOverrideKv {
	get(key: string, options: { type: 'text'; cacheTtl?: number }): Promise<string | null>;
}

/**
 * One overridable service. `isConfigured` mirrors the server's own availability check for the
 * provider, evaluated against the Worker env (which holds the same secrets it forwards to the
 * container). Without it an override naming a provider whose key is unset would fail every new
 * session.
 */
export interface ProviderOverrideSlot<P extends string = string> {
	readonly id: OverrideSlotId;
	/** Capitalised, for the log line: "Transcription provider override applied: ...". */
	readonly label: string;
	/** The KV key holding the override. */
	readonly key: string;
	/** The URL parameter the server parses for this service's provider. */
	readonly param: string;
	/** The providers an override may select. */
	readonly providers: readonly P[];
	isConfigured(env: ProviderOverrideEnv, provider: P): boolean;
}

/**
 * The `/transcribe` transcription provider. `openai_custom` and `dummy` are deliberately excluded:
 * `openai_custom` is meaningless without the per-request URL and key that only the caller can
 * supply, and `dummy` produces no real transcription.
 */
export const TRANSCRIBE_PROVIDERS = ['openai', 'deepgram', 'gemini', 'xai'] as const;
export type TranscribeProvider = (typeof TRANSCRIBE_PROVIDERS)[number];

export const TRANSCRIBE_PROVIDER_SLOT: ProviderOverrideSlot<TranscribeProvider> = {
	id: 'transcribe',
	label: 'Transcription provider',
	key: 'transcribe:provider-override',
	param: 'provider',
	providers: TRANSCRIBE_PROVIDERS,
	// Mirrors the container's isProviderAvailable. Caveat: this reads the Worker's *current* env,
	// while a running container validates against the env it was started with
	// (`buildContainerEnvVars`, at container start). The two disagree for a container that started
	// before a newly added secret existed — it still has the empty value, so it closes sessions with
	// 1002 even though the check here passes. A provider's key must therefore already have been set
	// when the running containers started; adding the secret and arming the override in the same
	// breath is not safe.
	isConfigured(env, provider) {
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
	},
};

/** The `/translate` speech-to-speech provider (src/translate/provider.ts), served by the Worker itself. */
export const TRANSLATE_PROVIDERS = ['openai', 'xai'] as const;
export type TranslateProvider = (typeof TRANSLATE_PROVIDERS)[number];

export const TRANSLATE_PROVIDER_SLOT: ProviderOverrideSlot<TranslateProvider> = {
	id: 'translate',
	label: 'Speech-to-speech translation provider',
	key: 'translate:provider-override',
	param: 'provider',
	providers: TRANSLATE_PROVIDERS,
	// The same key fallbacks worker/translationRuntime.ts resolves. The Worker serves /translate, so
	// unlike the transcribe slot there is no started-container staleness: the env checked here is
	// the one the session runs with.
	isConfigured(env, provider) {
		switch (provider) {
			case 'openai':
				return !!(env.OPENAI_TRANSLATION_API_KEY || env.OPENAI_API_KEY);
			case 'xai':
				return !!(env.XAI_TRANSLATION_API_KEY || env.XAI_API_KEY);
		}
	},
};

/**
 * The `/transcribe` text-translation provider (src/textTranslate/factory.ts). `stub` is excluded
 * for the same reason as `dummy`: it does not translate. The container does not close the socket
 * on an unusable text-translation provider (it falls back to its default and logs), so the
 * `isConfigured` check here guards against an override that is silently doing nothing rather
 * than against a broken session.
 */
export const TEXT_TRANSLATION_PROVIDERS = ['openai', 'xai', 'gemini', 'google'] as const;
export type TextTranslationOverrideProvider = (typeof TEXT_TRANSLATION_PROVIDERS)[number];

export const TEXT_TRANSLATION_PROVIDER_SLOT: ProviderOverrideSlot<TextTranslationOverrideProvider> = {
	id: 'text-translation',
	label: 'Text translation provider',
	key: 'text-translation:provider-override',
	param: 'text_translation_provider',
	providers: TEXT_TRANSLATION_PROVIDERS,
	// The same key fallbacks src/config.ts resolves (each per-provider key falls back to the
	// provider's transcription key; google has no fallback). The started-container caveat on the
	// transcribe slot applies here too.
	isConfigured(env, provider) {
		switch (provider) {
			case 'openai':
				return !!(env.TEXT_TRANSLATION_OPENAI_API_KEY || env.OPENAI_API_KEY);
			case 'xai':
				return !!(env.TEXT_TRANSLATION_XAI_API_KEY || env.XAI_API_KEY);
			case 'gemini':
				return !!(env.TEXT_TRANSLATION_GEMINI_API_KEY || env.GEMINI_API_KEY);
			case 'google':
				return !!(env.TEXT_TRANSLATION_GOOGLE_API_KEY || env.TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON);
		}
	},
};

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

/**
 * Smallest `until` that can be a real millisecond timestamp (2001-09-09). Anything below it is a
 * seconds-granularity value, which is the likeliest operator slip — `--ttl` on the same command
 * line takes seconds. Treating it as a merely expired override would be the worst outcome: the
 * operator believes the override is armed, it is reported at `info`, and traffic quietly stays on
 * the failing provider. It is refused as malformed instead, at `error`.
 */
export const MIN_PLAUSIBLE_UNTIL_MS = 1_000_000_000_000;

export type OverrideDecision<P extends string = string> =
	| { applied: true; provider: P; until: number; reason?: string }
	| { applied: false; level: 'debug' | 'info' | 'error'; why: string };

/** The overrides that changed a connection, by slot. What the `info` message reports. */
export type AppliedOverrides = Partial<Record<OverrideSlotId, string>>;

/**
 * Decide what a KV entry means, with no I/O. `raw` is the raw stored string, or `null` for "no such
 * key". Parsing happens here rather than in the KV read so that an operator's typo gets its own
 * "not valid JSON" message instead of being reported as a KV failure — which would send them
 * looking at infrastructure health rather than at the value they just wrote.
 */
export function decideProviderOverride<P extends string>(
	raw: string | null | undefined,
	opts: {
		slot: ProviderOverrideSlot<P>;
		hasProviderParam: boolean;
		isConfigured: (provider: P) => boolean;
		now: number;
	},
): OverrideDecision<P> {
	const { slot } = opts;
	// Rule 1: an explicit parameter always wins. Checked before the entry is even inspected, so a
	// malformed entry cannot produce a misleading error log for a connection it could never affect.
	if (opts.hasProviderParam) {
		return { applied: false, level: 'debug', why: `request names a ${slot.param} explicitly` };
	}

	if (raw === null || raw === undefined || raw.trim() === '') {
		return { applied: false, level: 'debug', why: 'no override set' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { applied: false, level: 'error', why: `override is not valid JSON: ${msg}` };
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { applied: false, level: 'error', why: `override is not a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})` };
	}

	const entry = parsed as Record<string, unknown>;

	if (typeof entry.provider !== 'string' || !(slot.providers as readonly string[]).includes(entry.provider)) {
		return {
			applied: false,
			level: 'error',
			why: `override names an unusable provider: ${JSON.stringify(entry.provider)}. Valid: ${slot.providers.join(', ')}`,
		};
	}
	const provider = entry.provider as P;

	// An entry with no expiry is refused rather than treated as permanent. "Forever" is exactly the
	// state this mechanism is meant to make impossible.
	if (typeof entry.until !== 'number' || !Number.isFinite(entry.until)) {
		return { applied: false, level: 'error', why: `override has no usable "until" timestamp (got ${JSON.stringify(entry.until)})` };
	}
	const until = entry.until;

	// A seconds-granularity value cannot be a legitimately expired override, so it is refused as
	// malformed rather than reported as expired — see MIN_PLAUSIBLE_UNTIL_MS.
	if (until < MIN_PLAUSIBLE_UNTIL_MS) {
		return {
			applied: false,
			level: 'error',
			why: `override "until" is not a millisecond timestamp (got ${until}); use milliseconds since the epoch`,
		};
	}

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
 * Read a slot's override from KV and decide whether it applies to this request.
 *
 * A KV failure is swallowed deliberately: an optional operator convenience must never stop a call
 * from being set up.
 */
export async function resolveProviderOverride<P extends string>(
	request: Request,
	env: ProviderOverrideEnv,
	slot: ProviderOverrideSlot<P>,
	now: number = Date.now(),
): Promise<OverrideDecision<P>> {
	const hasProviderParam = new URL(request.url).searchParams.has(slot.param);

	// Checked before the KV read so an explicitly-pinned connection costs nothing.
	if (hasProviderParam) {
		return { applied: false, level: 'debug', why: `request names a ${slot.param} explicitly` };
	}

	if (!env.CONFIG_KV) {
		return { applied: false, level: 'debug', why: 'CONFIG_KV binding is not configured' };
	}

	// Read as text, not json: `type: 'json'` throws on a malformed value, which would surface an
	// operator typo as a KV failure. decideProviderOverride parses and reports it properly.
	let raw: string | null;
	try {
		raw = await env.CONFIG_KV.get(slot.key, { type: 'text', cacheTtl: OVERRIDE_CACHE_TTL_SECONDS });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { applied: false, level: 'error', why: `KV read failed: ${msg}` };
	}

	return decideProviderOverride(raw, {
		slot,
		hasProviderParam,
		isConfigured: (provider) => slot.isConfigured(env, provider),
		now,
	});
}

/**
 * Return a copy of the request with the slot's parameter set. The server reads this parameter
 * already, so the override needs no server-side change at all.
 *
 * Copying from the original request preserves the `Upgrade: websocket` header and the body, which
 * is what keeps the WebSocket handshake intact through the rewrite.
 */
export function applyProviderOverride(request: Request, slot: ProviderOverrideSlot, provider: string): Request {
	const url = new URL(request.url);
	url.searchParams.set(slot.param, provider);
	return new Request(url.toString(), request);
}

/** One-line description of a decision, for the Worker log. */
export function describeOverrideDecision(slot: ProviderOverrideSlot, decision: OverrideDecision): string {
	if (decision.applied) {
		const reason = decision.reason ? `, reason=${decision.reason}` : '';
		return `${slot.label} override applied: provider=${decision.provider}, until=${new Date(decision.until).toISOString()}${reason}`;
	}
	return `${slot.label} override not applied: ${decision.why}`;
}

/**
 * Resolve every given slot for one request (the KV reads run in parallel), rewrite the request
 * with the overrides that apply, and log each decision: an applied override and an expired one at
 * log level, a malformed or unusable one at error level (an operator mistake that is silently doing
 * nothing), and the rest not at all. Returns the request to forward and, by slot, the providers it
 * now names because of an override — what the `info` message reports, since the server cannot tell
 * an override apart from a client-supplied parameter.
 */
export async function applyProviderOverrides(
	request: Request,
	env: ProviderOverrideEnv,
	slots: readonly ProviderOverrideSlot[],
	now: number = Date.now(),
): Promise<{ request: Request; applied: AppliedOverrides }> {
	const decisions = await Promise.all(slots.map((slot) => resolveProviderOverride(request, env, slot, now)));
	const applied: AppliedOverrides = {};
	let rewritten = request;
	decisions.forEach((decision, i) => {
		const slot = slots[i];
		if (decision.applied) {
			applied[slot.id] = decision.provider;
			rewritten = applyProviderOverride(rewritten, slot, decision.provider);
			console.log(describeOverrideDecision(slot, decision));
		} else if (decision.level === 'error') {
			console.error(describeOverrideDecision(slot, decision));
		} else if (decision.level === 'info') {
			console.log(describeOverrideDecision(slot, decision));
		}
	});
	return { request: rewritten, applied };
}
