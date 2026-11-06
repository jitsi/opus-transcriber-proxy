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

import { describe, it, expect, afterEach } from 'vitest';
import {
	fnv1a32,
	isVoiceRefused,
	markVoiceRefused,
	parseVoiceList,
	refusedVoiceOf,
	resetRefusedVoices,
	voiceForSource,
} from '../../src/translate/voices';

describe('parseVoiceList', () => {
	it('splits, trims, drops empties and case-insensitive duplicates, keeps the first spelling', () => {
		expect(parseVoiceList('ara, rex ,, Eve,eve,ARA')).toEqual(['ara', 'rex', 'Eve']);
	});

	it('reports what it drops and a probable wrong separator, when given a warn', () => {
		const warnings: string[] = [];
		const warn = (m: string) => warnings.push(m);
		expect(parseVoiceList('ara;rex, eve, EVE', warn)).toEqual(['ara;rex', 'eve']);
		expect(warnings).toEqual([expect.stringMatching(/"ara;rex".*separator is a comma/), expect.stringMatching(/repeats "EVE"/)]);
		warnings.length = 0;
		expect(parseVoiceList(' , ', warn)).toBeUndefined();
		expect(warnings).toEqual([expect.stringMatching(/names no voice/)]);
		expect(parseVoiceList('ara, rex')).toEqual(['ara', 'rex']);
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

	describe('with voices the provider refused', () => {
		afterEach(() => resetRefusedVoices());

		it('moves the sources that hash to a refused voice to the next entry, and nobody else', () => {
			const sources = Array.from({ length: 64 }, (_, i) => `${i.toString(16).padStart(8, '0')}-a0`);
			const before = new Map(sources.map((s) => [s, voiceForSource(voices, s)!]));
			expect(markVoiceRefused('rex')).toBe(true);
			expect(markVoiceRefused('REX')).toBe(false);
			for (const s of sources) {
				const was = before.get(s)!;
				const now = voiceForSource(voices, s);
				expect(now).toBe(was === 'rex' ? voices[(voices.indexOf('rex') + 1) % voices.length] : was);
			}
		});

		it('probes past several refused voices, wrapping around the list', () => {
			const last = voices[voices.length - 1];
			const source = sources_hashing_to(last)[0];
			markVoiceRefused(last);
			markVoiceRefused(voices[0]);
			expect(voiceForSource(voices, source)).toBe(voices[1]);
		});

		it('is undefined once every voice of the list is refused', () => {
			for (const v of voices) markVoiceRefused(v);
			expect(voiceForSource(voices, 'x-a0')).toBeUndefined();
			expect(isVoiceRefused('Ara')).toBe(true);
		});

		function sources_hashing_to(voice: string): string[] {
			const out: string[] = [];
			for (let i = 0; out.length < 1 && i < 10000; i++) {
				const s = `${i.toString(16).padStart(8, '0')}-a0`;
				if (voices[fnv1a32(s) % voices.length] === voice) out.push(s);
			}
			return out;
		}
	});

	it('hashes with FNV-1a 32 (known vectors)', () => {
		expect(fnv1a32('')).toBe(0x811c9dc5);
		expect(fnv1a32('a')).toBe(0xe40c292c);
		expect(fnv1a32('foobar')).toBe(0xbf9cf968);
	});
});

describe('refusedVoiceOf', () => {
	it("reads the id out of xAI's unknown-voice error and nothing else", () => {
		expect(refusedVoiceOf("TTS synthesis failed: Voice 'bogus_voice' not found")).toBe('bogus_voice');
		expect(refusedVoiceOf('voice "Bogus" not found')).toBe('Bogus');
		expect(refusedVoiceOf('Voice \u2018bogus\u2019 Not Found')).toBe('bogus');
		expect(refusedVoiceOf('LLM stream timed out')).toBeUndefined();
		expect(refusedVoiceOf('')).toBeUndefined();
	});
});
