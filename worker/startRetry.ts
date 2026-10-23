/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
 * platform's own answer; message fragments are a fallback for errors that arrive without them.
 * An overloaded object is retried only after the longest delay, never the short one.
 *
 * Not retried: capacity (no container instance available) and rate limiting (too many starts per
 * second), which the SDK reports with their own messages and which a retry would only make worse,
 * and anything else, since an unknown failure is not known to be transient. The waits add about a
 * second (250 + 750 ms) on top of the attempts themselves, each of which can take as long as the
 * port wait: small on purpose, since audio is buffering behind the upgrade and the bridge redials
 * on its own soon after.
 */

/** Fallback for errors without the stub flags: messages the platform used for failures that cleared. */
const TRANSIENT_START_FAILURES = [
	'durable object is overloaded',
	'is no longer active',
	'storage is no longer accessible',
	'internal error; reference',
	'reset because its code was updated',
	'network connection lost',
];

/** Capacity and rate limiting are never retried, whatever flags they carry. */
const NEVER_RETRY = ['there is no container instance that can be provided', 'requesting too many containers per second'];

function messageOf(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function isOverloaded(error: unknown): boolean {
	return (error as { overloaded?: unknown } | null)?.overloaded === true || messageOf(error).includes('durable object is overloaded');
}

export function isTransientStartFailure(error: unknown): boolean {
	const message = messageOf(error);
	if (NEVER_RETRY.some((fragment) => message.includes(fragment))) return false;
	const flags = error as { retryable?: unknown; overloaded?: unknown } | null;
	if (flags?.retryable === true || flags?.overloaded === true) return true;
	if (flags?.retryable === false) return false;
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
			let delay = delays[attempt - 1];
			if (delay === undefined || !isTransientStartFailure(error)) {
				throw error;
			}
			if (isOverloaded(error)) {
				delay = Math.max(...delays);
			}
			options.onRetry?.(attempt, error, delay);
			await sleep(delay);
		}
	}
}
