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
 * Retry a container start that failed for a reason the platform itself calls transient: the
 * container's Durable Object briefly unreachable or not re-instantiable while Cloudflare's own
 * infrastructure recovers. Those clear within one to a few seconds, so a retry inside the request
 * absorbs the short ones and turns the longer ones into a single bridge redial instead of several
 * rounds of its exponential backoff.
 *
 * Errors thrown by a Durable Object stub carry `retryable` and `overloaded` flags, which are the
 * platform's own answer; message fragments are a fallback for errors that arrive without them. Per
 * Cloudflare's guidance an overloaded object is never retried (a retry only deepens the queue), and
 * each retry goes through a fresh stub, since a stub can be broken after it throws (the caller's
 * `start` creates it).
 *
 * Not retried either: capacity (no container instance available) and rate limiting (too many starts
 * per second), which the SDK reports with their own messages and which a retry would only make
 * worse; a container that crashed or never listened (the SDK surfaces that as the port probe's own
 * error); and anything unrecognised, since an unknown failure is not known to be transient. The
 * waits add about a second (250 + 750 ms, jittered) on top of the attempts themselves, each of which
 * can take as long as the port wait, and no retry starts whose wait would end more than 5 s after
 * the first attempt began: small on purpose, since audio is buffering behind the upgrade and the
 * bridge redials on its own soon after.
 */

/** Fallback for errors without the stub flags: messages the platform used for failures that cleared. */
const TRANSIENT_START_FAILURES = [
	'is no longer active',
	'storage is no longer accessible',
	'internal error; reference',
	'reset because its code was updated',
];

/**
 * Never retried, whatever flags they carry (checked before the flags): capacity, rate limiting,
 * overload in the wordings the platform uses for it, and a container that crashed or never listened,
 * which the SDK's port probe surfaces as the raw connection error and which a network-class error
 * can carry `retryable: true` across the Durable Object boundary.
 */
const NEVER_RETRY = [
	'there is no container instance that can be provided',
	'requesting too many containers per second',
	'durable object is overloaded',
	'requests queued for too long',
	'too many requests queued',
	'exceeded its memory limit',
	'network connection lost',
	'container is not listening',
	'container exited',
];

function messageOf(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function isTransientStartFailure(error: unknown): boolean {
	const message = messageOf(error);
	if (NEVER_RETRY.some((fragment) => message.includes(fragment))) return false;
	const flags = error as { retryable?: unknown; overloaded?: unknown } | null;
	if (flags?.overloaded === true) return false;
	if (flags?.retryable === true) return true;
	if (flags?.retryable === false) return false;
	return TRANSIENT_START_FAILURES.some((fragment) => message.includes(fragment));
}

export interface StartRetryOptions {
	/** Waits before each retry, in ms; the number of entries is the number of retries. */
	delaysMs?: number[];
	/** Spread of the random jitter applied to each wait, as a fraction (0.25 means ±25%). */
	jitter?: number;
	/**
	 * No retry is started once this long (ms) has passed since the first attempt began: each attempt
	 * can take a whole port wait, and a transient error that arrives late must not hold the bridge
	 * for several of them.
	 */
	deadlineMs?: number;
	now?: () => number;
	/** Injected for tests. */
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	/** Called before each retry with the attempt that failed (1-based), its error and the wait. */
	onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const DEFAULT_DELAYS_MS = [250, 750];
const DEFAULT_JITTER = 0.25;
const DEFAULT_DEADLINE_MS = 5000;

/**
 * Run `start` and, if it fails transiently, run it again after each delay in turn. Resolves with the
 * first success; rejects with the first non-transient error immediately, or with the last transient
 * error once the delays are used up. Jitter keeps sessions that failed
 * together in a platform blip from retrying in lockstep.
 */
export async function startWithRetries<T>(start: () => Promise<T>, options: StartRetryOptions = {}): Promise<T> {
	const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
	const jitter = options.jitter ?? DEFAULT_JITTER;
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? Date.now;
	const deadline = now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
	for (let attempt = 1; ; attempt++) {
		try {
			return await start();
		} catch (error) {
			const base = delays[attempt - 1];
			if (base === undefined || !isTransientStartFailure(error)) {
				throw error;
			}
			const delay = Math.round(base * (1 - jitter + 2 * jitter * random()));
			if (now() + delay > deadline) {
				throw error;
			}
			options.onRetry?.(attempt, error, delay);
			await sleep(delay);
		}
	}
}

/**
 * Start a container through `startWithRetries`, creating a **fresh stub for every attempt** with
 * `makeStub` (Cloudflare's guidance: a Durable Object stub can be broken after it throws, so a retry
 * through the same one would fail the same way), and resolve with the stub whose start succeeded,
 * which is the one the caller must use for the request that follows.
 */
export async function startContainer<S>(
	makeStub: () => S,
	start: (stub: S) => Promise<unknown>,
	options: StartRetryOptions = {},
): Promise<S> {
	return startWithRetries(async () => {
		const stub = makeStub();
		await start(stub);
		return stub;
	}, options);
}

/**
 * How a start ended, for the `result` label of the start counter: `ok` on the first attempt
 * (including a container that was already running), `rescued` by a retry, `gave_up` when it failed
 * after retrying or with a transient failure no retry was left for (attempts or time), and `failed`
 * when it failed at once with one not to retry (overload, capacity, a crashed container, anything
 * unrecognised). So `failed` is exactly the starts the retry never touched.
 */
export type StartResult = 'ok' | 'rescued' | 'gave_up' | 'failed';

export function startResult(attempts: number, failure?: { error: unknown }): StartResult {
	if (!failure) return attempts > 1 ? 'rescued' : 'ok';
	const { error } = failure;
	return attempts > 1 || isTransientStartFailure(error) ? 'gave_up' : 'failed';
}
