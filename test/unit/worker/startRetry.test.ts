/**
 * Unit tests for worker/startRetry.ts: which container start failures are retried, how many times,
 * with which delays, and what the caller finally sees.
 */
import { describe, it, expect, vi } from 'vitest';
import { isTransientStartFailure, startWithRetries } from '../../../worker/startRetry';

const TRANSIENT = [
	'Durable Object is overloaded. Requests queued for too long.',
	'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.',
	'Durable Object storage is no longer accessible.',
	'internal error; reference = 81s1197ukdq154flodsngelt',
	'Durable Object reset because its code was updated.',
	'Network connection lost.',
];

const NOT_TRANSIENT = [
	'There is no container instance that can be provided to this durable object',
	'You are requesting too many containers per second',
	'The container is not listening',
	'Container exited with code 1',
];

describe('isTransientStartFailure', () => {
	it.each(TRANSIENT)('retries: %s', (message) => {
		expect(isTransientStartFailure(new Error(message))).toBe(true);
	});

	it.each(NOT_TRANSIENT)('does not retry: %s', (message) => {
		expect(isTransientStartFailure(new Error(message))).toBe(false);
	});

	it('matches case-insensitively and on non-Error rejections', () => {
		expect(isTransientStartFailure('DURABLE OBJECT IS OVERLOADED')).toBe(true);
		expect(isTransientStartFailure(42)).toBe(false);
	});
});

describe('isTransientStartFailure: stub error flags', () => {
	const flagged = (message: string, flags: Record<string, boolean>) => Object.assign(new Error(message), flags);

	it('retries on retryable or overloaded flags whatever the message says', () => {
		expect(isTransientStartFailure(flagged('something new', { retryable: true }))).toBe(true);
		expect(isTransientStartFailure(flagged('something new', { overloaded: true }))).toBe(true);
	});

	it('does not retry an error the platform marks non-retryable, even with a known message', () => {
		expect(isTransientStartFailure(flagged('internal error; reference = x', { retryable: false }))).toBe(false);
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

	it('returns the first success without sleeping', async () => {
		sleeps.length = 0;
		const start = vi.fn(async () => 'ok');
		expect(await startWithRetries(start, { sleep })).toBe('ok');
		expect(start).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it('retries a transient failure after each configured delay and returns the eventual success', async () => {
		sleeps.length = 0;
		const start = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error(TRANSIENT[3]))
			.mockRejectedValueOnce(new Error(TRANSIENT[1]))
			.mockResolvedValueOnce('ok');
		const onRetry = vi.fn();
		expect(await startWithRetries(start, { sleep, onRetry })).toBe('ok');
		expect(start).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([250, 750]);
		expect(onRetry.mock.calls.map(([attempt, , delay]) => [attempt, delay])).toEqual([
			[1, 250],
			[2, 750],
		]);
	});

	it('gives up with the last transient error once the delays are used up', async () => {
		sleeps.length = 0;
		const errors = [new Error(TRANSIENT[3]), new Error(TRANSIENT[2]), new Error(TRANSIENT[1])];
		const start = vi.fn<() => Promise<string>>();
		for (const e of errors) start.mockRejectedValueOnce(e);
		await expect(startWithRetries(start, { sleep })).rejects.toBe(errors[2]);
		expect(start).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([250, 750]);
	});

	it('waits the longest delay before retrying an overloaded object', async () => {
		sleeps.length = 0;
		const overloaded = Object.assign(new Error('Durable Object is overloaded.'), { overloaded: true });
		const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(overloaded).mockResolvedValueOnce('ok');
		expect(await startWithRetries(start, { sleep })).toBe('ok');
		expect(sleeps).toEqual([750]);
	});

	it('throws a non-transient failure immediately', async () => {
		sleeps.length = 0;
		const capacity = new Error(NOT_TRANSIENT[0]);
		const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(capacity).mockResolvedValueOnce('ok');
		await expect(startWithRetries(start, { sleep })).rejects.toBe(capacity);
		expect(start).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it('honours custom delays, including none', async () => {
		sleeps.length = 0;
		const failOnce = () => vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error(TRANSIENT[0])).mockResolvedValueOnce('ok');
		await expect(startWithRetries(failOnce(), { sleep, delaysMs: [] })).rejects.toThrow(/overloaded/);
		expect(await startWithRetries(failOnce(), { sleep, delaysMs: [10] })).toBe('ok');
		expect(sleeps).toEqual([10]);
	});

	it('really waits by default', async () => {
		vi.useFakeTimers();
		const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error(TRANSIENT[0])).mockResolvedValueOnce('ok');
		const pending = startWithRetries(start, { delaysMs: [250] });
		await vi.advanceTimersByTimeAsync(249);
		expect(start).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toBe('ok');
		expect(start).toHaveBeenCalledTimes(2);
	});
});
