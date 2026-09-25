// Worker-safe timer helper shared by the translation core and the Node backends. Lives under
// src/translate/ so the Worker bundle can import it (no node-only deps) — see check-worker-safe.mjs.

/**
 * Don't let a timer keep the process alive. `unref` exists on Node's Timeout but not on the
 * Worker's numeric timer id, so probe for it; the cast bridges both return types.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}
