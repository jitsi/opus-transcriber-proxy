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
 * Unit tests for worker/containerEnv.ts: the container environment the Worker builds from its
 * bindings, the instance-name env, and the `worker` block merged into the container's `info`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../../worker/env';
import { buildContainerEnvVars, buildWorkerInfo, instanceNameEnv } from '../../../worker/containerEnv';

const env = (overrides: Partial<Env> = {}): Env => ({ OPENAI_API_KEY: 'sk-test', ...overrides }) as unknown as Env;

describe('buildContainerEnvVars', () => {
	it('applies the container-side defaults when the Worker env is minimal', () => {
		const vars = buildContainerEnvVars(env());
		expect(vars.OPENAI_API_KEY).toBe('sk-test');
		expect(vars.OPENAI_MODEL).toBe('gpt-4o-transcribe');
		expect(vars.PROVIDERS_PRIORITY).toBe('openai');
		expect(vars.LOG_LEVEL).toBe('info');
		expect(vars.PORT).toBe('8080');
		expect(vars.HOST).toBe('0.0.0.0');
	});

	it('forwards an unset XAI_API_KEY as empty so the container disables the provider', () => {
		expect(buildContainerEnvVars(env()).XAI_API_KEY).toBe('');
		expect(buildContainerEnvVars(env({ XAI_API_KEY: 'xai-k' })).XAI_API_KEY).toBe('xai-k');
	});

	it('forwards the optional knobs only when set', () => {
		const unset = buildContainerEnvVars(env());
		for (const key of ['XAI_ENDPOINTING', 'XAI_STT_URL', 'ENABLE_TEXT_TRANSLATION', 'OPENAI_TRANSLATION_MODEL', 'ENABLE_AGENT']) {
			expect(unset).not.toHaveProperty(key);
		}
		const set = buildContainerEnvVars(env({ XAI_ENDPOINTING: '850', ENABLE_TEXT_TRANSLATION: 'true', ENABLE_AGENT: 'true' }));
		expect(set.XAI_ENDPOINTING).toBe('850');
		expect(set.ENABLE_TEXT_TRANSLATION).toBe('true');
		expect(set.ENABLE_AGENT).toBe('true');
	});

	it('forwards "0" for the talk-silence timeout (a non-empty string disables, it must not be dropped)', () => {
		expect(buildContainerEnvVars(env({ TRANSLATION_TALK_SILENCE_TIMEOUT_MS: '0' })).TRANSLATION_TALK_SILENCE_TIMEOUT_MS).toBe('0');
	});

	it('derives LOG_LEVEL from DEBUG unless LOG_LEVEL is set explicitly', () => {
		expect(buildContainerEnvVars(env({ DEBUG: 'true' })).LOG_LEVEL).toBe('debug');
		expect(buildContainerEnvVars(env({ DEBUG: 'true', LOG_LEVEL: 'warn' })).LOG_LEVEL).toBe('warn');
		expect(buildContainerEnvVars(env({ DEBUG: 'true' })).DEBUG).toBe('true');
	});

	it('does not include CONTAINER_INSTANCE_NAME itself (TranscriberContainer adds it)', () => {
		expect(buildContainerEnvVars(env())).not.toHaveProperty('CONTAINER_INSTANCE_NAME');
	});
});

describe('instanceNameEnv', () => {
	const id = (name?: string) => ({ name, toString: () => 'deadbeef' }) as unknown as DurableObjectId;

	it('uses the name the Durable Object was looked up by', () => {
		expect(instanceNameEnv(id('session-abc'))).toEqual({ CONTAINER_INSTANCE_NAME: 'session-abc' });
	});

	it('returns nothing and warns for an unnamed id', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(instanceNameEnv(id(undefined))).toEqual({});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain('deadbeef');
	});
});

describe('buildWorkerInfo', () => {
	const request = (cf?: Record<string, unknown>) => {
		const r = new Request('https://example.test/transcribe');
		if (cf) Object.defineProperty(r, 'cf', { value: cf });
		return r;
	};

	it('always records presence and the routing mode, defaulting to session', () => {
		expect(buildWorkerInfo(request(), env())).toEqual({ present: true, routingMode: 'session' });
		expect(buildWorkerInfo(request(), env({ ROUTING_MODE: 'pool' })).routingMode).toBe('pool');
	});

	it('adds the deployed version and the edge location when available', () => {
		const info = buildWorkerInfo(
			request({ colo: 'VIE', country: 'AT', city: 'Vienna' }),
			env({ CF_VERSION_METADATA: { id: 'v-1', tag: 'abc', timestamp: 't' } }),
		);
		expect(info).toMatchObject({ versionId: 'v-1', versionTag: 'abc', colo: 'VIE', country: 'AT', city: 'Vienna' });
	});

	it('omits location fields that request.cf does not carry', () => {
		const info = buildWorkerInfo(request({ colo: 'VIE' }), env());
		expect(info.colo).toBe('VIE');
		expect(info).not.toHaveProperty('country');
		expect(info).not.toHaveProperty('city');
		expect(info).not.toHaveProperty('versionId');
	});
});
