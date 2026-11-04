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

	it('warns and takes the default for a non-integer', () => {
		const { result, warnings } = parse('abc');
		expect(result).toBe(DEFAULT_PACE_LEAD_MS);
		expect(warnings).toEqual([expect.stringMatching(/TRANSLATION_PACE_LEAD_MS=abc is not an integer/)]);
	});

	it('warns and disables pacing for a negative value', () => {
		const { result, warnings } = parse('-1');
		expect(result).toBe(0);
		expect(warnings).toEqual([expect.stringMatching(/negative; pacing disabled/)]);
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
