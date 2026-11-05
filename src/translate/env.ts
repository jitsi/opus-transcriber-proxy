/*
 * Copyright @ 2025 - present 8x8, Inc.
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

// Worker-safe env helpers shared by the Node and Worker translation runtimes. Lives under
// src/translate/ so both import one copy (no node-only deps) — see nodeRuntime.ts / worker/translationRuntime.ts.

/** Parse an integer env var, falling back to a default when unset or non-numeric. */
export function parseIntOr(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

/** Parse an optional integer env var: undefined when unset, empty or non-numeric. */
export function parseIntOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined || value === '') return undefined;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** The default lead of the translated-audio pacer (ms), see `TranslationRuntimeConfig.paceLeadMs`. */
export const DEFAULT_PACE_LEAD_MS = 200;
/** Below one 20 ms frame no frame could ever fit the lead; `MediaPacer` raises such a lead to one frame. */
const MIN_PACE_LEAD_MS = 20;
/** A lead this large exceeds the jitter buffer the pacer exists to protect (about 4 s); accepted, but warned. */
const LARGE_PACE_LEAD_MS = 2000;

/**
 * Parse a pacer lead variable (`TRANSLATION_PACE_LEAD_MS`, `AGENT_PACE_LEAD_MS`), saying through `warn` what a
 * value that is not what the operator meant is taken as: unset → the default; not a whole number → the default
 * (a typo must not silently change the lead); negative → the default (a typo such as -200 must not silently
 * remove the fix; 0 is the explicit off switch for translation, and for the agent the pacer raises 0 to one
 * frame); 1-19 → 20, the one-frame floor the pacer applies anyway; over 2 s → accepted with a warning. Shared
 * by the Node and Worker runtimes and by the agent config, so every lead is read the same way.
 */
export function parsePaceLeadMs(value: string | undefined, warn: (message: string) => void, name = 'TRANSLATION_PACE_LEAD_MS'): number {
	if (value === undefined || value === '') return DEFAULT_PACE_LEAD_MS;
	if (!/^\s*-?\d+\s*$/.test(value)) {
		warn(`${name}=${value} is not a whole number of milliseconds; using ${DEFAULT_PACE_LEAD_MS}`);
		return DEFAULT_PACE_LEAD_MS;
	}
	const parsed = parseInt(value, 10);
	if (parsed < 0) {
		warn(`${name}=${value} is negative; using ${DEFAULT_PACE_LEAD_MS} (set 0 to disable pacing)`);
		return DEFAULT_PACE_LEAD_MS;
	}
	if (parsed > 0 && parsed < MIN_PACE_LEAD_MS) {
		warn(`${name}=${value} is less than one ${MIN_PACE_LEAD_MS} ms frame; using ${MIN_PACE_LEAD_MS}`);
		return MIN_PACE_LEAD_MS;
	}
	if (parsed > LARGE_PACE_LEAD_MS) {
		warn(
			`${name}=${value} lets ${parsed} ms of audio run ahead of real time, ` +
				`which a client's jitter buffer (about 4 s) may not hold`,
		);
	}
	return parsed;
}
