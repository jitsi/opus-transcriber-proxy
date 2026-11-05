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
 * The shared env parsing of the translation runtimes (src/translate/env.ts): the same string must mean
 * the same thing in the container and in the Worker, and a value that is not what the operator meant
 * must be said, not silently reinterpreted.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_PACE_LEAD_MS, parseIntOr, parseIntOrUndefined, parsePaceLeadMs } from '../../src/translate/env';

describe('parseIntOr / parseIntOrUndefined', () => {
	it('fall back on unset and non-numeric values', () => {
		expect(parseIntOr(undefined, 7)).toBe(7);
		expect(parseIntOr('abc', 7)).toBe(7);
		expect(parseIntOr('12', 7)).toBe(12);
		expect(parseIntOrUndefined(undefined)).toBeUndefined();
		expect(parseIntOrUndefined('')).toBeUndefined();
		expect(parseIntOrUndefined('x')).toBeUndefined();
		expect(parseIntOrUndefined('0')).toBe(0);
	});
});

describe('parsePaceLeadMs', () => {
	const parse = (value: string | undefined) => {
		const warnings: string[] = [];
		const result = parsePaceLeadMs(value, (m) => warnings.push(m));
		return { result, warnings };
	};

	it('takes the default when unset or empty, silently', () => {
		expect(parse(undefined)).toEqual({ result: DEFAULT_PACE_LEAD_MS, warnings: [] });
		expect(parse('')).toEqual({ result: DEFAULT_PACE_LEAD_MS, warnings: [] });
	});

	it('accepts 0 (pacing off) and ordinary values without a word', () => {
		expect(parse('0')).toEqual({ result: 0, warnings: [] });
		expect(parse('20')).toEqual({ result: 20, warnings: [] });
		expect(parse('500')).toEqual({ result: 500, warnings: [] });
		expect(parse('2000')).toEqual({ result: 2000, warnings: [] });
	});

	it('warns and takes the default for anything but a whole number, trailing units and fractions included', () => {
		for (const v of ['abc', '200ms', '1.5']) {
			const { result, warnings } = parse(v);
			expect(result).toBe(DEFAULT_PACE_LEAD_MS);
			expect(warnings).toEqual([expect.stringMatching(new RegExp(`TRANSLATION_PACE_LEAD_MS=${v.replace('.', '\\.')} is not a whole number`))]);
		}
	});

	it('names the variable it was given, for the agent lead', () => {
		const warnings: string[] = [];
		expect(parsePaceLeadMs('-5', (m) => warnings.push(m), 'AGENT_PACE_LEAD_MS')).toBe(DEFAULT_PACE_LEAD_MS);
		expect(warnings).toEqual([expect.stringMatching(/^AGENT_PACE_LEAD_MS=-5 is negative/)]);
	});

	it('warns and takes the default for a negative value, so a typo cannot turn pacing off', () => {
		const { result, warnings } = parse('-200');
		expect(result).toBe(DEFAULT_PACE_LEAD_MS);
		expect(warnings).toEqual([expect.stringMatching(/negative; using 200/)]);
	});

	it('warns and raises a value under one frame to one frame, the floor the pacer applies anyway', () => {
		for (const v of ['1', '10', '19']) {
			const { result, warnings } = parse(v);
			expect(result).toBe(20);
			expect(warnings).toEqual([expect.stringMatching(/less than one 20 ms frame; using 20/)]);
		}
	});

	it('accepts a lead over 2 s with a warning', () => {
		const { result, warnings } = parse('5000');
		expect(result).toBe(5000);
		expect(warnings).toEqual([expect.stringMatching(/jitter buffer/)]);
	});
});
