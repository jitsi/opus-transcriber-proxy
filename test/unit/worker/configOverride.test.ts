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
 * Unit tests for the KV config overrides: the variable table (worker/vars.ts), its value types,
 * the per-entry decision and the resolver that overlays applied entries on the env
 * (worker/configOverride.ts), and how the effective env reaches the container and the coordinator.
 *
 * The load-bearing property throughout: an entry that cannot be used leaves the Worker variable in
 * place, so a typo in KV never changes what a session runs with.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Env } from '../../../worker/env';
import {
	CONFIG_CACHE_TTL_MS,
	KV_FAILURE_RETRY_MS,
	KV_STALE_MAX_MS,
	CONFIG_OVERRIDABLE_NAMES,
	decideConfigOverride,
	describeConfigOverrideDecision,
	KV_BULK_GET_MAX_KEYS,
	logConfigOverrideDecisions,
	resetConfigOverrideCache,
	resolveConfigOverrides,
	type ConfigOverrideKv,
} from '../../../worker/configOverride';
import { configKey, KV_OVERRIDABLE_VARS, WORKER_VARS, type KvType, type VarSpec } from '../../../worker/vars';
import { buildContainerEnvVars, buildWorkerInfo } from '../../../worker/containerEnv';
import { ContainerCoordinator, coordinatorConfig } from '../../../worker/ContainerCoordinator';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const j = (value: unknown) => JSON.stringify(value);
const typeOf = (name: keyof typeof WORKER_VARS): KvType => {
	const kv = (WORKER_VARS[name] as VarSpec).kv;
	if (!kv) throw new Error(`${name} is not KV-overridable`);
	return kv;
};
const normalize = (name: keyof typeof WORKER_VARS, value: unknown) => typeOf(name).normalize(value);

/** A fake KV namespace holding `entries` (key -> stored string), recording each bulk read. */
function fakeKv(entries: Record<string, string>) {
	const get = vi.fn(async (keys: string[], _opts: { type: 'text'; cacheTtl?: number }) => new Map(keys.map((k) => [k, entries[k] ?? null])));
	return { kv: { get } as ConfigOverrideKv, get };
}

const env = (overrides: Partial<Env> = {}): Env => ({ OPENAI_API_KEY: 'sk', ...overrides }) as unknown as Env;

beforeEach(() => resetConfigOverrideCache());

describe('the variable table', () => {
	it('derives each KV key from the variable name', () => {
		expect(configKey('XAI_ENDPOINTING')).toBe('config:XAI_ENDPOINTING');
	});

	it('never makes a credential overridable from KV', () => {
		// KV is not a secret store, and a container validates provider keys against the env it
		// started with.
		const credentialShaped = Object.keys(WORKER_VARS).filter((n) => /(^|_)(KEY|SECRET|TOKEN|CREDENTIALS_JSON|HEADERS)$/.test(n));
		expect(credentialShaped.length).toBeGreaterThan(10);
		for (const name of credentialShaped) {
			expect(CONFIG_OVERRIDABLE_NAMES, name).not.toContain(name);
		}
	});

	it('leaves provider selection to the provider overrides', () => {
		for (const name of ['PROVIDERS_PRIORITY', 'TRANSLATION_PROVIDER', 'TEXT_TRANSLATION_PROVIDERS_PRIORITY']) {
			expect(CONFIG_OVERRIDABLE_NAMES).not.toContain(name);
		}
	});

	it('keeps the security posture of openai_custom and /agent out of KV', () => {
		for (const name of [
			'ENABLE_OPENAI_CUSTOM_PROVIDER',
			'OPENAI_CUSTOM_REQUIRE_WSS',
			'AGENT_REQUIRE_WSS',
			'AGENT_ALLOW_PRIVATE_ENDPOINTS',
			'AGENT_ALLOW_UNAUTHENTICATED',
			'AGENT_PROVISIONING_URL',
		]) {
			expect(CONFIG_OVERRIDABLE_NAMES).not.toContain(name);
		}
	});

	it('covers the agreed groups', () => {
		for (const name of [
			'ENABLE_TRANSCRIBE',
			'LOG_LEVEL',
			'XAI_STT_URL',
			'XAI_TRANSLATION_URL',
			'XAI_ENDPOINTING',
			'ROUTING_MODE',
			'SLEEP_AFTER',
			'USE_DISPATCHER',
			'GEMINI_MODEL',
			'OPENAI_TURN_DETECTION',
			'SESSION_RESUME_GRACE_PERIOD',
			'DUMP_WEBSOCKET_MESSAGES',
			'AGENT_ALLOWED_HOSTS',
		]) {
			expect(CONFIG_OVERRIDABLE_NAMES).toContain(name);
		}
	});
});

describe('value types', () => {
	it('bool accepts JSON booleans and the strings, case-insensitively', () => {
		expect(normalize('XAI_DIARIZE', true)).toBe('true');
		expect(normalize('XAI_DIARIZE', 'FALSE')).toBe('false');
		expect(normalize('XAI_DIARIZE', 'yes')).toHaveProperty('error');
		expect(normalize('XAI_DIARIZE', 1)).toHaveProperty('error');
	});

	it('int accepts integers and decimal strings, and enforces its lower bound', () => {
		expect(normalize('XAI_ENDPOINTING', 1000)).toBe('1000');
		expect(normalize('XAI_ENDPOINTING', ' 850 ')).toBe('850');
		expect(normalize('XAI_ENDPOINTING', -1)).toHaveProperty('error');
		expect(normalize('XAI_ENDPOINTING', 1.5)).toHaveProperty('error');
		expect(normalize('XAI_ENDPOINTING', '850ms')).toHaveProperty('error');
		expect(normalize('XAI_CONNECT_ATTEMPTS', 0)).toHaveProperty('error');
		// No bound: a negative value is meaningful (-1 lets Gemini choose its own thinking budget).
		expect(normalize('TEXT_TRANSLATION_GEMINI_THINKING_BUDGET', -1)).toBe('-1');
	});

	it('float accepts finite numbers', () => {
		expect(normalize('XAI_SMART_TURN', 0.5)).toBe('0.5');
		expect(normalize('XAI_SMART_TURN', '0.7')).toBe('0.7');
		expect(normalize('XAI_SMART_TURN', '')).toHaveProperty('error');
		expect(normalize('XAI_SMART_TURN', 'high')).toHaveProperty('error');
	});

	it('enums match case-insensitively and are written back as declared', () => {
		expect(normalize('XAI_ENCODING', 'OPUS')).toBe('opus');
		expect(normalize('LOG_LEVEL', 'debug')).toBe('debug');
		expect(normalize('XAI_ENCODING', 'pcm')).toMatchObject({ error: expect.stringContaining('l16|opus') });
		expect(normalize('ROUTING_MODE', 'pool')).toBe('pool');
	});

	it('JSON objects are accepted as objects or strings and written back as JSON', () => {
		const td = { type: 'server_vad', threshold: 0.6 };
		expect(normalize('OPENAI_TURN_DETECTION', td)).toBe(JSON.stringify(td));
		expect(normalize('OPENAI_TURN_DETECTION', JSON.stringify(td))).toBe(JSON.stringify(td));
		expect(normalize('OPENAI_TURN_DETECTION', '[1]')).toHaveProperty('error');
		expect(normalize('OPENAI_TURN_DETECTION', '{bad')).toHaveProperty('error');
	});

	it('URLs must parse and use wss', () => {
		expect(normalize('XAI_STT_URL', 'wss://eu.api.x.ai/v1/stt')).toBe('wss://eu.api.x.ai/v1/stt');
		expect(normalize('XAI_STT_URL', 'ws://api.x.ai/v1/stt')).toHaveProperty('error');
		expect(normalize('XAI_STT_URL', 'https://api.x.ai/v1/stt')).toHaveProperty('error');
		expect(normalize('XAI_STT_URL', 'api.x.ai')).toHaveProperty('error');
	});

	it('URLs may not carry credentials, a query or a fragment (the value is logged and sent in info)', () => {
		expect(normalize('XAI_STT_URL', 'wss://user:secret@api.x.ai/v1/stt')).toHaveProperty('error');
		expect(normalize('XAI_STT_URL', 'wss://user@api.x.ai/v1/stt')).toHaveProperty('error');
		expect(normalize('XAI_STT_URL', 'wss://api.x.ai/v1/stt?token=secret')).toHaveProperty('error');
		expect(normalize('XAI_STT_URL', 'wss://api.x.ai/v1/stt?')).toHaveProperty('error');
		expect(normalize('XAI_STT_URL', 'wss://api.x.ai/v1/stt#x')).toHaveProperty('error');
	});

	it('SLEEP_AFTER takes only the SDK time format, and no less than the keepalive floor', () => {
		// The SDK throws on any other form when it renews the activity timer.
		expect(normalize('SLEEP_AFTER', '10m')).toBe('10m');
		expect(normalize('SLEEP_AFTER', '1h')).toBe('1h');
		expect(normalize('SLEEP_AFTER', 600)).toBe('600s');
		expect(normalize('SLEEP_AFTER', '3m')).toHaveProperty('error');
		expect(normalize('SLEEP_AFTER', '4m')).toBe('4m');
		expect(normalize('SLEEP_AFTER', 240)).toBe('240s');
		expect(normalize('SLEEP_AFTER', 239)).toHaveProperty('error');
		// An upper bound too: a container that never sleeps is billed for every idle second.
		expect(normalize('SLEEP_AFTER', '24h')).toBe('24h');
		expect(normalize('SLEEP_AFTER', '25h')).toHaveProperty('error');
		expect(normalize('SLEEP_AFTER', '1000000000000000s')).toHaveProperty('error');
		// The talk-silence timeout must stay above the 100 ms RTP gap threshold; 0 (never end a talk)
		// is unsafe for the realtime translations endpoint.
		expect(normalize('TRANSLATION_TALK_SILENCE_TIMEOUT_MS', 101)).toBe('101');
		expect(normalize('TRANSLATION_TALK_SILENCE_TIMEOUT_MS', 100)).toHaveProperty('error');
		expect(normalize('TRANSLATION_TALK_SILENCE_TIMEOUT_MS', 0)).toHaveProperty('error');
		expect(normalize('SLEEP_AFTER', '10 m')).toHaveProperty('error');
		expect(normalize('SLEEP_AFTER', '10min')).toHaveProperty('error');
	});

	it('strings accept any string, including an empty one', () => {
		expect(normalize('XAI_LANGUAGE', 'de')).toBe('de');
		expect(normalize('XAI_LANGUAGE', '')).toBe('');
		expect(normalize('XAI_LANGUAGE', 5)).toHaveProperty('error');
	});
});

describe('decideConfigOverride', () => {
	const endpointing = typeOf('XAI_ENDPOINTING');

	it('applies a well-formed, unexpired entry', () => {
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: 1000, until: NOW + 60_000, reason: 'test' }), NOW);
		expect(d).toEqual({ name: 'XAI_ENDPOINTING', applied: true, value: '1000', until: NOW + 60_000, reason: 'test' });
	});

	it('takes -1 as no expiry', () => {
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: 1000, until: -1 }), NOW);
		expect(d).toMatchObject({ applied: true, value: '1000', until: -1 });
		expect(describeConfigOverrideDecision(d)).toContain('no expiry');
	});

	it('has no cap on how far away the expiry is', () => {
		const tenYears = NOW + 10 * 365 * 24 * 3600 * 1000;
		expect(decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: 1000, until: tenYears }), NOW).applied).toBe(true);
	});

	it('unsets the variable for a null value', () => {
		expect(decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: null, until: -1 }), NOW)).toMatchObject({ applied: true, value: '' });
	});

	it.each([
		['no until', { value: 1000 }, 'no usable "until"'],
		['an until in seconds', { value: 1000, until: Math.floor(NOW / 1000) }, 'not a millisecond timestamp'],
		['a negative until other than -1', { value: 1000, until: -2 }, 'not a millisecond timestamp'],
		['no value', { until: -1 }, 'no "value"'],
		['a value of the wrong type', { value: 'soon', until: -1 }, 'not usable'],
	])('refuses an entry with %s, at error level', (_label, entry, why) => {
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, j(entry), NOW);
		expect(d).toMatchObject({ applied: false, level: 'error', why: expect.stringContaining(why) });
	});

	it('never lets an override empty the /agent host allowlist', () => {
		// An empty allowlist allows any public host, so a null or empty override would loosen it while
		// looking like a reset. Deleting the key is how the Worker variable is restored.
		const hosts = typeOf('AGENT_ALLOWED_HOSTS');
		for (const value of [null, '', '   ', ',', ' , ', ', ,']) {
			const d = decideConfigOverride('AGENT_ALLOWED_HOSTS', hosts, j({ value, until: -1 }), NOW);
			expect(d, JSON.stringify(value)).toMatchObject({ applied: false, level: 'error' });
		}
		expect(decideConfigOverride('AGENT_ALLOWED_HOSTS', hosts, j({ value: '.example.com', until: -1 }), NOW)).toMatchObject({
			applied: true,
			value: '.example.com',
		});
	});

	it('normalizes the /agent host allowlist the way the container reads it', () => {
		const d = decideConfigOverride('AGENT_ALLOWED_HOSTS', typeOf('AGENT_ALLOWED_HOSTS'), j({ value: ' A.Example.com, ,b.example.org ', until: -1 }), NOW);
		expect(d).toMatchObject({ applied: true, value: 'a.example.com,b.example.org' });
	});

	it('only lets an override narrow a non-empty Worker host allowlist', () => {
		// The override exists as an incident lever to tighten the list. Against a Worker list of
		// .example.com, an entry outside it (or a wider one, like .com) would loosen it.
		const hosts = typeOf('AGENT_ALLOWED_HOSTS');
		const worker = { AGENT_ALLOWED_HOSTS: '.example.com, agents.example.org' };
		const decide = (value: string) => decideConfigOverride('AGENT_ALLOWED_HOSTS', hosts, j({ value, until: -1 }), NOW, worker);
		expect(decide('a.example.com')).toMatchObject({ applied: true, value: 'a.example.com' });
		expect(decide('.eu.example.com,agents.example.org')).toMatchObject({ applied: true });
		expect(decide('example.com')).toMatchObject({ applied: true });
		for (const wider of ['evil.com', '.com', 'example.org', 'a.example.com,evil.com', 'xexample.com']) {
			expect(decide(wider), wider).toMatchObject({ applied: false, level: 'error' });
		}
		// With no Worker list (any public host), every non-empty list narrows it.
		expect(decideConfigOverride('AGENT_ALLOWED_HOSTS', hosts, j({ value: 'evil.com', until: -1 }), NOW, {})).toMatchObject({ applied: true });
	});

	it('refuses ROUTING_MODE=autoscale when the Worker has no coordinator binding', () => {
		const mode = typeOf('ROUTING_MODE');
		const raw = j({ value: 'autoscale', until: -1 });
		expect(decideConfigOverride('ROUTING_MODE', mode, raw, NOW, {})).toMatchObject({ applied: false, level: 'error' });
		expect(decideConfigOverride('ROUTING_MODE', mode, raw, NOW, { CONTAINER_COORDINATOR: {} })).toMatchObject({ applied: true, value: 'autoscale' });
		expect(decideConfigOverride('ROUTING_MODE', mode, j({ value: 'pool', until: -1 }), NOW, {})).toMatchObject({ applied: true, value: 'pool' });
	});

	it.each([
		['a nanosecond timestamp', 1e18],
		['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
		['a microsecond timestamp', NOW * 1000],
	])('refuses %s as "until" instead of applying it', (_label, until) => {
		// A value past the Date range made the decision log throw on every upgrade; one inside it (a
		// microsecond timestamp, year ~57000) was a quiet permanent override.
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: 1000, until }), NOW);
		expect(d).toMatchObject({ applied: false, level: 'error' });
		expect((d as { why: string }).why).toContain('-1');
		expect(() => describeConfigOverrideDecision(d)).not.toThrow();
	});

	it('describes a decision without throwing, whatever its "until"', () => {
		const d = { name: 'XAI_ENDPOINTING', applied: true as const, value: '1', until: 1e18 };
		expect(() => describeConfigOverrideDecision(d)).not.toThrow();
	});

	it('mentions -1 when the until is unusable', () => {
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: 1 }), NOW);
		expect((d as { why: string }).why).toContain('-1 for no expiry');
	});

	it('reports a wrong value type even on an expired entry', () => {
		// Otherwise an operator re-arming the entry by bumping only `until` would learn of it only then.
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: 'soon', until: NOW - 1 }), NOW);
		expect(d).toMatchObject({ applied: false, level: 'error' });
	});

	it('ignores an expired entry at info level', () => {
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, j({ value: 1000, until: NOW - 1 }), NOW);
		expect(d).toMatchObject({ applied: false, level: 'info', why: expect.stringContaining('expired') });
	});

	it('reports malformed JSON as a parse error', () => {
		const d = decideConfigOverride('XAI_ENDPOINTING', endpointing, '{value: 1000}', NOW);
		expect(d).toMatchObject({ applied: false, level: 'error', why: expect.stringContaining('not valid JSON') });
	});
});

describe('resolveConfigOverrides', () => {
	it('returns the env unchanged, and reads nothing, without a KV binding', async () => {
		const e = env({ XAI_ENDPOINTING: '850' });
		const r = await resolveConfigOverrides(e, NOW);
		expect(r.env).toBe(e);
		expect(r.applied).toEqual({});
	});

	it('reads every overridable key in one bulk read, edge-cached', async () => {
		const { kv, get } = fakeKv({});
		await resolveConfigOverrides(env({ CONFIG_KV: kv as never }), NOW);
		expect(get).toHaveBeenCalledTimes(1);
		const [keys, opts] = get.mock.calls[0];
		expect(keys).toEqual(KV_OVERRIDABLE_VARS.map(([n]) => `config:${n}`));
		expect(opts).toEqual({ type: 'text', cacheTtl: 60 });
	});

	it('overlays the entries that apply and leaves the rest of the env alone', async () => {
		const { kv } = fakeKv({
			'config:XAI_ENDPOINTING': j({ value: 1200, until: -1 }),
			'config:XAI_ENCODING': j({ value: 'pcm', until: -1 }), // wrong type: not applied
			'config:LOG_LEVEL': j({ value: 'debug', until: NOW - 1 }), // expired: not applied
		});
		const transcriber = { idFromName: () => 'id' };
		const base = env({ CONFIG_KV: kv as never, TRANSCRIBER: transcriber as never, XAI_ENDPOINTING: '850', XAI_ENCODING: 'opus', LOG_LEVEL: 'info' });
		const r = await resolveConfigOverrides(base, NOW);
		expect(r.applied).toEqual({ XAI_ENDPOINTING: '1200' });
		expect(r.env.XAI_ENDPOINTING).toBe('1200');
		expect(r.env.XAI_ENCODING).toBe('opus');
		expect(r.env.LOG_LEVEL).toBe('info');
		// The bindings survive the copy (they are enumerable own properties of the Worker env).
		expect(r.env.CONFIG_KV).toBe(kv);
		expect(r.env.TRANSCRIBER).toBe(transcriber);
		// The Worker's own env is not mutated.
		expect(base.XAI_ENDPOINTING).toBe('850');
		// One decision per key that holds something.
		expect(r.decisions.map((d) => d.name).sort()).toEqual(['LOG_LEVEL', 'XAI_ENCODING', 'XAI_ENDPOINTING']);
	});

	it('reads KV at most once per cache period in an isolate, and decides expiry afresh each time', async () => {
		// KV bills a bulk read per key, so reading every key on every request would cost one read per
		// overridable variable per request.
		const { kv, get } = fakeKv({ 'config:XAI_ENDPOINTING': j({ value: 1200, until: NOW + 10_000 }) });
		const e = env({ CONFIG_KV: kv as never });
		expect((await resolveConfigOverrides(e, NOW)).applied).toEqual({ XAI_ENDPOINTING: '1200' });
		// Within the period: no new read, but the entry has expired by now.
		expect((await resolveConfigOverrides(e, NOW + CONFIG_CACHE_TTL_MS - 1)).applied).toEqual({});
		expect(get).toHaveBeenCalledTimes(1);
		await resolveConfigOverrides(e, NOW + CONFIG_CACHE_TTL_MS);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it('does not share the cache between KV namespaces', async () => {
		const a = fakeKv({ 'config:XAI_ENDPOINTING': j({ value: 1, until: -1 }) });
		const b = fakeKv({ 'config:XAI_ENDPOINTING': j({ value: 2, until: -1 }) });
		expect((await resolveConfigOverrides(env({ CONFIG_KV: a.kv as never }), NOW)).applied).toEqual({ XAI_ENDPOINTING: '1' });
		expect((await resolveConfigOverrides(env({ CONFIG_KV: b.kv as never }), NOW)).applied).toEqual({ XAI_ENDPOINTING: '2' });
	});

	it(`retries a failed read only after ${KV_FAILURE_RETRY_MS} ms`, async () => {
		// During a KV outage, every request would otherwise wait for a failing read before routing.
		const get = vi.fn()
			.mockRejectedValueOnce(new Error('KV down'))
			.mockImplementation(async (keys: string[]) => new Map(keys.map((k) => [k, k === 'config:XAI_ENDPOINTING' ? j({ value: 9, until: -1 }) : null])));
		const e = env({ CONFIG_KV: { get } as never });
		expect((await resolveConfigOverrides(e, NOW)).applied).toEqual({});
		const during = await resolveConfigOverrides(e, NOW + KV_FAILURE_RETRY_MS - 1);
		expect(during.applied).toEqual({});
		expect(during.decisions).toEqual([{ name: '*', applied: false, level: 'error', why: 'KV read failed: KV down' }]);
		expect(get).toHaveBeenCalledTimes(1);
		expect((await resolveConfigOverrides(e, NOW + KV_FAILURE_RETRY_MS)).applied).toEqual({ XAI_ENDPOINTING: '9' });
		expect(get).toHaveBeenCalledTimes(2);
	});

	it('keeps the entries last read while KV fails, and still expires them on time', async () => {
		const until = NOW + CONFIG_CACHE_TTL_MS + 1000;
		const get = vi.fn()
			.mockImplementationOnce(async (keys: string[]) => new Map(keys.map((k) => [k, k === 'config:XAI_ENDPOINTING' ? j({ value: 1200, until }) : null])))
			.mockRejectedValue(new Error('KV down'));
		const e = env({ CONFIG_KV: { get } as never, XAI_ENDPOINTING: '850' });
		expect((await resolveConfigOverrides(e, NOW)).applied).toEqual({ XAI_ENDPOINTING: '1200' });

		const stale = await resolveConfigOverrides(e, NOW + CONFIG_CACHE_TTL_MS);
		expect(get).toHaveBeenCalledTimes(2);
		expect(stale.applied).toEqual({ XAI_ENDPOINTING: '1200' });
		expect(stale.env.XAI_ENDPOINTING).toBe('1200');
		expect(stale.decisions).toContainEqual({
			name: '*',
			applied: false,
			level: 'error',
			why: 'KV read failed: KV down; keeping the entries last read',
		});

		// The kept entry expires on time, and the next read waits for the retry period.
		expect((await resolveConfigOverrides(e, until)).applied).toEqual({});
		expect(get).toHaveBeenCalledTimes(2);
		await resolveConfigOverrides(e, NOW + CONFIG_CACHE_TTL_MS + KV_FAILURE_RETRY_MS);
		expect(get).toHaveBeenCalledTimes(3);
	});

	it(`drops the kept entries once the last good read is ${KV_STALE_MAX_MS} ms old`, async () => {
		// An entry with no expiry would otherwise outlive its deletion for as long as KV keeps failing.
		const get = vi.fn()
			.mockImplementationOnce(async (keys: string[]) => new Map(keys.map((k) => [k, k === 'config:XAI_ENDPOINTING' ? j({ value: 1200, until: -1 }) : null])))
			.mockRejectedValue(new Error('KV down'));
		const e = env({ CONFIG_KV: { get } as never, XAI_ENDPOINTING: '850' });
		await resolveConfigOverrides(e, NOW);
		expect((await resolveConfigOverrides(e, NOW + KV_STALE_MAX_MS - 1)).applied).toEqual({ XAI_ENDPOINTING: '1200' });

		const dropped = await resolveConfigOverrides(e, NOW + KV_STALE_MAX_MS + KV_FAILURE_RETRY_MS);
		expect(dropped.applied).toEqual({});
		expect(dropped.env).toBe(e);
		expect(dropped.decisions).toEqual([{ name: '*', applied: false, level: 'error', why: 'KV read failed: KV down' }]);
		// Still dropped on the reads after that.
		expect((await resolveConfigOverrides(e, NOW + KV_STALE_MAX_MS + 2 * KV_FAILURE_RETRY_MS)).applied).toEqual({});
	});

	it('degrades a KV failure to no override, with one error decision', async () => {
		const kv = { get: vi.fn(async () => Promise.reject(new Error('KV down'))) } as unknown as ConfigOverrideKv;
		const e = env({ CONFIG_KV: kv as never, XAI_ENDPOINTING: '850' });
		const r = await resolveConfigOverrides(e, NOW);
		expect(r.env).toBe(e);
		expect(r.decisions).toEqual([{ name: '*', applied: false, level: 'error', why: 'KV read failed: KV down' }]);
	});

	it('turns a value type that throws into one error decision instead of failing the request', async () => {
		const broken: KvType = { describe: 'x', normalize: () => { throw new Error('bug'); } };
		const { kv } = fakeKv({ 'config:BROKEN': j({ value: 1, until: -1 }), 'config:XAI_ENDPOINTING': j({ value: 7, until: -1 }) });
		const vars = [['BROKEN', broken] as const, ['XAI_ENDPOINTING', typeOf('XAI_ENDPOINTING')] as const];
		const r = await resolveConfigOverrides(env({ CONFIG_KV: kv as never }), NOW, vars);
		expect(r.applied).toEqual({ XAI_ENDPOINTING: '7' });
		expect(r.decisions).toContainEqual(expect.objectContaining({ name: 'BROKEN', applied: false, level: 'error' }));
	});

	it('shares one KV read between concurrent requests that miss the cache', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const get = vi.fn(async (keys: string[]) => {
			await gate;
			return new Map(keys.map((k) => [k, k === 'config:XAI_ENDPOINTING' ? j({ value: 3, until: -1 }) : null]));
		});
		const e = env({ CONFIG_KV: { get } as never });
		const both = Promise.all([resolveConfigOverrides(e, NOW), resolveConfigOverrides(e, NOW + 1)]);
		release();
		const [a, b] = await both;
		expect(get).toHaveBeenCalledTimes(1);
		expect(a.applied).toEqual({ XAI_ENDPOINTING: '3' });
		expect(b.applied).toEqual({ XAI_ENDPOINTING: '3' });
	});

	it('keeps a separate cache per KV binding, so two bindings do not evict each other', async () => {
		const a = fakeKv({});
		const b = fakeKv({});
		for (let i = 0; i < 3; i++) {
			await resolveConfigOverrides(env({ CONFIG_KV: a.kv as never }), NOW + i);
			await resolveConfigOverrides(env({ CONFIG_KV: b.kv as never }), NOW + i);
		}
		expect(a.get).toHaveBeenCalledTimes(1);
		expect(b.get).toHaveBeenCalledTimes(1);
	});

	it(`splits the read into bulk reads of at most ${KV_BULK_GET_MAX_KEYS} keys`, async () => {
		const many = Array.from({ length: KV_BULK_GET_MAX_KEYS + 5 }, (_, i) => [`V${i}`, typeOf('XAI_ENDPOINTING')] as const);
		const { kv, get } = fakeKv({ 'config:V104': j({ value: 7, until: -1 }) });
		const r = await resolveConfigOverrides(env({ CONFIG_KV: kv as never }), NOW, many);
		expect(get.mock.calls.map(([keys]) => keys.length)).toEqual([KV_BULK_GET_MAX_KEYS, 5]);
		expect(r.applied).toEqual({ V104: '7' });
	});

	it('logs applied and expired entries at log level and mistakes at error level', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		logConfigOverrideDecisions([
			{ name: 'A', applied: true, value: '1', until: -1 },
			{ name: 'B', applied: false, level: 'info', why: 'override expired at x' },
			{ name: 'C', applied: false, level: 'error', why: 'bad' },
			{ name: 'D', applied: false, level: 'debug', why: 'quiet' },
		]);
		expect(log.mock.calls.map((c) => c[0])).toEqual(['Config override applied: A="1", no expiry', 'Config override for B not applied: override expired at x']);
		expect(error.mock.calls.map((c) => c[0])).toEqual(['Config override for C not applied: bad']);
	});
});

describe('the effective env downstream', () => {
	it('reaches the container env, with the record of what was overridden', async () => {
		const { kv } = fakeKv({
			'config:XAI_ENDPOINTING': j({ value: 1200, until: -1 }),
			'config:DEEPGRAM_DIARIZE': j({ value: true, until: -1 }),
			'config:GEMINI_MODEL': j({ value: 'gemini-x', until: -1 }),
		});
		const r = await resolveConfigOverrides(env({ CONFIG_KV: kv as never }), NOW);
		const vars = buildContainerEnvVars(r.env, r.applied);
		expect(vars.XAI_ENDPOINTING).toBe('1200');
		expect(vars.DEEPGRAM_DIARIZE).toBe('true');
		expect(vars.GEMINI_MODEL).toBe('gemini-x');
		expect(JSON.parse(vars.CONFIG_OVERRIDES)).toEqual({ XAI_ENDPOINTING: '1200', DEEPGRAM_DIARIZE: 'true', GEMINI_MODEL: 'gemini-x' });
	});

	it('lets a null value restore the container default of an always-forwarded variable', async () => {
		const { kv } = fakeKv({ 'config:DEEPGRAM_MODEL': j({ value: null, until: -1 }) });
		const r = await resolveConfigOverrides(env({ CONFIG_KV: kv as never, DEEPGRAM_MODEL: 'nova-2' }), NOW);
		expect(buildContainerEnvVars(r.env).DEEPGRAM_MODEL).toBe('nova-3-general');
	});

	it('is reported in the worker info block', () => {
		const info = buildWorkerInfo(new Request('https://x/transcribe'), env(), undefined, { USE_DISPATCHER: 'true' });
		expect(info.configOverrides).toEqual({ USE_DISPATCHER: 'true' });
		expect(buildWorkerInfo(new Request('https://x/transcribe'), env(), undefined, {})).not.toHaveProperty('configOverrides');
	});

	it('falls back to the coordinator defaults for an empty or non-numeric value', () => {
		expect(coordinatorConfig({ MAX_CONNECTIONS_PER_CONTAINER: '', MIN_CONTAINERS: 'two', SCALE_DOWN_IDLE_TIME: 'x' })).toEqual({
			maxConnectionsPerContainer: 10,
			minContainers: 2,
			scaleDownIdleTime: 600000,
		});
	});

	it('makes the coordinator apply a KV override of its limits on its next request', async () => {
		const storage = new Map<string, unknown>();
		const state = {
			storage: { get: async (k: string) => storage.get(k), put: async (k: string, v: unknown) => void storage.set(k, v) },
			blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
		};
		const { kv } = fakeKv({ 'config:MAX_CONNECTIONS_PER_CONTAINER': j({ value: 1, until: -1 }) });
		const coordinator = new ContainerCoordinator(state as never, env({ CONFIG_KV: kv as never, MIN_CONTAINERS: '1' }));
		const post = (path: string, body: unknown) =>
			coordinator.fetch(new Request(`http://coordinator${path}`, { method: 'POST', body: JSON.stringify(body) }));
		const { containerId } = (await (await post('/assign', { sessionId: 's1' })).json()) as { containerId: string };
		await post('/connection-opened', { sessionId: 's1', containerId });
		// With the override's limit of 1 the first container is full, so the next session gets a new one.
		const second = (await (await post('/assign', { sessionId: 's2' })).json()) as { containerId: string };
		expect(second.containerId).not.toBe(containerId);
	});

	it('gives the coordinator its limits', () => {
		expect(coordinatorConfig({})).toEqual({ maxConnectionsPerContainer: 10, minContainers: 2, scaleDownIdleTime: 600000 });
		expect(coordinatorConfig({ MAX_CONNECTIONS_PER_CONTAINER: '25', MIN_CONTAINERS: '0', SCALE_DOWN_IDLE_TIME: '1000' })).toEqual({
			maxConnectionsPerContainer: 25,
			minContainers: 0,
			scaleDownIdleTime: 1000,
		});
	});
});
