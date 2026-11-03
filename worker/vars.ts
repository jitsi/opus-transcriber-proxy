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
 * Every string variable of the Worker, defined once.
 *
 * Each entry says two things about one variable:
 *
 * - `container`: how the Worker passes it to the container it starts (`buildContainerEnvVars`).
 *   `'if-set'` forwards it only when it is set and non-empty, so the container's own default
 *   applies otherwise. `{ default }` always forwards it, with that value when unset. Omitted: the
 *   variable is read by the Worker only (`USE_DISPATCHER`, `TRANSLATION_USAGE_URL`, ...).
 * - `kv`: the variable may be overridden at runtime from the `CONFIG_KV` namespace, under the key
 *   `config:<NAME>`, and the value must have this type (worker/configOverride.ts). Omitted: the
 *   variable is never read from KV.
 *
 * `Env` (worker/env.d.ts) takes its variable fields from this table, so a variable that is not
 * declared here does not exist for the Worker.
 *
 * What is deliberately not KV-overridable: secrets (KV is not a secret store, and a container
 * validates provider keys against the env it was started with), provider selection (the provider
 * overrides in worker/providerOverride.ts do that with a credential check and per-connection
 * pinning), endpoints that carry credentials or customer data other than the xAI ones, and the
 * security posture of the openai_custom and /agent paths (loosening any of those must be a
 * reviewed release).
 */

/** The Worker's own env (bindings and variables, before any override), for checks that depend on it. */
export type VarEnv = Readonly<Record<string, unknown>>;

/** A KV value type: checks a value from a KV entry and turns it into the variable's string form. */
export interface KvType {
	/** For error messages: "an integer >= 0", "one of l16|opus". */
	readonly describe: string;
	/**
	 * The variable's string value, or why `value` is not one. `null` (unset) is handled by the
	 * caller. `env` is the Worker's own env, for a value that is valid only against it.
	 */
	normalize(value: unknown, env?: VarEnv): string | { error: string };
	/** `false` when an override may not unset the variable (`null`); omitted means it may. */
	readonly allowsUnset?: boolean;
}

const fail = (t: KvType, value: unknown) => ({ error: `expected ${t.describe}, got ${JSON.stringify(value)}` });

/** Any string, including an empty one (which, like an unset variable, lets the default apply). */
function str(): KvType {
	const t: KvType = {
		describe: 'a string',
		normalize: (v) => (typeof v === 'string' ? v : fail(t, v)),
	};
	return t;
}

/** `true` / `false`, as a JSON boolean or the string. Written back as `"true"` / `"false"`. */
function bool(): KvType {
	const t: KvType = {
		describe: 'true or false',
		normalize(v) {
			if (typeof v === 'boolean') return String(v);
			if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase();
			return fail(t, v);
		},
	};
	return t;
}

/** An integer, as a JSON number or a decimal string, optionally with a lower bound. */
function int(min?: number): KvType {
	const t: KvType = {
		describe: min === undefined ? 'an integer' : `an integer >= ${min}`,
		normalize(v) {
			const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
			if (!Number.isSafeInteger(n) || (min !== undefined && n < min)) return fail(t, v);
			return String(n);
		},
	};
	return t;
}

/** A finite number, as a JSON number or a numeric string. */
function float(): KvType {
	const t: KvType = {
		describe: 'a number',
		normalize(v) {
			const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
			return Number.isFinite(n) ? String(n) : fail(t, v);
		},
	};
	return t;
}

/** A comma-separated host list, read the way the container reads AGENT_ALLOWED_HOSTS. */
const parseHosts = (s: string) => s.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h);
/** An allowlist entry without its optional leading dot; it matches that host and its subdomains. */
const bareHost = (entry: string) => (entry.startsWith('.') ? entry.slice(1) : entry);

/**
 * The /agent host allowlist (`AGENT_ALLOWED_HOSTS`). An empty list allows any public host, the
 * loosest setting, so an override may only narrow the list: it needs at least one host, may not be
 * `null`, and each of its entries must be covered by the Worker's own list when that list is not
 * empty (an entry matches its host and every subdomain, as the container's `hostAllowed` does).
 * Written back normalized, as the container reads it.
 */
function hostList(workerVar: string): KvType {
	const t: KvType = {
		describe: `a non-empty host list that ${workerVar} covers`,
		allowsUnset: false,
		normalize(v, env) {
			if (typeof v !== 'string') return fail(t, v);
			const hosts = parseHosts(v);
			if (hosts.length === 0) return fail(t, v);
			const own = env?.[workerVar];
			const workerHosts = typeof own === 'string' ? parseHosts(own).map(bareHost) : [];
			if (workerHosts.length > 0) {
				const wider = hosts.filter((h) => !workerHosts.some((w) => bareHost(h) === w || bareHost(h).endsWith(`.${w}`)));
				if (wider.length > 0) {
					return { error: `${wider.join(',')} is not covered by the Worker's ${workerVar}; an override may only narrow it` };
				}
			}
			return hosts.join(',');
		},
	};
	return t;
}

/**
 * `ROUTING_MODE`. `autoscale` routes through the coordinator Durable Object, which a deployment may
 * not bind; an override to it there would fail every upgrade, so it is refused.
 */
function routingMode(): KvType {
	const modes = oneOf('session', 'pool', 'shared', 'autoscale');
	const t: KvType = {
		describe: modes.describe,
		normalize(v, env) {
			const mode = modes.normalize(v);
			if (mode === 'autoscale' && !env?.CONTAINER_COORDINATOR) {
				return { error: 'autoscale needs the CONTAINER_COORDINATOR binding, which this Worker does not have' };
			}
			return mode;
		},
	};
	return t;
}

/** One of a fixed set of strings, matched case-insensitively and written back as listed. */
function oneOf(...values: string[]): KvType {
	const t: KvType = {
		describe: `one of ${values.join('|')}`,
		normalize(v) {
			const match = typeof v === 'string' ? values.find((x) => x.toLowerCase() === v.trim().toLowerCase()) : undefined;
			return match ?? fail(t, v);
		},
	};
	return t;
}

/** A JSON object, given as an object or as a string holding one. Written back as JSON. */
function jsonObject(): KvType {
	const t: KvType = {
		describe: 'a JSON object',
		normalize(v) {
			let obj = v;
			if (typeof v === 'string') {
				try {
					obj = JSON.parse(v);
				} catch {
					return fail(t, v);
				}
			}
			if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return fail(t, v);
			return JSON.stringify(obj);
		},
	};
	return t;
}

/** An absolute URL with one of the given schemes. */
function url(...protocols: string[]): KvType {
	const t: KvType = {
		describe: `a ${protocols.join('|')} URL with no credentials, query or fragment`,
		normalize(v) {
			if (typeof v !== 'string') return fail(t, v);
			try {
				const u = new URL(v);
				// The value is logged and reported in `info`, so it may carry no credentials: no
				// userinfo, and no query or fragment (where a token could ride).
				const bare = !u.username && !u.password && !v.includes('?') && !v.includes('#');
				if (bare && protocols.includes(u.protocol.replace(/:$/, ''))) return v;
			} catch {
				// fall through
			}
			return fail(t, v);
		},
	};
	return t;
}

/**
 * A duration in the @cloudflare/containers time-expression format (`"30s"`, `"7m"`, `"2h"`, or a
 * number of seconds), from `minSeconds` to `maxSeconds`. The SDK throws on any other form when it
 * renews the activity timer, so nothing else may reach it.
 */
function duration(minSeconds: number, maxSeconds: number): KvType {
	const t: KvType = {
		describe: `a duration like "7m" (s|m|h) from ${minSeconds}s to ${maxSeconds}s`,
		normalize(v) {
			let seconds: number;
			let text: string;
			if (typeof v === 'number' && Number.isSafeInteger(v)) {
				seconds = v;
				text = `${v}s`;
			} else if (typeof v === 'string' && /^\d+[smh]$/.test(v.trim())) {
				text = v.trim();
				const n = parseInt(text, 10);
				seconds = text.endsWith('h') ? n * 3600 : text.endsWith('m') ? n * 60 : n;
			} else {
				return fail(t, v);
			}
			return seconds >= minSeconds && seconds <= maxSeconds ? text : fail(t, v);
		},
	};
	return t;
}

export interface VarSpec {
	/** How the Worker forwards the variable to the container; omitted for Worker-only variables. */
	readonly container?: 'if-set' | { readonly default: string | ((env: Readonly<Record<string, string | undefined>>) => string) };
	/** KV-overridable under `config:<NAME>`, with the type its value must have. */
	readonly kv?: KvType;
}

const IF_SET = 'if-set' as const;
const def = (value: string) => ({ default: value });

/** Forwarded when set; overridable from KV. The most common shape. */
const tunable = (kv: KvType): VarSpec => ({ container: IF_SET, kv });

export const WORKER_VARS = {
	// --- Endpoints and kill switches. Forwarded only when set, so the container defaults apply
	// (transcribe and translate on; text translation and /agent off). /agent dials out to customer
	// endpoints, so enabling it is a deployment decision; a KV override is one too, made by an
	// operator who can write the namespace.
	ENABLE_TRANSCRIBE: tunable(bool()),
	ENABLE_TRANSLATE: tunable(bool()),
	ENABLE_TEXT_TRANSLATION: tunable(bool()),
	ENABLE_AGENT: tunable(bool()),

	// --- Logging. If DEBUG=true is set, LOG_LEVEL defaults to debug unless set explicitly.
	DEBUG: { container: def('false'), kv: bool() },
	LOG_LEVEL: {
		container: { default: (env) => (env.DEBUG === 'true' ? 'debug' : 'info') },
		kv: oneOf('error', 'warn', 'info', 'debug'),
	},

	// --- Transcription, common.
	PROVIDERS_PRIORITY: { container: def('openai') },
	FORCE_COMMIT_TIMEOUT: { container: def('2'), kv: int(0) },
	ENABLE_OPENAI_CUSTOM_PROVIDER: { container: def('false') },
	OPENAI_CUSTOM_REQUIRE_WSS: { container: def('true') },
	SESSION_RESUME_ENABLED: tunable(bool()),
	SESSION_RESUME_GRACE_PERIOD: tunable(int(0)),
	// Debug output inside the container: the dumps (written under DUMP_BASE_PATH, /tmp by default)
	// and the transcript broadcast.
	DUMP_WEBSOCKET_MESSAGES: tunable(bool()),
	DUMP_TRANSCRIPTS: tunable(bool()),
	DUMP_BASE_PATH: tunable(str()),
	BROADCAST_TRANSCRIPTS: tunable(bool()),
	BROADCAST_TRANSCRIPTS_MAX_SIZE: tunable(int(0)),

	// --- OpenAI transcription.
	OPENAI_API_KEY: { container: def('') },
	OPENAI_MODEL: { container: def('gpt-4o-transcribe'), kv: str() },
	OPENAI_TRANSCRIPTION_PROMPT: tunable(str()),
	OPENAI_TURN_DETECTION: tunable(jsonObject()),

	// --- Gemini transcription.
	GEMINI_API_KEY: { container: def('') },
	GEMINI_MODEL: tunable(str()),
	GEMINI_TRANSCRIPTION_PROMPT: tunable(str()),

	// --- Deepgram.
	DEEPGRAM_API_KEY: { container: def('') },
	DEEPGRAM_MODEL: { container: def('nova-3-general'), kv: str() },
	DEEPGRAM_LANGUAGE: tunable(str()),
	DEEPGRAM_DETECT_LANGUAGE: { container: def('true'), kv: bool() },
	DEEPGRAM_INCLUDE_LANGUAGE: { container: def('false'), kv: bool() },
	DEEPGRAM_DIARIZE: { container: def('false'), kv: bool() },
	DEEPGRAM_PUNCTUATE: { container: def('true'), kv: bool() },
	DEEPGRAM_ENCODING: { container: def('opus'), kv: oneOf('opus', 'linear16') },
	DEEPGRAM_MIP_OPT_OUT: { container: def('false'), kv: bool() },
	// Not KV-overridable: the container validates tags at start and refuses to start on a bad one.
	DEEPGRAM_TAGS: { container: def('') },

	// --- xAI transcription. XAI_API_KEY is forwarded as '' when unset so the container treats xAI
	// as unconfigured (provider disabled); the knobs only when set, so the code defaults apply.
	XAI_API_KEY: { container: def('') },
	XAI_STT_URL: tunable(url('wss')),
	XAI_LANGUAGE: tunable(str()),
	XAI_DIARIZE: tunable(bool()),
	XAI_INCLUDE_LANGUAGE: tunable(bool()),
	XAI_ENDPOINTING: tunable(int(0)),
	XAI_SMART_TURN: tunable(float()),
	XAI_SMART_TURN_TIMEOUT: tunable(int(0)),
	XAI_GRANULAR_FINALS: tunable(bool()),
	XAI_GRANULAR_STABILITY_MS: tunable(int(0)),
	XAI_GRANULAR_GUARD_WORDS: tunable(int(0)),
	XAI_GRANULAR_MIN_WORDS: tunable(int(1)),
	XAI_CONNECT_ATTEMPTS: tunable(int(1)),
	XAI_CONNECT_BACKOFF_MS: tunable(int(0)),
	XAI_MAX_TURN_MS: tunable(int(0)),
	XAI_TURN_SOFT_MAX_WORDS: tunable(int(0)),
	XAI_TURN_HARD_MAX_WORDS: tunable(int(0)),
	XAI_IDLE_TURN_END_GRACE_MS: tunable(int(0)),
	XAI_ENCODING: tunable(oneOf('l16', 'opus')),
	XAI_IDLE_FLUSH: tunable(oneOf('finalize', 'silence')),

	// --- Mistral. The key is forwarded as '' when unset (provider disabled).
	MISTRAL_API_KEY: { container: def('') },
	MISTRAL_MODEL: tunable(str()),

	// --- Speech-to-speech translation (/translate). In the CF deployment the Worker serves it
	// (worker/translationRuntime.ts); forwarding is for a standalone container that serves it itself.
	OPENAI_TRANSLATION_API_KEY: { container: IF_SET },
	OPENAI_TRANSLATION_MODEL: tunable(str()),
	TRANSLATION_PROVIDER: { container: IF_SET },
	TRANSLATION_IDLE_CLOSE_MS: tunable(int(0)),
	XAI_TRANSLATION_API_KEY: { container: IF_SET },
	XAI_TRANSLATION_URL: tunable(url('wss')),
	XAI_TRANSLATION_VOICE: tunable(str()),
	TRANSLATE_TRANSCRIPTS: tunable(bool()),
	// "0" (disable) is a non-empty string, so it is still forwarded.
	// Above the 100 ms RTP gap threshold; <= 0 (a talk never ends) is unsafe for the realtime
	// translations endpoint, so an override may not set it.
	TRANSLATION_TALK_SILENCE_TIMEOUT_MS: tunable(int(101)),
	TRANSLATION_USAGE_URL: {},
	TRANSLATION_USAGE_REPORT_INTERVAL_MS: { kv: int() },
	// Docker image tag the Worker's WASM Opus codec was sourced from at deploy (set by the translate
	// deploy). Surfaced in the info message so a code/WASM version mismatch is visible to the peer.
	SOURCE_IMAGE_TAG: {},

	// --- Text translation of transcripts (the /transcribe path). Per-provider keys fall back to the
	// provider's transcription key inside the container, so only a separately-billed key needs
	// forwarding; TEXT_TRANSLATION_GOOGLE_API_KEY has no fallback.
	TEXT_TRANSLATION_PROVIDERS_PRIORITY: { container: IF_SET },
	ENABLE_TEXT_TRANSLATION_STUB: { container: IF_SET },
	TEXT_TRANSLATION_HISTORY_TURNS: tunable(int(0)),
	TEXT_TRANSLATION_HISTORY_MAX_CHARS: tunable(int(0)),
	TEXT_TRANSLATION_INCLUDE_SPEAKERS: tunable(bool()),
	TEXT_TRANSLATION_TIMEOUT_MS: tunable(int(1)),
	TEXT_TRANSLATION_TEMPERATURE: tunable(float()),
	TEXT_TRANSLATION_REASONING_EFFORT: tunable(str()),
	TEXT_TRANSLATION_MAX_OUTPUT_TOKENS: tunable(int(1)),
	TEXT_TRANSLATION_OPENAI_API_KEY: { container: IF_SET },
	TEXT_TRANSLATION_OPENAI_URL: { container: IF_SET },
	TEXT_TRANSLATION_OPENAI_MODEL: tunable(str()),
	TEXT_TRANSLATION_XAI_API_KEY: { container: IF_SET },
	TEXT_TRANSLATION_XAI_URL: { container: IF_SET },
	TEXT_TRANSLATION_XAI_MODEL: tunable(str()),
	TEXT_TRANSLATION_GEMINI_API_KEY: { container: IF_SET },
	TEXT_TRANSLATION_GEMINI_BASE_URL: { container: IF_SET },
	TEXT_TRANSLATION_GEMINI_MODEL: tunable(str()),
	TEXT_TRANSLATION_GEMINI_THINKING_BUDGET: tunable(int()),
	TEXT_TRANSLATION_GEMINI_THINKING_LEVEL: tunable(str()),
	TEXT_TRANSLATION_GOOGLE_API_KEY: { container: IF_SET },
	TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON: { container: IF_SET },
	TEXT_TRANSLATION_GOOGLE_URL: { container: IF_SET },

	// --- Voice agents (/agent, served by the container).
	AGENT_REQUIRE_WSS: { container: IF_SET },
	// Tightening the allowlist is an incident lever. An empty value allows any public host, so an
	// override may not set it empty or unset it; delete the KV entry to restore the Worker value.
	AGENT_ALLOWED_HOSTS: tunable(hostList('AGENT_ALLOWED_HOSTS')),
	AGENT_ALLOW_PRIVATE_ENDPOINTS: { container: IF_SET },
	AGENT_SHARED_SECRET: { container: IF_SET },
	AGENT_ALLOW_UNAUTHENTICATED: { container: IF_SET },
	AGENT_PACE_LEAD_MS: tunable(int(0)),
	AGENT_PROVISIONING_URL: { container: IF_SET },
	AGENT_PROVISIONING_TOKEN: { container: IF_SET },
	AGENT_PROVISIONING_HOST: { container: IF_SET },
	AGENT_PROVISIONING_ROUTING: { container: IF_SET },

	// --- Topology. Read by the Worker per request (ROUTING_MODE, CONTAINER_POOL_SIZE,
	// USE_DISPATCHER), by the autoscale coordinator (MAX_CONNECTIONS_PER_CONTAINER, MIN_CONTAINERS,
	// SCALE_DOWN_IDLE_TIME) and by the container Durable Object (SLEEP_AFTER, which it takes from
	// the start call: see TranscriberContainer.startAndWaitForPorts). Changing ROUTING_MODE or the
	// pool size moves new sessions to other containers; a session that reconnects after the change
	// may land on a different container than the one holding its detached state.
	ROUTING_MODE: { container: def('session'), kv: routingMode() },
	CONTAINER_POOL_SIZE: { container: def('5'), kv: int(1) },
	MAX_CONNECTIONS_PER_CONTAINER: { container: def('10'), kv: int(1) },
	MIN_CONTAINERS: { container: def('2'), kv: int(0) },
	SCALE_DOWN_IDLE_TIME: { container: def('600000'), kv: int(0) },
	USE_DISPATCHER: { kv: bool() },
	// The floor (4 minutes) keeps it above the 180 s keepalive renewal in sessionProxy.ts. It does not
	// cover a missed renewal (a 360 s gap): the /status probe in onActivityExpired is the backstop
	// for that. The ceiling (24 hours) stops an override from keeping idle containers, which are
	// billed, awake indefinitely.
	SLEEP_AFTER: { container: IF_SET, kv: duration(240, 86_400) },

	// --- Telemetry.
	OTLP_ENDPOINT: { container: def('') },
	OTLP_ENV: { container: def('') },
	OTLP_RESOURCE_ATTRIBUTES: { container: def('') },
	OTLP_HEADERS: { container: def('') },
	// "0" disables the stale markers, and is forwarded like any other set value.
	OTLP_STALE_MARKER_SENDS: { container: IF_SET },
} as const satisfies Record<string, VarSpec>;

export type WorkerVarName = keyof typeof WORKER_VARS;

/** The variable fields of `Env`: every declared variable, as an optional string. */
export type WorkerVars = { [K in WorkerVarName]?: string };

/** The KV key a variable is overridden under. */
export const configKey = (name: string): string => `config:${name}`;

/**
 * The KV-overridable variables, with their types. KV bills a bulk read per key read, and every
 * isolate reads all of these keys once per `CONFIG_CACHE_TTL_MS`, so each variable added here adds
 * to the billed reads.
 */
export const KV_OVERRIDABLE_VARS: ReadonlyArray<readonly [WorkerVarName, KvType]> = (
	Object.entries(WORKER_VARS) as Array<[WorkerVarName, VarSpec]>
)
	.filter(([, spec]) => spec.kv !== undefined)
	.map(([name, spec]) => [name, spec.kv as KvType] as const);
