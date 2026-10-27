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
 * Unit tests for the KV provider override (worker/providerOverride.ts).
 *
 * The decision logic is pure, so most of these drive `decideProviderOverride` directly. The async
 * wrapper is covered for the two things only it can get wrong: skipping the KV read entirely when
 * the request names a provider, and swallowing a KV failure.
 *
 * The load-bearing property throughout: every rejection path must leave the request alone, because
 * the container closes the socket with 1002 when handed a provider it cannot use.
 */
import { describe, it, expect, vi } from 'vitest';
import {
	applyProviderOverride,
	decideProviderOverride,
	providerIsConfigured,
	resolveProviderOverride,
	MAX_OVERRIDE_WINDOW_MS,
	PROVIDER_OVERRIDE_KEY,
	type OverridableProvider,
	type ProviderOverrideEnv,
} from '../../worker/providerOverride';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const VALID = { provider: 'deepgram', until: NOW + 60_000, reason: 'xAI outage' };

/** Default opts: no explicit param, every provider configured. */
function opts(over: Partial<Parameters<typeof decideProviderOverride>[1]> = {}) {
	return { hasProviderParam: false, isConfigured: () => true, now: NOW, ...over };
}

describe('decideProviderOverride', () => {
	it('applies a well-formed, unexpired override', () => {
		const decision = decideProviderOverride(VALID, opts());
		expect(decision).toEqual({ applied: true, provider: 'deepgram', until: VALID.until, reason: 'xAI outage' });
	});

	it('omits reason when the entry has none', () => {
		const decision = decideProviderOverride({ provider: 'openai', until: NOW + 1000 }, opts());
		expect(decision).toMatchObject({ applied: true, provider: 'openai' });
		expect((decision as { reason?: string }).reason).toBeUndefined();
	});

	it('never overrides a request that names a provider explicitly', () => {
		// The whole point of rule 1: an explicitly chosen provider (openai_custom in particular,
		// which carries the caller's own endpoint and key) must survive untouched.
		const decision = decideProviderOverride(VALID, opts({ hasProviderParam: true }));
		expect(decision.applied).toBe(false);
	});

	it('does nothing when no override is set', () => {
		expect(decideProviderOverride(null, opts()).applied).toBe(false);
		expect(decideProviderOverride(undefined, opts()).applied).toBe(false);
	});

	it.each([
		['a string', 'deepgram'],
		['a number', 42],
		['an array', [{ provider: 'deepgram', until: NOW + 1000 }]],
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
		const decision = decideProviderOverride({ provider, until: NOW + 1000 }, opts());
		expect(decision).toMatchObject({ applied: false, level: 'error' });
	});

	it.each([
		['missing', undefined],
		['not a number', '2026-01-01'],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
	])('refuses an override whose until is %s', (_label, until) => {
		// An entry with no usable expiry would be a permanent override — the state this mechanism
		// exists to make impossible.
		const decision = decideProviderOverride({ provider: 'deepgram', until }, opts());
		expect(decision).toMatchObject({ applied: false, level: 'error' });
	});

	it('refuses an expired override, so the primary is re-tested automatically', () => {
		const decision = decideProviderOverride({ provider: 'deepgram', until: NOW - 1 }, opts());
		expect(decision).toMatchObject({ applied: false, level: 'info' });
	});

	it('treats until exactly equal to now as expired', () => {
		const decision = decideProviderOverride({ provider: 'deepgram', until: NOW }, opts());
		expect(decision.applied).toBe(false);
	});

	it('accepts a window exactly at the cap but refuses one beyond it', () => {
		const atCap = decideProviderOverride({ provider: 'deepgram', until: NOW + MAX_OVERRIDE_WINDOW_MS }, opts());
		expect(atCap.applied).toBe(true);

		const overCap = decideProviderOverride({ provider: 'deepgram', until: NOW + MAX_OVERRIDE_WINDOW_MS + 1 }, opts());
		expect(overCap).toMatchObject({ applied: false, level: 'error' });
	});

	it('refuses a provider with no API key configured', () => {
		// Without this check the container would close every session with 1002.
		const decision = decideProviderOverride(VALID, opts({ isConfigured: () => false }));
		expect(decision).toMatchObject({ applied: false, level: 'error' });
	});

	it('checks the explicit parameter before inspecting a malformed entry', () => {
		// A connection the override could never affect must not produce an operator-facing error.
		const decision = decideProviderOverride('garbage', opts({ hasProviderParam: true }));
		expect(decision).toMatchObject({ applied: false, level: 'debug' });
	});
});

describe('providerIsConfigured', () => {
	it.each([
		['openai', { OPENAI_API_KEY: 'k' }],
		['deepgram', { DEEPGRAM_API_KEY: 'k' }],
		['gemini', { GEMINI_API_KEY: 'k' }],
		['xai', { XAI_API_KEY: 'k' }],
	])('reports %s configured when its key is set', (provider, env) => {
		expect(providerIsConfigured(env as ProviderOverrideEnv, provider as OverridableProvider)).toBe(true);
		expect(providerIsConfigured({}, provider as OverridableProvider)).toBe(false);
	});

	it('treats an empty-string key as unconfigured', () => {
		// The Worker forwards XAI_API_KEY as '' when unset, which must not read as available.
		expect(providerIsConfigured({ XAI_API_KEY: '' }, 'xai')).toBe(false);
	});
});

describe('applyProviderOverride', () => {
	it('sets the provider parameter and preserves the upgrade header', () => {
		const original = new Request('https://example.test/transcribe?sessionId=abc&sendBack=true', {
			headers: { Upgrade: 'websocket', 'X-Custom': 'kept' },
		});
		const rewritten = applyProviderOverride(original, 'deepgram');

		const url = new URL(rewritten.url);
		expect(url.searchParams.get('provider')).toBe('deepgram');
		expect(url.searchParams.get('sessionId')).toBe('abc');
		expect(url.searchParams.get('sendBack')).toBe('true');
		expect(rewritten.headers.get('Upgrade')).toBe('websocket');
		expect(rewritten.headers.get('X-Custom')).toBe('kept');
	});

	it('leaves the original request untouched', () => {
		const original = new Request('https://example.test/transcribe?sessionId=abc');
		applyProviderOverride(original, 'openai');
		expect(new URL(original.url).searchParams.has('provider')).toBe(false);
	});
});

describe('resolveProviderOverride', () => {
	const env = (kvValue: unknown, fail = false): ProviderOverrideEnv => ({
		DEEPGRAM_API_KEY: 'k',
		CONFIG_KV: {
			get: fail ? vi.fn().mockRejectedValue(new Error('kv exploded')) : vi.fn().mockResolvedValue(kvValue),
		},
	});

	it('reads the override key as json and applies it', async () => {
		const e = env(VALID);
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), e, NOW);

		expect(decision).toMatchObject({ applied: true, provider: 'deepgram' });
		expect(e.CONFIG_KV!.get).toHaveBeenCalledWith(PROVIDER_OVERRIDE_KEY, expect.objectContaining({ type: 'json' }));
	});

	it('skips the KV read entirely when the request names a provider', async () => {
		const e = env(VALID);
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe?provider=openai_custom'), e, NOW);

		expect(decision.applied).toBe(false);
		expect(e.CONFIG_KV!.get).not.toHaveBeenCalled();
	});

	it('applies no override when the binding is absent', async () => {
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), { DEEPGRAM_API_KEY: 'k' }, NOW);
		expect(decision.applied).toBe(false);
	});

	it('swallows a KV failure rather than failing the connection', async () => {
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), env(null, true), NOW);
		expect(decision).toMatchObject({ applied: false, level: 'error' });
		expect((decision as { why: string }).why).toContain('kv exploded');
	});

	it('does not apply an override whose provider key is missing from the env', async () => {
		const e: ProviderOverrideEnv = { CONFIG_KV: { get: vi.fn().mockResolvedValue(VALID) } };
		const decision = await resolveProviderOverride(new Request('https://example.test/transcribe'), e, NOW);
		expect(decision.applied).toBe(false);
	});
});
