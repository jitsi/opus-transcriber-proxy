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
import { VoiceAssigner, parseVoiceList } from '../../src/translate/voices';

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

describe('VoiceAssigner', () => {
	it('spreads new sources over the list in order before repeating a voice', () => {
		const a = new VoiceAssigner(['ara', 'rex', 'eve']);
		expect(a.voiceFor('s1')).toBe('ara');
		expect(a.voiceFor('s2')).toBe('rex');
		expect(a.voiceFor('s3')).toBe('eve');
		expect(a.voiceFor('s4')).toBe('ara');
	});

	it('keeps a source on its voice however often it is asked, and whatever else happens in between', () => {
		const a = new VoiceAssigner(['ara', 'rex']);
		expect(a.voiceFor('s1')).toBe('ara');
		expect(a.voiceFor('s2')).toBe('rex');
		expect(a.voiceFor('s3')).toBe('ara');
		expect(a.voiceFor('s1')).toBe('ara');
		expect(a.voiceFor('s2')).toBe('rex');
	});

	it('gives a new source the least used voice, not the next in rotation', () => {
		const a = new VoiceAssigner(['ara', 'rex', 'eve'], 2);
		a.voiceFor('s1'); // ara
		a.voiceFor('s2'); // rex
		a.voiceFor('s3'); // eve; s1 forgotten (cap 2)
		// Remembered: s2=rex, s3=eve. ara is unused, so the newcomer takes it.
		expect(a.voiceFor('s4')).toBe('ara');
	});

	it('forgets the least recently asked for source at the cap, a hit counting as recent', () => {
		const a = new VoiceAssigner(['ara', 'rex', 'eve'], 2);
		a.voiceFor('s1'); // ara
		a.voiceFor('s2'); // rex
		a.voiceFor('s1'); // touch s1: s2 is now the oldest
		a.voiceFor('s3'); // eve; s2 forgotten
		expect(a.has('s1')).toBe(true);
		expect(a.has('s2')).toBe(false);
		expect(a.has('s3')).toBe(true);
		// s2 comes back as a newcomer and takes the one voice nobody remembered holds.
		expect(a.voiceFor('s2')).toBe('rex');
	});

	it('works with one voice', () => {
		const a = new VoiceAssigner(['sal']);
		expect(a.voiceFor('s1')).toBe('sal');
		expect(a.voiceFor('s2')).toBe('sal');
	});

	it('rejects an empty list and a non-positive cap', () => {
		expect(() => new VoiceAssigner([])).toThrow(RangeError);
		expect(() => new VoiceAssigner(['ara'], 0)).toThrow(RangeError);
		expect(() => new VoiceAssigner(['ara'], 1.5)).toThrow(RangeError);
	});
});
