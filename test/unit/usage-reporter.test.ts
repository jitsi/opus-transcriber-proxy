/**
 * Tests for the translation usage reporter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// config reads process.env at import time; mock it so the reporter is "configured".
vi.mock('../../src/config', () => ({
	config: { translationUsage: { url: 'https://usage.test/report' } },
}));
// Avoid pulling in winston/OTLP transports.
vi.mock('../../src/logger', () => ({
	default: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { reportTranslationUsage, flushTranslationUsage, _resetForTesting } from '../../src/usage-reporter';

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

		reportTranslationUsage({ token: 'tt_abc', durationSeconds: 42.5, targetLanguage: 'es' });
		await flushTranslationUsage();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://usage.test/report');
		expect((init as RequestInit).method).toBe('POST');
		expect((init as any).headers.Authorization).toBe('Bearer tt_abc');
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			events: [{ duration_seconds: 42.5 }],
		});
	});

	it('groups by token — two tokens produce two POSTs', async () => {
		const fetchMock = okFetch();
		vi.stubGlobal('fetch', fetchMock);

		reportTranslationUsage({ token: 'tt_a', durationSeconds: 1, targetLanguage: 'en' });
		reportTranslationUsage({ token: 'tt_b', durationSeconds: 2, targetLanguage: 'de' });
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 3, targetLanguage: 'fr' });
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

		reportTranslationUsage({ token: '', durationSeconds: 10, targetLanguage: 'en' });
		reportTranslationUsage({ token: 'tt_a', durationSeconds: 0, targetLanguage: 'en' });
		reportTranslationUsage({ token: 'tt_a', durationSeconds: -5, targetLanguage: 'en' });
		await flushTranslationUsage();

		expect(fetchMock).not.toHaveBeenCalled();
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

		for (let i = 0; i < 50; i++) {
			reportTranslationUsage({ token: 'tt_a', durationSeconds: 1, targetLanguage: 'en' });
		}
		// Let the fire-and-forget flush() promise settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(postedBodies(fetchMock)[0].events).toHaveLength(50);
	});
});
