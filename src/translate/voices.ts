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
 * Per-source TTS voices for the speech-to-speech providers that take a voice (xAI).
 *
 * A provider synthesises every speaker in one configured voice, so listeners cannot tell translated
 * speakers apart. Given a list of voices, each source (a speaker's media source) gets the voice its
 * id hashes to: a pure function of the source id, so the voice is the same on every direction and
 * connection opened for the source (a listener switching language or turning translation off and
 * on, the idle close, a provider drop, a bridge reconnect) and in every runtime, with no shared
 * state. A participant who leaves and rejoins has a new source id, and may get a new voice. The
 * bridge spreads a conference's directions over connections as jicofo's `translation.mode` says
 * (one per exported source by default, with a source's languages split across connects past a
 * cap), and a Worker's connections land in different isolates, so a stateful assignment would
 * have nothing to share through anyway. The
 * cost is collisions: two sources may hash to one voice while others go unused, with the odds set
 * by the length of the list (three speakers over 8 voices collide about one time in three, over 28
 * about one in ten), so configure every voice that is acceptable.
 *
 * The list is not checked against a known set of voices: xAI adds voices, and it says which id it
 * does not know (an `error` event answering the `session.update`, "Voice 'x' not found"), so a
 * refused voice is learned from that answer (`markVoiceRefused`). The sources that hash to it move
 * to the next entry of the list from their reopen on, while every other source keeps its voice;
 * with every entry refused the single configured voice applies, and with that refused too no voice
 * is sent and the provider's default speaks. The record is per process (per isolate in the Worker)
 * and lasts until it restarts, so each one pays the directions already opened with a mistyped
 * voice when the first answer arrives (every language of every source that hashed to it).
 *
 * Worker-safe: no Node imports.
 */

/**
 * The voice list from an environment variable: comma separated, trimmed, empty entries dropped,
 * duplicates (compared case-insensitively, as xAI compares voice ids) dropped after the first.
 * `undefined` when nothing usable remains. `warn`, when given, is told what was dropped and about an
 * entry that looks like two ids joined by the wrong separator (whitespace or a semicolon inside it),
 * which xAI would refuse as one unknown voice.
 */
export function parseVoiceList(value: string | undefined, warn?: (message: string) => void): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const seen = new Set<string>();
	const voices: string[] = [];
	const dropped: string[] = [];
	for (const entry of value.split(',')) {
		const voice = entry.trim();
		if (voice === '') {
			continue;
		}
		if (seen.has(voice.toLowerCase())) {
			dropped.push(voice);
			continue;
		}
		if (/[\s;]/.test(voice)) {
			warn?.(`XAI_TRANSLATION_VOICES entry ${JSON.stringify(voice)} contains whitespace or ';'; the separator is a comma, and xAI will refuse it as one voice`);
		}
		seen.add(voice.toLowerCase());
		voices.push(voice);
	}
	if (dropped.length > 0) {
		warn?.(`XAI_TRANSLATION_VOICES repeats ${dropped.map((v) => JSON.stringify(v)).join(', ')}; a voice is listed once`);
	}
	if (voices.length === 0) {
		warn?.(`XAI_TRANSLATION_VOICES=${JSON.stringify(value)} names no voice; the single configured voice applies`);
		return undefined;
	}
	return voices;
}

/**
 * The voice of a source: the list entry its id hashes to, or the next entry the provider has not
 * refused; undefined when every entry has been refused (the configured voice then applies). Throws
 * on an empty list.
 */
export function voiceForSource(voices: readonly string[], source: string): string | undefined {
	if (voices.length === 0) {
		throw new RangeError('voiceForSource needs at least one voice');
	}
	const start = fnv1a32(source) % voices.length;
	for (let i = 0; i < voices.length; i++) {
		const voice = voices[(start + i) % voices.length];
		if (!refusedVoices.has(voice.toLowerCase())) {
			return voice;
		}
	}
	return undefined;
}

/** Voices the provider has refused in this process, lower-cased (xAI compares ids case-insensitively). */
const refusedVoices = new Set<string>();

/** xAI's answer to a `session.update` naming a voice it does not know ("Voice 'x' not found"), tolerant of case and quote style. */
const XAI_UNKNOWN_VOICE_RE = /voice\s+['"\u2018\u2019\u201c\u201d]([^'"\u2018\u2019\u201c\u201d]+)['"\u2018\u2019\u201c\u201d]\s+not\s+found/i;

/** The voice id an xAI error message says is unknown, or undefined for any other error. */
export function refusedVoiceOf(errorMessage: string): string | undefined {
	return XAI_UNKNOWN_VOICE_RE.exec(errorMessage)?.[1];
}

/** Whether the provider has refused a voice in this process. */
export function isVoiceRefused(voice: string): boolean {
	return refusedVoices.has(voice.toLowerCase());
}

/** Record a voice the provider refused. True when it was not known to be refused before. */
export function markVoiceRefused(voice: string): boolean {
	const key = voice.toLowerCase();
	if (refusedVoices.has(key)) {
		return false;
	}
	refusedVoices.add(key);
	return true;
}

/** Test hook: forget every refused voice. */
export function resetRefusedVoices(): void {
	refusedVoices.clear();
}

/** FNV-1a, 32 bit, over the UTF-16 code units of a string. */
export function fnv1a32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}
