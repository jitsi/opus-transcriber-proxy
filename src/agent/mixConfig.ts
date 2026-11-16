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
 * The options of the `mix` fan-in (see `agent/mix/`). Each one is resolved on its own through four layers, the
 * later one winning: the default here, the container's `AGENT_MIX_*` variable, a KV override of that variable
 * (which reaches the container as the same variable, named in `CONFIG_OVERRIDES`), and the `mix` object of the
 * agent's dial config ("inline").
 */

/** How the sum is scaled by the number of sources in a frame: not at all, by 1/sqrt(n), or by 1/n. */
export const MIX_GAINS = ['unity', 'sqrt', 'average'] as const;
export type MixGain = (typeof MIX_GAINS)[number];
/** What keeps the sum within 16 bits: a soft clip above a knee, or the hard clamp alone. */
export const MIX_LIMITERS = ['soft', 'clamp'] as const;
export type MixLimiter = (typeof MIX_LIMITERS)[number];
/** The frame durations the mixer can tick at (ms). */
export const MIX_FRAME_MS = [10, 20, 40, 60] as const;
export type MixFrameMs = (typeof MIX_FRAME_MS)[number];

export interface MixConfig {
	/**
	 * Jitter buffer depth per source (ms): how far after it arrives the first packet of a talk plays. The mix as a
	 * whole is later than that by up to one frame, because a frame is sent when its end is due. 0 is no buffer.
	 */
	bufferMs: number;
	/**
	 * How far ahead of real time a source's audio may be queued (ms). A late packet moves the rest of its talk
	 * later rather than being dropped, so a source's delay grows to the worst delay of the talk; past this depth
	 * the oldest queued audio is skipped to bring it back to `bufferMs`. Never less than `bufferMs` plus
	 * [MIX_MIN_BUFFER_HEADROOM_MS]: a lower value is raised to that (see [normalizeMixConfig]).
	 */
	maxBufferMs: number;
	/** Duration of a mixed frame, and the mixer's tick (ms). */
	frameMs: MixFrameMs;
	/**
	 * Send a frame on every tick, digital silence while nobody talks, from the start of the session; otherwise
	 * nothing is sent while nobody talks, and the clock starts with the first packet.
	 */
	continuous: boolean;
	/** The most sources mixed at once, the loudest winning. 0 is no cap. */
	maxSpeakers: number;
	gain: MixGain;
	limiter: MixLimiter;
	/** The soft clip's knee (dBFS). At 0 the soft clip is the hard clamp. */
	limiterKneeDb: number;
	/** The longest gap in the bridge's numbering that the decoder conceals (ms). 0 turns concealment off. */
	concealMs: number;
	/** An RTP gap longer than this starts a new talk, with a new anchor (ms). */
	talkGapMs: number;
	/**
	 * The late packet, counted in a row, that moves the talk later. 1 moves it at the first one, so nothing is
	 * dropped; N drops the N-1 before it.
	 */
	lateResyncPackets: number;
}

export type MixOption = keyof MixConfig;

export const DEFAULT_MIX_CONFIG: Readonly<MixConfig> = {
	bufferMs: 60,
	maxBufferMs: 300,
	frameMs: 20,
	continuous: false,
	maxSpeakers: 0,
	gain: 'unity',
	limiter: 'soft',
	limiterKneeDb: -3,
	concealMs: 120,
	talkGapMs: 200,
	lateResyncPackets: 1,
};

/** The least room above the buffer that `maxBufferMs` leaves, whatever it is set to (ms). */
export const MIX_MIN_BUFFER_HEADROOM_MS = 40;

/**
 * What a value of an option must be, tied to the option's type: a boolean has no bounds, a set of strings or of
 * numbers lists its members, and a plain number has a range. A spec of the wrong kind, or a list that is not the
 * type's own, does not compile.
 */
type SpecFor<T> = [T] extends [boolean]
	? { kind: 'bool'; env: string }
	: [T] extends [string]
		? { kind: 'enum'; env: string; values: readonly T[] }
		: number extends T
			? { kind: 'int' | 'number'; env: string; min: number; max: number }
			: { kind: 'intEnum'; env: string; values: readonly T[] };

/** Every option: its variable (layers 2 and 3) and what a value must be. The Worker's table (worker/vars.ts) mirrors it. */
export const MIX_OPTIONS: { readonly [K in MixOption]: SpecFor<MixConfig[K]> } = {
	bufferMs: { kind: 'int', env: 'AGENT_MIX_BUFFER_MS', min: 0, max: 500 },
	maxBufferMs: { kind: 'int', env: 'AGENT_MIX_MAX_BUFFER_MS', min: 40, max: 2000 },
	frameMs: { kind: 'intEnum', env: 'AGENT_MIX_FRAME_MS', values: MIX_FRAME_MS },
	continuous: { kind: 'bool', env: 'AGENT_MIX_CONTINUOUS' },
	maxSpeakers: { kind: 'int', env: 'AGENT_MIX_MAX_SPEAKERS', min: 0, max: 16 },
	gain: { kind: 'enum', env: 'AGENT_MIX_GAIN', values: MIX_GAINS },
	limiter: { kind: 'enum', env: 'AGENT_MIX_LIMITER', values: MIX_LIMITERS },
	limiterKneeDb: { kind: 'number', env: 'AGENT_MIX_LIMITER_KNEE_DB', min: -12, max: 0 },
	concealMs: { kind: 'int', env: 'AGENT_MIX_CONCEAL_MS', min: 0, max: 120 },
	talkGapMs: { kind: 'int', env: 'AGENT_MIX_TALK_GAP_MS', min: 60, max: 2000 },
	lateResyncPackets: { kind: 'int', env: 'AGENT_MIX_LATE_RESYNC_PACKETS', min: 1, max: 50 },
};

export type MixOptionSpec = (typeof MIX_OPTIONS)[MixOption];

const OPTION_NAMES = Object.keys(MIX_OPTIONS) as MixOption[];

function describeSpec(spec: MixOptionSpec): string {
	switch (spec.kind) {
		case 'int':
			return `a whole number from ${spec.min} to ${spec.max}`;
		case 'number':
			return `a number from ${spec.min} to ${spec.max}`;
		case 'bool':
			return 'true or false';
		case 'enum':
		case 'intEnum':
			return `one of ${spec.values.join(', ')}`;
	}
}

/**
 * Checks one value against its option. `fromText` reads a variable's string ("60", "true"); otherwise the value
 * must already have its JSON type, so that an inline `"bufferMs": "60"` is a mistake the invite's author hears about.
 */
function parseValue(spec: MixOptionSpec, raw: unknown, fromText: boolean): { value: number | boolean | string } | { error: string } {
	const bad = { error: `expected ${describeSpec(spec)}, got ${JSON.stringify(raw)}` };
	// A variable's number is read as the Worker writes a KV number back (`String(n)`), so the two agree.
	const asNumber = (): number => {
		if (typeof raw === 'number') return raw;
		return fromText && typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
	};
	switch (spec.kind) {
		case 'int': {
			const n = asNumber();
			return Number.isInteger(n) && n >= spec.min && n <= spec.max ? { value: n } : bad;
		}
		case 'number': {
			const n = asNumber();
			return Number.isFinite(n) && n >= spec.min && n <= spec.max ? { value: n } : bad;
		}
		case 'intEnum': {
			const n = asNumber();
			return (spec.values as readonly number[]).includes(n) ? { value: n } : bad;
		}
		case 'bool': {
			if (typeof raw === 'boolean') return { value: raw };
			if (fromText && typeof raw === 'string' && /^\s*(true|false)\s*$/i.test(raw)) return { value: raw.trim().toLowerCase() === 'true' };
			return bad;
		}
		case 'enum': {
			const text = typeof raw === 'string' ? (fromText ? raw.trim().toLowerCase() : raw) : undefined;
			return text !== undefined && (spec.values as readonly string[]).includes(text) ? { value: text } : bad;
		}
	}
}

/** Sets one checked value. The one place a value's type is taken on trust: `parseValue` checked it against the option's spec. */
function setOption(target: Partial<MixConfig>, name: MixOption, value: number | boolean | string): void {
	(target as Record<MixOption, number | boolean | string>)[name] = value;
}

/**
 * Layers 2 and 3: the `AGENT_MIX_*` variables of the container. A value that is not usable is reported through
 * `warn` and left out, so the default applies: a typo in a deployment must not take the fan-in down.
 */
export function mixConfigFromEnv(env: Readonly<Record<string, string | undefined>>, warn: (message: string) => void): Partial<MixConfig> {
	const values: Partial<MixConfig> = {};
	for (const name of OPTION_NAMES) {
		const spec = MIX_OPTIONS[name];
		const raw = env[spec.env];
		if (raw === undefined || raw === '') {
			continue;
		}
		const parsed = parseValue(spec, raw, true);
		if ('error' in parsed) {
			warn(`${spec.env}=${raw} is not usable (${parsed.error}); using ${DEFAULT_MIX_CONFIG[name]}`);
			continue;
		}
		setOption(values, name, parsed.value);
	}
	return values;
}

export type InlineMix = { ok: true; values: Partial<MixConfig>; unknownOptions: string[] } | { ok: false; error: string };

/**
 * Layer 4: the `mix` object of the dial config. Unlike a variable, a bad value here fails the dial: it is one
 * agent's own config, and its author must hear that it was not applied. Fields this relay does not know are
 * returned in `unknownOptions` and ignored, so an invite written for a newer relay still works.
 */
export function parseInlineMix(raw: unknown): InlineMix {
	if (raw === undefined || raw === null) {
		return { ok: true, values: {}, unknownOptions: [] };
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, error: 'mix: must be an object' };
	}
	const values: Partial<MixConfig> = {};
	const unknownOptions: string[] = [];
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!Object.prototype.hasOwnProperty.call(MIX_OPTIONS, key)) {
			unknownOptions.push(key);
			continue;
		}
		const parsed = parseValue(MIX_OPTIONS[key as MixOption], value, false);
		if ('error' in parsed) {
			return { ok: false, error: `mix.${key}: ${parsed.error}` };
		}
		setOption(values, key as MixOption, parsed.value);
	}
	return { ok: true, values, unknownOptions };
}

/**
 * The rule between two options, applied wherever a config is put together: `maxBufferMs` leaves at least
 * [MIX_MIN_BUFFER_HEADROOM_MS] above `bufferMs`. Each has its own range and its own layer (a deployment may set
 * one and an agent the other), so the pair cannot be refused where either is read.
 */
export function normalizeMixConfig(config: Readonly<MixConfig>): MixConfig {
	return { ...config, maxBufferMs: Math.max(config.maxBufferMs, config.bufferMs + MIX_MIN_BUFFER_HEADROOM_MS) };
}

/** Where an option's value in effect came from; `raised` is a `maxBufferMs` lifted to leave room above `bufferMs`. */
export type MixLayer = 'default' | 'config' | 'kv' | 'inline' | 'raised';

export interface ResolvedMixConfig {
	readonly config: Readonly<MixConfig>;
	readonly layers: Readonly<Record<MixOption, MixLayer>>;
}

/**
 * Merges the layers, option by option. `kvOverridden` holds the names of the variables that a KV override set
 * (the keys of `CONFIG_OVERRIDES`), only to say `kv` rather than `config` in the session's log line.
 */
export function resolveMixConfig(
	fromEnv: Partial<MixConfig> = {},
	inline: Partial<MixConfig> = {},
	kvOverridden: ReadonlySet<string> = new Set(),
): ResolvedMixConfig {
	const merged: MixConfig = { ...DEFAULT_MIX_CONFIG };
	const layers = {} as Record<MixOption, MixLayer>;
	for (const name of OPTION_NAMES) {
		const inlineValue = inline[name];
		const envValue = fromEnv[name];
		if (inlineValue !== undefined) {
			setOption(merged, name, inlineValue);
			layers[name] = 'inline';
		} else if (envValue !== undefined) {
			setOption(merged, name, envValue);
			layers[name] = kvOverridden.has(MIX_OPTIONS[name].env) ? 'kv' : 'config';
		} else {
			layers[name] = 'default';
		}
	}
	const config = normalizeMixConfig(merged);
	if (config.maxBufferMs !== merged.maxBufferMs) {
		layers.maxBufferMs = 'raised';
	}
	return { config, layers };
}

/** `bufferMs=80 (inline) maxBufferMs=300 (default) ...`: every value in effect and its layer, for the session's log line. */
export function describeMixConfig(resolved: ResolvedMixConfig): string {
	return OPTION_NAMES.map((name) => `${name}=${resolved.config[name]} (${resolved.layers[name]})`).join(' ');
}
