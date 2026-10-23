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
 * Unit tests for worker/startRetry.ts: which container start failures are retried, how many times,
 * with which delays, and what the caller finally sees.
 */
import { describe, it, expect, vi } from 'vitest';
import { isTransientStartFailure, startWithRetries } from '../../../worker/startRetry';

const TRANSIENT = [
	'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
	'Durable Object storage is no longer accessible.',
	'internal error; reference = 81s1197ukdq154flodsngelt',
	'Durable Object reset because its code was updated.',
];

const NOT_TRANSIENT = [
	'There is no container instance that can be provided to this durable object',
	'You are requesting too many containers per second',
	'Durable Object is overloaded. Requests queued for too long.',
	// What the SDK rethrows from its port probe when the container crashed or never listened.
	'Network connection lost.',
	'The container is not listening',
	'Container exited with code 1',
];

const flagged = (message: string, flags: Record<string, boolean>) => Object.assign(new Error(message), flags);

describe('isTransientStartFailure', () => {
	it.each(TRANSIENT)('retries: %s', (message) => {
		expect(isTransientStartFailure(new Error(message))).toBe(true);
	});

	it.each(NOT_TRANSIENT)('does not retry: %s', (message) => {
		expect(isTransientStartFailure(new Error(message))).toBe(false);
	});

	it('matches case-insensitively and copes with non-Error rejections', () => {
		expect(isTransientStartFailure('STORAGE IS NO LONGER ACCESSIBLE')).toBe(true);
		expect(isTransientStartFailure(42)).toBe(false);
		expect(isTransientStartFailure(null)).toBe(false);
	});

	it('follows the retryable flag whatever the message says', () => {
		expect(isTransientStartFailure(flagged('something new', { retryable: true }))).toBe(true);
		expect(isTransientStartFailure(flagged('internal error; reference = x', { retryable: false }))).toBe(false);
	});

	it('never retries an overloaded object, even if also marked retryable', () => {
		expect(isTransientStartFailure(flagged('something new', { overloaded: true, retryable: true }))).toBe(false);
	});

	it('never retries capacity or rate limiting, even if flagged retryable', () => {
		expect(isTransientStartFailure(flagged(NOT_TRANSIENT[0], { retryable: true }))).toBe(false);
		expect(isTransientStartFailure(flagged(NOT_TRANSIENT[1], { retryable: true }))).toBe(false);
	});
});

describe('startWithRetries', () => {
	const sleeps: number[] = [];
	const sleep = async (ms: number) => {
		sleeps.push(ms);
	};
	// random() of 0.5 means no jitter, so the base delays are observable.
	const noJitter = { sleep, random: () => 0.5 };

	it('returns the first success without sleeping', async () => {
		sleeps.length = 0;
		const start = vi.fn(async () => 'ok');
		expect(await startWithRetries(start, noJitter)).toBe('ok');
		expect(start).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it('retries a transient failure after each configured delay and returns the eventual success', async () => {
		sleeps.length = 0;
		const start = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error(TRANSIENT[2]))
			.mockRejectedValueOnce(new Error(TRANSIENT[0]))
			.mockResolvedValueOnce('ok');
		const onRetry = vi.fn();
		expect(await startWithRetries(start, { ...noJitter, onRetry })).toBe('ok');
		expect(start).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([250, 750]);
		expect(onRetry.mock.calls.map(([attempt, , delay]) => [attempt, delay])).toEqual([
			[1, 250],
			[2, 750],
		]);
	});

	it('calls start afresh for every attempt, so the caller can use a new stub each time', async () => {
		let made = 0;
		const start = vi.fn(async () => {
			made++;
			if (made < 3) throw new Error(TRANSIENT[3]);
			return made;
		});
		expect(await startWithRetries(start, noJitter)).toBe(3);
	});

	it('gives up with the last transient error once the delays are used up', async () => {
		sleeps.length = 0;
		const errors = [new Error(TRANSIENT[2]), new Error(TRANSIENT[1]), new Error(TRANSIENT[0])];
		const start = vi.fn<() => Promise<string>>();
		for (const e of errors) start.mockRejectedValueOnce(e);
		await expect(startWithRetries(start, noJitter)).rejects.toBe(errors[2]);
		expect(start).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([250, 750]);
	});

	it('throws a non-transient failure immediately', async () => {
		for (const message of NOT_TRANSIENT) {
			sleeps.length = 0;
			const failure = new Error(message);
			const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure).mockResolvedValueOnce('ok');
			await expect(startWithRetries(start, noJitter)).rejects.toBe(failure);
			expect(start).toHaveBeenCalledTimes(1);
			expect(sleeps).toEqual([]);
		}
	});

	it('jitters each wait within the configured spread', async () => {
		const waits: number[] = [];
		const failTwice = () =>
			vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error(TRANSIENT[0])).mockRejectedValueOnce(new Error(TRANSIENT[0])).mockResolvedValueOnce('ok');
		await startWithRetries(failTwice(), { sleep: async (ms) => void waits.push(ms), random: () => 0 });
		await startWithRetries(failTwice(), { sleep: async (ms) => void waits.push(ms), random: () => 1 });
		expect(waits).toEqual([188, 563, 313, 938]);
	});

	it('stops retrying once the signal is aborted, during the wait or before it', async () => {
		const controller = new AbortController();
		const failure = new Error(TRANSIENT[0]);
		const start = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
		await expect(
			startWithRetries(start, { ...noJitter, signal: controller.signal, sleep: async () => controller.abort() }),
		).rejects.toBe(failure);
		expect(start).toHaveBeenCalledTimes(1);
		const aborted = AbortSignal.abort();
		const start2 = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
		await expect(startWithRetries(start2, { ...noJitter, signal: aborted })).rejects.toBe(failure);
		expect(start2).toHaveBeenCalledTimes(1);
	});

	it('honours custom delays, including none', async () => {
		sleeps.length = 0;
		const failOnce = () => vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error(TRANSIENT[0])).mockResolvedValueOnce('ok');
		await expect(startWithRetries(failOnce(), { ...noJitter, delaysMs: [] })).rejects.toThrow(/no longer active/);
		expect(await startWithRetries(failOnce(), { ...noJitter, delaysMs: [10] })).toBe('ok');
		expect(sleeps).toEqual([10]);
	});

	it('really waits by default', async () => {
		vi.useFakeTimers();
		const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error(TRANSIENT[0])).mockResolvedValueOnce('ok');
		const pending = startWithRetries(start, { delaysMs: [250], jitter: 0 });
		await vi.advanceTimersByTimeAsync(249);
		expect(start).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toBe('ok');
		expect(start).toHaveBeenCalledTimes(2);
	});
});
