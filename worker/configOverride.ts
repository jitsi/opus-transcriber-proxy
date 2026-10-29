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
 * - The Worker and the Worker-hosted /translate: the next request (after the KV edge cache, up to
 *   `OVERRIDE_CACHE_TTL_SECONDS`).
 * - The container: its next start. A container reads its env once, when it starts, so a running
 *   container keeps the values it started with. With `ROUTING_MODE=session` that is the next
 *   conference.
 */
import type { Env } from './env';
import { checkUntil, entryReason, OVERRIDE_CACHE_TTL_SECONDS, parseEntryObject, type Rejection } from './kvEntry';
import { configKey, KV_OVERRIDABLE_VARS, type KvType, type WorkerVarName } from './vars';

/** The KV surface this module needs: a bulk text read. */
export interface ConfigOverrideKv {
	get(keys: string[], options: { type: 'text'; cacheTtl?: number }): Promise<Map<string, string | null>>;
}

/** Most keys one bulk KV read may ask for (a Workers KV limit). */
export const KV_BULK_GET_MAX_KEYS = 100;

export type ConfigOverrideDecision =
	| { name: string; applied: true; value: string; until: number; reason?: string }
	| ({ name: string; applied: false } & Rejection);

/** The variables an override changed, with their effective values. What the `info` messages report. */
export type AppliedConfigOverrides = Record<string, string>;

/**
 * Decide what one KV entry means for one variable, with no I/O. `raw` is the stored string, or
 * `null` for "no such key".
 */
export function decideConfigOverride(name: string, type: KvType, raw: string | null | undefined, now: number): ConfigOverrideDecision {
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
		value = '';
	} else {
		const normalized = type.normalize(entry.value);
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
 * `OVERRIDE_CACHE_TTL_SECONDS`. A KV failure is swallowed: an optional operator convenience must
 * never stop a call from being set up. Decisions for keys that hold nothing are not returned.
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
	let stored: Map<string, string | null>;
	try {
		const chunks: string[][] = [];
		for (let i = 0; i < keys.length; i += KV_BULK_GET_MAX_KEYS) chunks.push(keys.slice(i, i + KV_BULK_GET_MAX_KEYS));
		const maps = await Promise.all(chunks.map((chunk) => kv.get(chunk, { type: 'text', cacheTtl: OVERRIDE_CACHE_TTL_SECONDS })));
		stored = new Map(maps.flatMap((m) => [...m]));
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { env, applied: {}, decisions: [{ name: '*', applied: false, level: 'error', why: `KV read failed: ${msg}` }] };
	}

	const applied: AppliedConfigOverrides = {};
	const decisions: ConfigOverrideDecision[] = [];
	for (const [name, type] of vars) {
		const raw = stored.get(configKey(name));
		if (raw === null || raw === undefined) continue;
		const decision = decideConfigOverride(name, type, raw, now);
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
		const until = decision.until === -1 ? 'no expiry' : `until=${new Date(decision.until).toISOString()}`;
		const reason = decision.reason ? `, reason=${decision.reason}` : '';
		return `Config override applied: ${decision.name}=${JSON.stringify(decision.value)}, ${until}${reason}`;
	}
	return decision.name === '*'
		? `Config overrides not applied: ${decision.why}`
		: `Config override for ${decision.name} not applied: ${decision.why}`;
}

/**
 * Log the decisions the way the provider overrides do: applied and expired at log level, a
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
