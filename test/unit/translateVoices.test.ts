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
import { fnv1a32, parseVoiceList, voiceForSource } from '../../src/translate/voices';

describe('parseVoiceList', () => {
	it('splits, trims, drops empties and case-insensitive duplicates, keeps the first spelling', () => {
		expect(parseVoiceList('ara, rex ,, Eve,eve,ARA')).toEqual(['ara', 'rex', 'Eve']);
	});

	it('is undefined when unset or nothing usable remains', () => {
		expect(parseVoiceList(undefined)).toBeUndefined();
		expect(parseVoiceList('')).toBeUndefined();
		expect(parseVoiceList(' , ,')).toBeUndefined();
	});
});

describe('voiceForSource', () => {
	const voices = ['ara', 'rex', 'eve', 'leo', 'sal', 'luna', 'atlas', 'iris'];

	it('is a pure function of the source: the same voice every time, from the list', () => {
		for (const source of ['f57e7ec7-a0', '36983593-a0', '5e83afe7-a0']) {
			const voice = voiceForSource(voices, source);
			expect(voices).toContain(voice);
			expect(voiceForSource(voices, source)).toBe(voice);
			expect(voiceForSource([...voices], source)).toBe(voice);
		}
	});

	it('spreads sources over the list', () => {
		const used = new Set<string>();
		for (let i = 0; i < 200; i++) {
			used.add(voiceForSource(voices, `${i.toString(16).padStart(8, '0')}-a0`));
		}
		expect(used.size).toBe(voices.length);
	});

	it('is the only voice with a list of one, and refuses an empty list', () => {
		expect(voiceForSource(['sal'], 'x-a0')).toBe('sal');
		expect(() => voiceForSource([], 'x-a0')).toThrow(RangeError);
	});

	it('hashes with FNV-1a 32 (known vectors)', () => {
		expect(fnv1a32('')).toBe(0x811c9dc5);
		expect(fnv1a32('a')).toBe(0xe40c292c);
		expect(fnv1a32('foobar')).toBe(0xbf9cf968);
	});
});
