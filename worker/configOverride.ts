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
 * Operator-controlled config overrides, read from Workers KV.
 *
 * A KV entry under `config:<NAME>` takes precedence over the Worker variable `<NAME>`, for every
 * variable worker/vars.ts marks with a `kv` type. The Worker resolves them per request into an
 * **effective env**: its own env with the overrides overlaid. Everything downstream reads that
 * env, so an override reaches each place the variable is used — the Worker's own decisions
 * (routing, the dispatcher, the Worker-hosted /translate) and the env of a container it starts.
 *
 * Entry shape: `{"value": <value>, "until": <ms since epoch | -1>, "reason": "<optional>"}`.
 * - `value` must have the variable's type (a JSON string, number, boolean or object as the type
 *   allows); `null` unsets the variable, so its default applies.
 * - `until` is mandatory; `-1` means no expiry. There is no cap.
 *
 * Every rejection degrades to "no override" for that one variable: a malformed entry, a value of
 * the wrong type, an expired entry, or a failed KV read leaves the Worker variable in place. The
 * Worker cannot fall over on a typo in KV.
 *
 * When an override takes effect depends on who reads the variable:
 * - The Worker and the Worker-hosted /translate: the next request, after the KV edge cache
 *   (`OVERRIDE_CACHE_TTL_SECONDS`) and the isolate cache (`CONFIG_CACHE_TTL_MS`): up to 90 s.
 * - The container: its next start. A container reads its env once, when it starts, so a running
 *   container keeps the values it started with. With `ROUTING_MODE=session` that is the next
 *   conference.
 */
import type { Env } from './env';
import { checkUntil, entryReason, isoTime, OVERRIDE_CACHE_TTL_SECONDS, parseEntryObject, type Rejection } from './kvEntry';
import { configKey, KV_OVERRIDABLE_VARS, type KvType, type VarEnv, type WorkerVarName } from './vars';

/** The KV surface this module needs: a bulk text read. */
export interface ConfigOverrideKv {
	get(keys: string[], options: { type: 'text'; cacheTtl?: number }): Promise<Map<string, string | null>>;
}

/** Most keys one bulk KV read may ask for (a Workers KV limit). */
export const KV_BULK_GET_MAX_KEYS = 100;

/**
 * How long an isolate reuses what it last read from KV. KV bills a bulk read per key read, so
 * reading every overridable key on every request would cost one read per variable per request.
 * With this cache an isolate pays that once per period. It adds to the edge cache
 * (`OVERRIDE_CACHE_TTL_SECONDS`), so a change can take up to 90 s to reach every request. Only the
 * stored strings are cached: each request still decides them afresh, so an entry expires on time.
 */
export const CONFIG_CACHE_TTL_MS = 30_000;

/**
 * How long an isolate waits after a failed KV read before it reads again. Without it, every request
 * during a KV outage would wait for a failing read before routing. Meanwhile the isolate keeps the
 * entries it last read, if any; each request still checks their `until`.
 */
export const KV_FAILURE_RETRY_MS = 5_000;

/**
 * How long after the last good read the isolate keeps its entries while KV fails. An entry with no
 * expiry (`until: -1`) that the operator deletes during an outage would otherwise stay in effect for
 * as long as the outage lasts.
 */
export const KV_STALE_MAX_MS = 5 * 60_000;

/** What an isolate keeps from its last read of one key set from one KV binding. */
interface CacheSlot {
	readAt: number;
	ttlMs: number;
	stored: Map<string, string | null>;
	/** When `stored` was read from KV; unset when it holds nothing read. */
	goodReadAt?: number;
	error?: string;
	stale?: boolean;
	/** The read in progress, shared by every request that misses the cache meanwhile. */
	inflight?: Promise<void>;
}

/**
 * One slot per KV binding and key set. Keyed on the binding object, so two bindings (for example a
 * Worker handler and a Durable Object in one isolate) do not evict each other's entries.
 */
let slots = new WeakMap<ConfigOverrideKv, Map<string, CacheSlot>>();

/** Forget the isolate cache. For tests. */
export function resetConfigOverrideCache(): void {
	slots = new WeakMap();
}

/**
 * The stored strings for `keys`, from the isolate cache or one bulk read per chunk. Concurrent
 * misses share one read. A failed read returns the entries last read (empty if none, or if that
 * read is older than `KV_STALE_MAX_MS`) with the error, and is cached for `KV_FAILURE_RETRY_MS`.
 */
async function readEntries(
	kv: ConfigOverrideKv,
	keys: string[],
	now: number,
): Promise<{ stored: Map<string, string | null>; error?: string; stale?: boolean }> {
	const signature = keys.join(',');
	let bySignature = slots.get(kv);
	if (!bySignature) {
		bySignature = new Map();
		slots.set(kv, bySignature);
	}
	const slot = bySignature.get(signature);
	if (slot && !slot.inflight && now - slot.readAt >= 0 && now - slot.readAt < slot.ttlMs) {
		return slot;
	}
	if (slot?.inflight) {
		await slot.inflight;
		return bySignature.get(signature)!;
	}
	const cache = bySignature;
	const inflight = (async () => {
		try {
			const chunks: string[][] = [];
			for (let i = 0; i < keys.length; i += KV_BULK_GET_MAX_KEYS) chunks.push(keys.slice(i, i + KV_BULK_GET_MAX_KEYS));
			const maps = await Promise.all(chunks.map((chunk) => kv.get(chunk, { type: 'text', cacheTtl: OVERRIDE_CACHE_TTL_SECONDS })));
			const stored = new Map(maps.flatMap((m) => [...m]));
			cache.set(signature, { readAt: now, ttlMs: CONFIG_CACHE_TTL_MS, stored, goodReadAt: now });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			// Read the slot as it is now, after the failed read, so that the entries kept are never
			// older than the last good read.
			const current = cache.get(signature);
			const goodReadAt = current?.goodReadAt;
			const stale = goodReadAt !== undefined && now - goodReadAt < KV_STALE_MAX_MS;
			cache.set(signature, {
				readAt: now,
				ttlMs: KV_FAILURE_RETRY_MS,
				stored: stale ? current!.stored : new Map(),
				goodReadAt: stale ? goodReadAt : undefined,
				error,
				stale,
			});
		}
	})();
	cache.set(signature, { ...(slot ?? { readAt: now, ttlMs: 0, stored: new Map() }), inflight });
	await inflight;
	return cache.get(signature)!;
}

export type ConfigOverrideDecision =
	| { name: string; applied: true; value: string; until: number; reason?: string }
	| ({ name: string; applied: false } & Rejection);

/** The variables an override changed, with their effective values. What the `info` messages report. */
export type AppliedConfigOverrides = Record<string, string>;

/**
 * Decide what one KV entry means for one variable, with no I/O. `raw` is the stored string, or
 * `null` for "no such key".
 */
export function decideConfigOverride(
	name: string,
	type: KvType,
	raw: string | null | undefined,
	now: number,
	env: VarEnv = {},
): ConfigOverrideDecision {
	const parsed = parseEntryObject(raw);
	if (!('entry' in parsed)) {
		return { name, applied: false, ...parsed };
	}
	const { entry } = parsed;

	if (!('value' in entry)) {
		return { name, applied: false, level: 'error', why: 'override has no "value"' };
	}
	// Checked before `until`, so a value of the wrong type is reported even on an expired entry: an
	// operator re-arming it by changing only `until` would otherwise learn about it only then.
	let value: string;
	if (entry.value === null) {
		if (type.allowsUnset === false) {
			return {
				name,
				applied: false,
				level: 'error',
				why: 'override may not unset this variable; delete the KV entry to restore the Worker variable',
			};
		}
		value = '';
	} else {
		const normalized = type.normalize(entry.value, env);
		if (typeof normalized !== 'string') {
			return { name, applied: false, level: 'error', why: `override value is not usable: ${normalized.error}` };
		}
		value = normalized;
	}

	const rejected = checkUntil(entry.until, { now, allowIndefinite: true });
	if (rejected) {
		return { name, applied: false, ...rejected };
	}
	return { name, applied: true, value, until: entry.until as number, reason: entryReason(entry) };
}

/**
 * Read every KV-overridable variable's entry and overlay the ones that apply on `env`.
 *
 * The keys are read in bulk (one KV call per `KV_BULK_GET_MAX_KEYS`), edge-cached for
 * `OVERRIDE_CACHE_TTL_SECONDS` and reused by the isolate for `CONFIG_CACHE_TTL_MS`. A KV failure is
 * reported as one error decision and otherwise swallowed: an optional operator convenience must
 * never stop a call from being set up. The isolate then keeps the entries it last read, if any, for
 * up to `KV_STALE_MAX_MS`, and reads again after `KV_FAILURE_RETRY_MS`. Decisions for keys that
 * hold nothing are not returned.
 *
 * The effective env is a plain-object copy (`{ ...env, ...applied }`). The Worker env is a plain
 * object whose bindings are enumerable own properties, so they survive the copy; code that needs
 * something else from the original object must read it from there.
 */
export async function resolveConfigOverrides<E extends Pick<Env, 'CONFIG_KV'>>(
	env: E,
	now: number = Date.now(),
	vars: ReadonlyArray<readonly [string, KvType]> = KV_OVERRIDABLE_VARS,
): Promise<{ env: E; applied: AppliedConfigOverrides; decisions: ConfigOverrideDecision[] }> {
	const kv = env.CONFIG_KV as ConfigOverrideKv | undefined;
	if (!kv || vars.length === 0) {
		return { env, applied: {}, decisions: [] };
	}

	const keys = vars.map(([name]) => configKey(name));
	const { stored, error, stale } = await readEntries(kv, keys, now);

	const applied: AppliedConfigOverrides = {};
	const decisions: ConfigOverrideDecision[] = [];
	if (error !== undefined) {
		const why = `KV read failed: ${error}${stale ? '; keeping the entries last read' : ''}`;
		decisions.push({ name: '*', applied: false, level: 'error', why });
	}
	for (const [name, type] of vars) {
		const raw = stored.get(configKey(name));
		if (raw === null || raw === undefined) continue;
		let decision: ConfigOverrideDecision;
		try {
			decision = decideConfigOverride(name, type, raw, now, env as unknown as VarEnv);
		} catch (err) {
			// A bug in a value type must not fail the request: this variable keeps its Worker value.
			const msg = err instanceof Error ? err.message : String(err);
			decision = { name, applied: false, level: 'error', why: `override could not be checked: ${msg}` };
		}
		decisions.push(decision);
		if (decision.applied) applied[name] = decision.value;
	}
	if (Object.keys(applied).length === 0) {
		return { env, applied, decisions };
	}
	return { env: { ...env, ...applied }, applied, decisions };
}

/** One-line description of a decision, for the Worker log. */
export function describeConfigOverrideDecision(decision: ConfigOverrideDecision): string {
	if (decision.applied) {
		const until = decision.until === -1 ? 'no expiry' : `until=${isoTime(decision.until)}`;
		const reason = decision.reason ? `, reason=${decision.reason}` : '';
		return `Config override applied: ${decision.name}=${JSON.stringify(decision.value)}, ${until}${reason}`;
	}
	return decision.name === '*'
		? `Config overrides not applied: ${decision.why}`
		: `Config override for ${decision.name} not applied: ${decision.why}`;
}

/**
 * Log the decisions the way the provider overrides do: applied and expired at info (`console.log`), a
 * malformed or unusable entry (an operator mistake that is silently doing nothing) at error level,
 * the rest not at all.
 */
export function logConfigOverrideDecisions(decisions: readonly ConfigOverrideDecision[]): void {
	for (const decision of decisions) {
		if (decision.applied || decision.level === 'info') {
			console.log(describeConfigOverrideDecision(decision));
		} else if (decision.level === 'error') {
			console.error(describeConfigOverrideDecision(decision));
		}
	}
}

/** The names of the KV-overridable variables. */
export const CONFIG_OVERRIDABLE_NAMES: readonly WorkerVarName[] = KV_OVERRIDABLE_VARS.map(([name]) => name);
