// Worker-safe env helpers shared by the Node and Worker translation runtimes. Lives under
// src/translate/ so both import one copy (no node-only deps) — see nodeRuntime.ts / worker/translationRuntime.ts.

/** Parse an integer env var, falling back to a default when unset or non-numeric. */
export function parseIntOr(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}
