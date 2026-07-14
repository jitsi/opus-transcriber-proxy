/**
 * Tests for the translation usage reporter.
 *
 * The reporter is runtime-agnostic: url + logger are injected per report via `deps`
 * (no ./config or ./logger imports to mock). We stub a logger and the global fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../../src/translate/runtime';
import { reportTranslationUsage, flushTranslationUsage, _resetForTesting } from '../../src/usage-reporter';

const URL = 'https://usage.test/report';

function stubLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function okFetch() {
	return vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
}

/** Parsed bodies of every fetch call, in order. */
function postedBodies(fetchMock: ReturnType<typeof vi.fn>): any[] {
	return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

describe('usage-reporter', () => {
	beforeEach(() => {
		_resetForTesting();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('POSTs one event with the token as bearer and only duration_seconds in the body', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		reportTranslationUsage({ token: 'tt_abc', durationSeconds: 42.5, targetLanguage: 'es' }, { url: URL, logger: stubLogger() });
		await flushTranslationUsage();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(URL);
		expect((init as RequestInit).method).toBe('POST');
		expect((init as any).headers.Authorization).toBe('Bearer tt_abc');
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			events: [{ duration_seconds: 42.5 }],
		});
	});

	it('groups by token — two tokens produce two POSTs', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		const deps = { url: URL, logger: stubLogger() };
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 1, targetLanguage: 'en' }, deps);
		reportTranslationUsage({ token: 'tt_b', durationSeconds: 2, targetLanguage: 'de' }, deps);
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 3, targetLanguage: 'fr' }, deps);
		await flushTranslationUsage();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const byToken = new Map<string, any>();
		for (const [, init] of fetchMock.mock.calls) {
			byToken.set((init as any).headers.Authorization, JSON.parse((init as RequestInit).body as string));
		}
		expect(byToken.get('Bearer tt_a').events).toEqual([{ duration_seconds: 1 }, { duration_seconds: 3 }]);
		expect(byToken.get('Bearer tt_b').events).toEqual([{ duration_seconds: 2 }]);
	});

	it('drops events with no token or non-positive duration', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		const deps = { url: URL, logger: stubLogger() };
		reportTranslationUsage({ token: '', durationSeconds: 10, targetLanguage: 'en' }, deps);
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 0, targetLanguage: 'en' }, deps);
		reportTranslationUsage({ token: 'tt_a', durationSeconds: -5, targetLanguage: 'en' }, deps);
		await flushTranslationUsage();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('warns once and drops when no url is configured', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		const logger = stubLogger();
		const deps = { url: undefined, logger };
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 1, targetLanguage: 'en' }, deps);
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 2, targetLanguage: 'en' }, deps);
		await flushTranslationUsage();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('flushTranslationUsage on an empty buffer is a no-op', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		await flushTranslationUsage();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('auto-flushes when the buffer hits the size threshold (50)', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		const deps = { url: URL, logger: stubLogger() };
		for (let i = 0; i < 50; i++) {
			reportTranslationUsage({ token: 'tt_a', durationSeconds: 1, targetLanguage: 'en' }, deps);
		}
		// Let the fire-and-forget flush() promise settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(postedBodies(fetchMock)[0].events).toHaveLength(50);
	});

	it('flushTranslationUsage flushes buffered events at shutdown', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		const deps = { url: URL, logger: stubLogger() };
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 5, targetLanguage: 'en' }, deps);
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 7, targetLanguage: 'en' }, deps);
		// Simulates the SIGTERM path: nothing has flushed yet (under the size/time thresholds).
		expect(fetchMock).not.toHaveBeenCalled();

		await flushTranslationUsage();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(postedBodies(fetchMock)[0].events).toEqual([{ duration_seconds: 5 }, { duration_seconds: 7 }]);
	});

	it('auto-flushes on the 1000ms timer when under the size threshold', async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = okFetch();
			vi.stubGlobal('fetch', fetchMock);

			const deps = { url: URL, logger: stubLogger() };
			reportTranslationUsage({ token: 'tt_a', durationSeconds: 3, targetLanguage: 'en' }, deps);
			// Under the 50-event threshold, so only the 1000ms timer will flush it.
			expect(fetchMock).not.toHaveBeenCalled();

			await vi.runAllTimersAsync();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(postedBodies(fetchMock)[0].events).toEqual([{ duration_seconds: 3 }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('warns (does not throw) when the endpoint returns a non-2xx status', async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
		vi.stubGlobal('fetch', fetchMock);

		const logger = stubLogger();
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 2, targetLanguage: 'en' }, { url: URL, logger });
		await flushTranslationUsage();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect((logger.warn as any).mock.calls[0][0]).toContain('429');
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('logs an error when the POST rejects (network error)', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('network down');
		});
		vi.stubGlobal('fetch', fetchMock);

		const logger = stubLogger();
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 2, targetLanguage: 'en' }, { url: URL, logger });
		await flushTranslationUsage();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledTimes(1);
	});
});
