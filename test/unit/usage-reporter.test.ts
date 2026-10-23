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

	it('POSTs one event with the token as bearer, duration_seconds + a UUID event_id in the body', async () => {
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
			events: [{ duration_seconds: 42.5, event_id: expect.any(String) }],
		});
		// targetLanguage stays local-only — never in the body.
		expect((init as RequestInit).body).not.toContain('targetLanguage');
		expect((init as RequestInit).body).not.toContain('"es"');
	});

	it('preserves a caller-supplied eventId instead of minting a fresh one', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		reportTranslationUsage(
			{ token: 'tt_abc', durationSeconds: 1, targetLanguage: 'es', eventId: 'caller-supplied-key' },
			{ url: URL, logger: stubLogger() },
		);
		await flushTranslationUsage();

		expect(postedBodies(fetchMock)[0].events).toEqual([{ duration_seconds: 1, event_id: 'caller-supplied-key' }]);
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
		expect(byToken.get('Bearer tt_a').events).toEqual([
			{ duration_seconds: 1, event_id: expect.any(String) },
			{ duration_seconds: 3, event_id: expect.any(String) },
		]);
		expect(byToken.get('Bearer tt_b').events).toEqual([{ duration_seconds: 2, event_id: expect.any(String) }]);
		// Each reported event gets its own key.
		const [a0, a1] = byToken.get('Bearer tt_a').events;
		expect(a0.event_id).not.toBe(a1.event_id);
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
		expect(postedBodies(fetchMock)[0].events).toEqual([
			{ duration_seconds: 5, event_id: expect.any(String) },
			{ duration_seconds: 7, event_id: expect.any(String) },
		]);
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
			expect(postedBodies(fetchMock)[0].events).toEqual([{ duration_seconds: 3, event_id: expect.any(String) }]);
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
