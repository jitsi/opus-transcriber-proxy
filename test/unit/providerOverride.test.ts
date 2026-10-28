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
 * Unit tests for the KV provider overrides (worker/providerOverride.ts).
 *
 * The decision logic is pure, so most of these drive `decideProviderOverride` directly, against
 * the transcribe slot. The async wrapper is covered for the things only it can get wrong: skipping
 * the KV read entirely when the request names a provider, swallowing a KV failure, and reading the
 * value as text so that a malformed entry is reported as an operator typo rather than as an
 * infrastructure failure. The two other slots (speech-to-speech and text translation) are covered
 * for what differs: their key, parameter, provider list and credential fallbacks, and that
 * applying several slots to one request rewrites each parameter independently.
 *
 * The load-bearing property throughout: every rejection path must leave the request alone, because
 * the server fails a session handed a provider it cannot use (the container closes the socket with
 * 1002; the Worker refuses a /translate upgrade).
 */
import { describe, it, expect, vi } from 'vitest';
import {
	applyProviderOverride,
	applyProviderOverrides,
	decideProviderOverride,
	resolveProviderOverride,
	MAX_OVERRIDE_WINDOW_MS,
	MIN_PLAUSIBLE_UNTIL_MS,
	TEXT_TRANSLATION_PROVIDER_SLOT,
	TRANSCRIBE_PROVIDER_SLOT,
	TRANSLATE_PROVIDER_SLOT,
	type ProviderOverrideEnv,
	type ProviderOverrideSlot,
} from '../../worker/providerOverride';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const VALID = { provider: 'deepgram', until: NOW + 60_000, reason: 'xAI outage' };

/** Entries are stored in KV as strings; the decision function parses them. */
const j = (value: unknown) => JSON.stringify(value);

/** Default opts: the transcribe slot, no explicit param, every provider configured. */
function opts(over: Partial<Parameters<typeof decideProviderOverride<string>>[1]> = {}) {
	return { slot: TRANSCRIBE_PROVIDER_SLOT as ProviderOverrideSlot, hasProviderParam: false, isConfigured: () => true, now: NOW, ...over };
}

describe('decideProviderOverride', () => {
	it('applies a well-formed, unexpired override', () => {
		const decision = decideProviderOverride(j(VALID), opts());
		expect(decision).toEqual({ applied: true, provider: 'deepgram', until: VALID.until, reason: 'xAI outage' });
	});

	it('omits reason when the entry has none', () => {
		const decision = decideProviderOverride(j({ provider: 'openai', until: NOW + 1000 }), opts());
		expect(decision).toMatchObject({ applied: true, provider: 'openai' });
		expect((decision as { reason?: string }).reason).toBeUndefined();
	});

	it('never overrides a request that names a provider explicitly', () => {
		// The whole point of rule 1: an explicitly chosen provider (openai_custom in particular,
		// which carries the caller's own endpoint and key) must survive untouched.
		const decision = decideProviderOverride(j(VALID), opts({ hasProviderParam: true }));
		expect(decision.applied).toBe(false);
	});

	it('does nothing when no override is set', () => {
		expect(decideProviderOverride(null, opts()).applied).toBe(false);
		expect(decideProviderOverride(undefined, opts()).applied).toBe(false);
		expect(decideProviderOverride('   ', opts()).applied).toBe(false);
	});

	it('reports a malformed value as a parse error, not as a KV failure', () => {
		// An operator typo must not read like an infrastructure problem, or it sends them looking
		// at KV health instead of at the value they just wrote.
		const decision = decideProviderOverride('{provider: deepgram}', opts());
		expect(decision).toMatchObject({ applied: false, level: 'error' });
		expect((decision as { why: string }).why).toContain('not valid JSON');
	});

	it.each([
		['a bare string', j('deepgram')],
		['a number', j(42)],
		['null', j(null)],
		['an array', j([{ provider: 'deepgram', until: NOW + 1000 }])],
	])('rejects an entry that is %s', (_label, raw) => {
		const decision = decideProviderOverride(raw, opts());
		expect(decision).toMatchObject({ applied: false, level: 'error' });
	});

	it.each([
		['openai_custom', 'carries a per-request URL and key'],
		['dummy', 'produces no real transcription'],
		['bogus', 'is not a provider at all'],
		[42, 'is not even a string'],
		[undefined, 'is missing'],
	])('refuses provider %s', (provider) => {
		const decision = decideProviderOverride(j({ provider, until: NOW + 1000 }), opts());
		expect(decision).toMatchObject({ applied: false, level: 'error' });
	});

	it.each([
		['missing', 'null'],
		['not a number', '"2026-01-01"'],
		['NaN', 'NaN'],
		['Infinity', 'Infinity'],
	])('refuses an override whose until is %s', (_label, literal) => {
		// An entry with no usable expiry would be a permanent override — the state this mechanism
		// exists to make impossible. NaN/Infinity are written as raw literals because they do not
		// survive JSON.stringify, and JSON.parse rejects them outright, which is itself the error path.
		const decision = decideProviderOverride(`{"provider":"deepgram","until":${literal}}`, opts());
		expect(decision).toMatchObject({ applied: false, level: 'error' });
	});

	it('refuses a seconds-granularity until as malformed, not as expired', () => {
		// The likeliest operator slip, because --ttl on the same command line takes seconds. Reporting
		// it as merely "expired" at info would leave the operator believing the override is armed
		// while traffic stays on the failing provider.
		const decision = decideProviderOverride(j({ provider: 'deepgram', until: Math.floor((NOW + 7_200_000) / 1000) }), opts());
		expect(decision).toMatchObject({ applied: false, level: 'error' });
		expect((decision as { why: string }).why).toContain('millisecond');
	});

	it('treats the plausibility floor as the boundary', () => {
		const below = decideProviderOverride(j({ provider: 'deepgram', until: MIN_PLAUSIBLE_UNTIL_MS - 1 }), opts());
		expect(below).toMatchObject({ applied: false, level: 'error' });

		// At the floor it is a real timestamp, just long past — an ordinary expiry.
		const atFloor = decideProviderOverride(j({ provider: 'deepgram', until: MIN_PLAUSIBLE_UNTIL_MS }), opts());
		expect(atFloor).toMatchObject({ applied: false, level: 'info' });
	});

	it('refuses an expired override, so the primary is re-tested automatically', () => {
		const decision = decideProviderOverride(j({ provider: 'deepgram', until: NOW - 1 }), opts());
		expect(decision).toMatchObject({ applied: false, level: 'info' });
	});

	it('treats until exactly equal to now as expired', () => {
		const decision = decideProviderOverride(j({ provider: 'deepgram', until: NOW }), opts());
		expect(decision.applied).toBe(false);
	});

	it('accepts a window exactly at the cap but refuses one beyond it', () => {
		const atCap = decideProviderOverride(j({ provider: 'deepgram', until: NOW + MAX_OVERRIDE_WINDOW_MS }), opts());
		expect(atCap.applied).toBe(true);

		const overCap = decideProviderOverride(j({ provider: 'deepgram', until: NOW + MAX_OVERRIDE_WINDOW_MS + 1 }), opts());
		expect(overCap).toMatchObject({ applied: false, level: 'error' });
	});

	it('refuses a provider with no API key configured', () => {
		// Without this check the container would close every session with 1002.
		const decision = decideProviderOverride(j(VALID), opts({ isConfigured: () => false }));
		expect(decision).toMatchObject({ applied: false, level: 'error' });
	});

	it('checks the explicit parameter before inspecting a malformed entry', () => {
		// A connection the override could never affect must not produce an operator-facing error.
		const decision = decideProviderOverride('garbage', opts({ hasProviderParam: true }));
		expect(decision).toMatchObject({ applied: false, level: 'debug' });
	});
});

describe('the slots', () => {
	it('each names its own KV key and the parameter the server parses', () => {
		expect(TRANSCRIBE_PROVIDER_SLOT).toMatchObject({ key: 'transcribe:provider-override', param: 'provider' });
		expect(TRANSLATE_PROVIDER_SLOT).toMatchObject({ key: 'translate:provider-override', param: 'provider' });
		expect(TEXT_TRANSLATION_PROVIDER_SLOT).toMatchObject({ key: 'text-translation:provider-override', param: 'text_translation_provider' });
		// /transcribe and /translate both take `provider`, so they must be told apart by key.
		expect(TRANSCRIBE_PROVIDER_SLOT.key).not.toBe(TRANSLATE_PROVIDER_SLOT.key);
	});

	it('exclude the providers that cannot be an override target', () => {
		// openai_custom needs the caller's URL and key; dummy and stub produce nothing real.
		expect(TRANSCRIBE_PROVIDER_SLOT.providers).toEqual(['openai', 'deepgram', 'gemini', 'xai']);
		expect(TRANSLATE_PROVIDER_SLOT.providers).toEqual(['openai', 'xai']);
		expect(TEXT_TRANSLATION_PROVIDER_SLOT.providers).toEqual(['openai', 'xai', 'gemini', 'google']);
	});

	it('refuse a provider another slot accepts', () => {
		const decision = decideProviderOverride(j({ provider: 'deepgram', until: NOW + 1000 }), opts({ slot: TRANSLATE_PROVIDER_SLOT }));
		expect(decision).toMatchObject({ applied: false, level: 'error' });
		expect((decision as { why: string }).why).toContain('openai, xai');
	});

	describe('transcribe: configured when the provider key is set', () => {
		it.each([
			['openai', { OPENAI_API_KEY: 'k' }],
			['deepgram', { DEEPGRAM_API_KEY: 'k' }],
			['gemini', { GEMINI_API_KEY: 'k' }],
			['xai', { XAI_API_KEY: 'k' }],
		] as const)('%s', (provider, env) => {
			expect(TRANSCRIBE_PROVIDER_SLOT.isConfigured(env, provider)).toBe(true);
			expect(TRANSCRIBE_PROVIDER_SLOT.isConfigured({}, provider)).toBe(false);
		});

		it('treats an empty-string key as unconfigured', () => {
			// The Worker forwards XAI_API_KEY as '' when unset, which must not read as available.
			expect(TRANSCRIBE_PROVIDER_SLOT.isConfigured({ XAI_API_KEY: '' }, 'xai')).toBe(false);
		});
	});

	describe('translate: the translation key, falling back to the transcription key', () => {
		it.each([
			['openai', 'OPENAI_TRANSLATION_API_KEY', 'OPENAI_API_KEY'],
			['xai', 'XAI_TRANSLATION_API_KEY', 'XAI_API_KEY'],
		] as const)('%s', (provider, dedicated, fallback) => {
			expect(TRANSLATE_PROVIDER_SLOT.isConfigured({ [dedicated]: 'k' }, provider)).toBe(true);
			expect(TRANSLATE_PROVIDER_SLOT.isConfigured({ [fallback]: 'k' }, provider)).toBe(true);
			expect(TRANSLATE_PROVIDER_SLOT.isConfigured({}, provider)).toBe(false);
		});
	});

	describe('text translation: the per-provider key, falling back to the transcription key', () => {
		it.each([
			['openai', 'TEXT_TRANSLATION_OPENAI_API_KEY', 'OPENAI_API_KEY'],
			['xai', 'TEXT_TRANSLATION_XAI_API_KEY', 'XAI_API_KEY'],
			['gemini', 'TEXT_TRANSLATION_GEMINI_API_KEY', 'GEMINI_API_KEY'],
		] as const)('%s', (provider, dedicated, fallback) => {
			expect(TEXT_TRANSLATION_PROVIDER_SLOT.isConfigured({ [dedicated]: 'k' }, provider)).toBe(true);
			expect(TEXT_TRANSLATION_PROVIDER_SLOT.isConfigured({ [fallback]: 'k' }, provider)).toBe(true);
			expect(TEXT_TRANSLATION_PROVIDER_SLOT.isConfigured({}, provider)).toBe(false);
		});

		it('google takes either credential and has no fallback to a Gemini key', () => {
			// A Gemini/AI Studio key is not valid for translation.googleapis.com (src/config.ts).
			expect(TEXT_TRANSLATION_PROVIDER_SLOT.isConfigured({ TEXT_TRANSLATION_GOOGLE_API_KEY: 'k' }, 'google')).toBe(true);
			expect(TEXT_TRANSLATION_PROVIDER_SLOT.isConfigured({ TEXT_TRANSLATION_GOOGLE_CREDENTIALS_JSON: '{}' }, 'google')).toBe(true);
			expect(TEXT_TRANSLATION_PROVIDER_SLOT.isConfigured({ GEMINI_API_KEY: 'k' }, 'google')).toBe(false);
		});
	});
});

describe('applyProviderOverride', () => {
	it('sets the provider parameter and preserves the upgrade header', () => {
		const original = new Request('https://example.test/transcribe?sessionId=abc&sendBack=true', {
			headers: { Upgrade: 'websocket', 'X-Custom': 'kept' },
		});
		const rewritten = applyProviderOverride(original, TRANSCRIBE_PROVIDER_SLOT, 'deepgram');

		const url = new URL(rewritten.url);
		expect(url.searchParams.get('provider')).toBe('deepgram');
		expect(url.searchParams.get('sessionId')).toBe('abc');
		expect(url.searchParams.get('sendBack')).toBe('true');
		expect(rewritten.headers.get('Upgrade')).toBe('websocket');
		expect(rewritten.headers.get('X-Custom')).toBe('kept');
	});

	it('leaves the original request untouched', () => {
		const original = new Request('https://example.test/transcribe?sessionId=abc');
		applyProviderOverride(original, TRANSCRIBE_PROVIDER_SLOT, 'openai');
		expect(new URL(original.url).searchParams.has('provider')).toBe(false);
	});

	it('sets the text-translation parameter for that slot', () => {
		const rewritten = applyProviderOverride(new Request('https://example.test/transcribe'), TEXT_TRANSLATION_PROVIDER_SLOT, 'google');
		expect(new URL(rewritten.url).searchParams.get('text_translation_provider')).toBe('google');
		expect(new URL(rewritten.url).searchParams.has('provider')).toBe(false);
	});
});

describe('resolveProviderOverride', () => {
	const env = (kvValue: string | null, fail = false): ProviderOverrideEnv => ({
		DEEPGRAM_API_KEY: 'k',
		CONFIG_KV: {
			get: fail ? vi.fn().mockRejectedValue(new Error('kv exploded')) : vi.fn().mockResolvedValue(kvValue),
		},
	});

	it('reads the override key as text and applies it', async () => {
		const e = env(j(VALID));
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), e, TRANSCRIBE_PROVIDER_SLOT, NOW);

		expect(decision).toMatchObject({ applied: true, provider: 'deepgram' });
		// text, not json: `type: 'json'` throws on a malformed value, which would be reported as a KV
		// failure rather than as the operator typo it is.
		expect(e.CONFIG_KV!.get).toHaveBeenCalledWith(TRANSCRIBE_PROVIDER_SLOT.key, expect.objectContaining({ type: 'text' }));
	});

	it('skips the KV read entirely when the request names a provider', async () => {
		const e = env(j(VALID));
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe?provider=openai_custom'), e, TRANSCRIBE_PROVIDER_SLOT, NOW);

		expect(decision.applied).toBe(false);
		expect(e.CONFIG_KV!.get).not.toHaveBeenCalled();
	});

	it('applies no override when the binding is absent', async () => {
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), { DEEPGRAM_API_KEY: 'k' }, TRANSCRIBE_PROVIDER_SLOT, NOW);
		expect(decision.applied).toBe(false);
	});

	it('swallows a KV failure rather than failing the connection', async () => {
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), env(null, true), TRANSCRIBE_PROVIDER_SLOT, NOW);
		expect(decision).toMatchObject({ applied: false, level: 'error' });
		expect((decision as { why: string }).why).toContain('kv exploded');
	});

	it('reports a malformed stored value as a parse error, not a KV failure', async () => {
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), env('not-json-at-all'), TRANSCRIBE_PROVIDER_SLOT, NOW);
		expect(decision).toMatchObject({ applied: false, level: 'error' });
		expect((decision as { why: string }).why).toContain('not valid JSON');
		expect((decision as { why: string }).why).not.toContain('KV read failed');
	});

	it('does not apply an override whose provider key is missing from the env', async () => {
		const e: ProviderOverrideEnv = { CONFIG_KV: { get: vi.fn().mockResolvedValue(j(VALID)) } };
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), e, TRANSCRIBE_PROVIDER_SLOT, NOW);
		expect(decision.applied).toBe(false);
	});
});

describe('applyProviderOverrides', () => {
	/** A KV holding one entry per key. */
	const kv = (entries: Record<string, string>) => ({ get: vi.fn(async (key: string) => entries[key] ?? null) });
	const allKeys = { OPENAI_API_KEY: 'k', DEEPGRAM_API_KEY: 'k', GEMINI_API_KEY: 'k', XAI_API_KEY: 'k', TEXT_TRANSLATION_GOOGLE_API_KEY: 'k' };

	it('reads each slot by its own key and rewrites each parameter', async () => {
		const store = kv({
			[TRANSCRIBE_PROVIDER_SLOT.key]: j({ provider: 'deepgram', until: NOW + 1000 }),
			[TEXT_TRANSLATION_PROVIDER_SLOT.key]: j({ provider: 'google', until: NOW + 1000 }),
		});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const { request, applied } = await applyProviderOverrides(
				new Request('https://example.test/transcribe?sessionId=s', { headers: { Upgrade: 'websocket' } }),
				{ ...allKeys, CONFIG_KV: store },
				[TRANSCRIBE_PROVIDER_SLOT, TEXT_TRANSLATION_PROVIDER_SLOT],
				NOW,
			);
			const url = new URL(request.url);
			expect(url.searchParams.get('provider')).toBe('deepgram');
			expect(url.searchParams.get('text_translation_provider')).toBe('google');
			expect(url.searchParams.get('sessionId')).toBe('s');
			expect(request.headers.get('Upgrade')).toBe('websocket');
			expect(applied).toEqual({ transcribe: 'deepgram', 'text-translation': 'google' });
			expect(store.get).toHaveBeenCalledTimes(2);
			expect(log).toHaveBeenCalledTimes(2);
			expect(log.mock.calls.map((c) => c[0])).toEqual([
				expect.stringMatching(/^Transcription provider override applied: provider=deepgram/),
				expect.stringMatching(/^Text translation provider override applied: provider=google/),
			]);
		} finally {
			log.mockRestore();
		}
	});

	it('applies the slots independently: one explicit parameter pins only its own slot', async () => {
		const store = kv({
			[TRANSCRIBE_PROVIDER_SLOT.key]: j({ provider: 'deepgram', until: NOW + 1000 }),
			[TEXT_TRANSLATION_PROVIDER_SLOT.key]: j({ provider: 'google', until: NOW + 1000 }),
		});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const { request, applied } = await applyProviderOverrides(
				new Request('https://example.test/transcribe?provider=openai_custom'),
				{ ...allKeys, CONFIG_KV: store },
				[TRANSCRIBE_PROVIDER_SLOT, TEXT_TRANSLATION_PROVIDER_SLOT],
				NOW,
			);
			expect(new URL(request.url).searchParams.get('provider')).toBe('openai_custom');
			expect(new URL(request.url).searchParams.get('text_translation_provider')).toBe('google');
			expect(applied).toEqual({ 'text-translation': 'google' });
			// The pinned slot costs no KV read.
			expect(store.get).toHaveBeenCalledTimes(1);
			expect(store.get).toHaveBeenCalledWith(TEXT_TRANSLATION_PROVIDER_SLOT.key, expect.anything());
		} finally {
			log.mockRestore();
		}
	});

	it('leaves the request alone and reports nothing when no slot applies', async () => {
		const { request, applied } = await applyProviderOverrides(
			new Request('https://example.test/translate?sessionId=s'),
			{ ...allKeys, CONFIG_KV: kv({}) },
			[TRANSLATE_PROVIDER_SLOT],
			NOW,
		);
		expect(new URL(request.url).searchParams.has('provider')).toBe(false);
		expect(applied).toEqual({});
	});

	it('logs a malformed entry at error and still forwards the request', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const { request, applied } = await applyProviderOverrides(
				new Request('https://example.test/translate'),
				{ ...allKeys, CONFIG_KV: kv({ [TRANSLATE_PROVIDER_SLOT.key]: 'garbage' }) },
				[TRANSLATE_PROVIDER_SLOT],
				NOW,
			);
			expect(applied).toEqual({});
			expect(new URL(request.url).searchParams.has('provider')).toBe(false);
			expect(error).toHaveBeenCalledTimes(1);
			expect(error.mock.calls[0][0]).toMatch(/^Speech-to-speech translation provider override not applied: override is not valid JSON/);
		} finally {
			error.mockRestore();
		}
	});
});
