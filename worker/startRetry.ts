/**
 * Retry a container start that failed for a reason the platform itself calls transient.
 *
 * On 2026-10-22 every failed start the Worker saw (28 of them, four colos, ten hours) was one of
 * the errors below, thrown from the Durable Object stub while Cloudflare's own infrastructure
 * recovered: the object could not be reached or re-instantiated for one to a few seconds, and the
 * same session connected on the bridge's next redial. Support confirmed the cause (case 02391953)
 * and that the "overloaded" message is a routing-layer queue limit during recovery, not load on the
 * object. A retry inside the request absorbs the short recoveries entirely and turns the longer ones
 * into one bridge redial instead of several rounds of its exponential backoff.
 *
 * Not retried: capacity (no container instance available) and rate limiting (too many starts per
 * second), which the SDK reports with their own messages and which a retry would only make worse,
 * and anything else, since an unknown failure is not known to be transient. The budget is small on
 * purpose: audio is buffering behind the upgrade, and the bridge's own first retry fires after one
 * second, so by the time it does we have either succeeded or stopped trying.
 */

/** Message fragments the platform used for start failures that cleared within seconds. */
const TRANSIENT_START_FAILURES = [
	'durable object is overloaded',
	'is no longer active',
	'storage is no longer accessible',
	'internal error; reference',
	'reset because its code was updated',
	'network connection lost',
];

export function isTransientStartFailure(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return TRANSIENT_START_FAILURES.some((fragment) => message.includes(fragment));
}

export interface StartRetryOptions {
	/** Waits before each retry, in ms; the number of entries is the number of retries. */
	delaysMs?: number[];
	/** Injected for tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Called before each retry with the attempt that failed (1-based) and its error. */
	onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const DEFAULT_DELAYS_MS = [250, 750];

/**
 * Run `start` and, if it fails transiently, run it again after each delay in turn. Resolves with the
 * first success; rejects with the first non-transient error immediately, or with the last transient
 * error once the delays are used up.
 */
export async function startWithRetries<T>(start: () => Promise<T>, options: StartRetryOptions = {}): Promise<T> {
	const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 1; ; attempt++) {
		try {
			return await start();
		} catch (error) {
			const delay = delays[attempt - 1];
			if (delay === undefined || !isTransientStartFailure(error)) {
				throw error;
			}
			options.onRetry?.(attempt, error, delay);
			await sleep(delay);
		}
	}
}
