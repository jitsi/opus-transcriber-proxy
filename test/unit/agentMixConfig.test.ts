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

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_MIX_CONFIG,
	describeMixConfig,
	MIX_OPTIONS,
	mixConfigFromEnv,
	MixOption,
	normalizeMixConfig,
	parseInlineMix,
	resolveMixConfig,
} from '../../src/agent/mixConfig';
import { WORKER_VARS } from '../../worker/vars';

describe('agent mix config', () => {
	describe('the container variables (layers 2 and 3)', () => {
		it('reads every option from its AGENT_MIX_* variable', () => {
			const warnings: string[] = [];
			const values = mixConfigFromEnv(
				{
					AGENT_MIX_BUFFER_MS: '80',
					AGENT_MIX_MAX_BUFFER_MS: '500',
					AGENT_MIX_FRAME_MS: '40',
					AGENT_MIX_CONTINUOUS: 'TRUE',
					AGENT_MIX_MAX_SPEAKERS: '4',
					AGENT_MIX_GAIN: 'Sqrt',
					AGENT_MIX_LIMITER: 'clamp',
					AGENT_MIX_LIMITER_KNEE_DB: '-6.5',
					AGENT_MIX_CONCEAL_MS: '0',
					AGENT_MIX_TALK_GAP_MS: '300',
					AGENT_MIX_LATE_RESYNC_PACKETS: '5',
				},
				(m) => warnings.push(m),
			);
			expect(values).toEqual({
				bufferMs: 80,
				maxBufferMs: 500,
				frameMs: 40,
				continuous: true,
				maxSpeakers: 4,
				gain: 'sqrt',
				limiter: 'clamp',
				limiterKneeDb: -6.5,
				concealMs: 0,
				talkGapMs: 300,
				lateResyncPackets: 5,
			});
			expect(warnings).toEqual([]);
		});

		it('leaves an unset or empty variable out without a word, so the default applies', () => {
			const warnings: string[] = [];
			expect(mixConfigFromEnv({ AGENT_MIX_BUFFER_MS: '' }, (m) => warnings.push(m))).toEqual({});
			expect(warnings).toEqual([]);
		});

		it('says so and uses the default for a value it cannot use, rather than failing', () => {
			const warnings: string[] = [];
			const values = mixConfigFromEnv(
				{
					AGENT_MIX_BUFFER_MS: '501',
					AGENT_MIX_FRAME_MS: '30',
					AGENT_MIX_GAIN: 'loud',
					AGENT_MIX_CONTINUOUS: 'yes',
					AGENT_MIX_MAX_SPEAKERS: '2.5',
				},
				(m) => warnings.push(m),
			);
			expect(values).toEqual({});
			expect(warnings).toHaveLength(5);
			const about = (name: string) => warnings.find((w) => w.startsWith(`${name}=`));
			expect(about('AGENT_MIX_BUFFER_MS')).toMatch(/=501 is not usable .*from 0 to 500.*using 60$/);
			expect(about('AGENT_MIX_FRAME_MS')).toMatch(/one of 10, 20, 40, 60/);
		});
	});

	describe('the inline options (layer 4)', () => {
		it('takes the fields the dial config sets, and nothing else', () => {
			expect(parseInlineMix({ bufferMs: 100, continuous: true, gain: 'average' })).toEqual({
				ok: true,
				values: { bufferMs: 100, continuous: true, gain: 'average' },
				unknownOptions: [],
			});
			expect(parseInlineMix(undefined)).toEqual({ ok: true, values: {}, unknownOptions: [] });
			expect(parseInlineMix(null)).toEqual({ ok: true, values: {}, unknownOptions: [] });
		});

		it('fails on a value it cannot use, naming the field: the invite must not be half applied', () => {
			expect(parseInlineMix({ bufferMs: 600 })).toEqual({
				ok: false,
				error: expect.stringMatching(/^mix\.bufferMs: expected a whole number from 0 to 500, got 600$/),
			});
			// A JSON value of the wrong type is a mistake here, unlike in a variable, which is always text.
			expect(parseInlineMix({ bufferMs: '60' })).toMatchObject({ ok: false });
			expect(parseInlineMix({ continuous: 'true' })).toMatchObject({ ok: false });
			expect(parseInlineMix({ frameMs: 30 })).toMatchObject({ ok: false });
			expect(parseInlineMix({ limiter: 'Soft' })).toMatchObject({ ok: false });
			expect(parseInlineMix([1])).toEqual({ ok: false, error: 'mix: must be an object' });
			expect(parseInlineMix('fast')).toEqual({ ok: false, error: 'mix: must be an object' });
		});

		it('ignores a field it does not know, and names it, so a newer invite still dials', () => {
			expect(parseInlineMix({ bufferMs: 40, reverb: true, toString: 1 })).toEqual({
				ok: true,
				values: { bufferMs: 40 },
				unknownOptions: ['reverb', 'toString'],
			});
		});
	});

	describe('resolution', () => {
		it('is the defaults when nothing is set', () => {
			const resolved = resolveMixConfig();
			expect(resolved.config).toEqual(DEFAULT_MIX_CONFIG);
			expect(new Set(Object.values(resolved.layers))).toEqual(new Set(['default']));
		});

		it('takes each option from the highest layer that has it: default, variable, KV, inline', () => {
			const resolved = resolveMixConfig(
				{ bufferMs: 80, frameMs: 40, gain: 'sqrt' },
				{ bufferMs: 100, continuous: true },
				new Set(['AGENT_MIX_FRAME_MS', 'AGENT_MIX_BUFFER_MS']),
			);
			expect(resolved.config).toEqual({ ...DEFAULT_MIX_CONFIG, bufferMs: 100, frameMs: 40, gain: 'sqrt', continuous: true });
			expect(resolved.layers).toMatchObject({
				bufferMs: 'inline', // over a KV override of the same option
				frameMs: 'kv',
				gain: 'config',
				continuous: 'inline',
				limiter: 'default',
			});
		});

		it('an inline false or 0 still wins over the variable', () => {
			const resolved = resolveMixConfig({ continuous: true, maxSpeakers: 3 }, { continuous: false, maxSpeakers: 0 });
			expect(resolved.config.continuous).toBe(false);
			expect(resolved.config.maxSpeakers).toBe(0);
		});

		it('raises a maxBufferMs that leaves no room above the buffer, and says that it did', () => {
			// Each from its own layer, each valid on its own: a deployment's limit and an agent's buffer.
			const resolved = resolveMixConfig({ maxBufferMs: 100 }, { bufferMs: 200 });
			expect(resolved.config.maxBufferMs).toBe(240);
			expect(resolved.layers.maxBufferMs).toBe('raised');
			expect(describeMixConfig(resolved)).toContain('maxBufferMs=240 (raised)');
			expect(normalizeMixConfig({ ...DEFAULT_MIX_CONFIG, bufferMs: 500 }).maxBufferMs).toBe(540);
			// Room enough: left alone.
			expect(resolveMixConfig({}, { bufferMs: 260 }).config.maxBufferMs).toBe(300);
			expect(resolveMixConfig({}, { bufferMs: 260 }).layers.maxBufferMs).toBe('default');
		});

		it('describes every value in effect with its layer', () => {
			const text = describeMixConfig(resolveMixConfig({ limiter: 'clamp' }, { bufferMs: 80 }, new Set(['AGENT_MIX_LIMITER'])));
			expect(text).toContain('bufferMs=80 (inline)');
			expect(text).toContain('limiter=clamp (kv)');
			expect(text).toContain('gain=unity (default)');
		});
	});

	describe('the Worker table (worker/vars.ts)', () => {
		const vars = WORKER_VARS as Record<string, { container?: unknown; kv?: { normalize(v: unknown): string | { error: string } } }>;
		const names = Object.keys(MIX_OPTIONS) as MixOption[];

		it('forwards every option to the container and lets KV override it', () => {
			for (const name of names) {
				const spec = vars[MIX_OPTIONS[name].env];
				expect(spec, MIX_OPTIONS[name].env).toBeDefined();
				expect(spec.container, MIX_OPTIONS[name].env).toBe('if-set');
				expect(spec.kv, MIX_OPTIONS[name].env).toBeDefined();
			}
			const mixVars = Object.keys(vars).filter((name) => name.startsWith('AGENT_MIX_'));
			expect(mixVars.sort()).toEqual(names.map((name) => MIX_OPTIONS[name].env).sort());
		});

		it('accepts in KV what the container accepts, and writes it back in a form the container reads', () => {
			for (const name of names) {
				const env = MIX_OPTIONS[name].env;
				const normalized = vars[env].kv!.normalize(DEFAULT_MIX_CONFIG[name]);
				expect(typeof normalized, env).toBe('string');
				expect(
					mixConfigFromEnv({ [env]: normalized as string }, () => {}),
					env,
				).toEqual({ [name]: DEFAULT_MIX_CONFIG[name] });
			}
		});

		it('agrees with the container on every option, at the edges of what it takes', () => {
			const accepted = (name: MixOption, value: unknown) => {
				const env = MIX_OPTIONS[name].env;
				const normalized = vars[env].kv!.normalize(value);
				expect(typeof normalized, `${env}=${value} in KV`).toBe('string');
				expect(
					mixConfigFromEnv({ [env]: normalized as string }, () => {}),
					`${env}=${value} in the container`,
				).toEqual({ [name]: value });
			};
			const refused = (name: MixOption, value: unknown) => {
				const env = MIX_OPTIONS[name].env;
				expect(vars[env].kv!.normalize(value), `${env}=${value} in KV`).toMatchObject({ error: expect.any(String) });
				const warnings: string[] = [];
				expect(
					mixConfigFromEnv({ [env]: String(value) }, (m) => warnings.push(m)),
					`${env}=${value} in the container`,
				).toEqual({});
				expect(warnings, env).toHaveLength(1);
			};
			for (const name of names) {
				const spec = MIX_OPTIONS[name];
				switch (spec.kind) {
					case 'int':
					case 'number':
						accepted(name, spec.min);
						accepted(name, spec.max);
						refused(name, spec.min - 1);
						refused(name, spec.max + 1);
						if (spec.kind === 'int') refused(name, spec.min + 0.5);
						else accepted(name, spec.min + 0.5);
						break;
					case 'enum':
					case 'intEnum':
						for (const value of spec.values) accepted(name, value);
						refused(name, spec.kind === 'enum' ? 'other' : 7);
						break;
					case 'bool':
						accepted(name, true);
						accepted(name, false);
						refused(name, 'yes');
						break;
				}
			}
		});

		it('reads a small number the way KV writes it back', () => {
			// String(-1e-7) is "-1e-7": the container must take what the Worker forwards.
			const written = vars.AGENT_MIX_LIMITER_KNEE_DB.kv!.normalize(-1e-7);
			expect(written).toBe('-1e-7');
			expect(mixConfigFromEnv({ AGENT_MIX_LIMITER_KNEE_DB: written as string }, () => {})).toEqual({ limiterKneeDb: -1e-7 });
		});
	});
});
