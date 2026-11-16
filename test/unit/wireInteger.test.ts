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
import { wireInteger } from '../../src/translate/wireInteger';

describe('wireInteger', () => {
	it('reads a JSON number', () => {
		expect(wireInteger(0)).toBe(0);
		expect(wireInteger(31456)).toBe(31456);
		expect(wireInteger(-960)).toBe(-960);
	});

	it('reads a decimal string, as the bridge writes chunk and timestamp', () => {
		expect(wireInteger('0')).toBe(0);
		expect(wireInteger('31456')).toBe(31456);
		expect(wireInteger('268460')).toBe(268460);
		expect(wireInteger('-960')).toBe(-960);
		expect(wireInteger('007')).toBe(7);
		// A long session: the timestamp passes 2^32 and stays exact.
		expect(wireInteger('4294967297')).toBe(4294967297);
	});

	it('returns undefined for a value that is not a whole number', () => {
		for (const value of [
			undefined,
			null,
			'',
			' ',
			'12 ',
			' 12',
			'1.5',
			'1e3',
			'0x10',
			'+5',
			'12abc',
			'NaN',
			1.5,
			NaN,
			Infinity,
			true,
			{},
			[],
			[7],
		]) {
			expect(wireInteger(value)).toBeUndefined();
		}
	});

	it('returns undefined past the safe integer range', () => {
		expect(wireInteger(2 ** 53)).toBeUndefined();
		expect(wireInteger('9007199254740993')).toBeUndefined();
		expect(wireInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
		expect(wireInteger(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
	});
});
