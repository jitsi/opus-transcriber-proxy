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
 * Per-source TTS voice assignment for the speech-to-speech providers that take a voice (xAI).
 *
 * A provider synthesises every speaker in one configured voice, so listeners cannot tell translated
 * speakers apart. Given a list of voices, the assigner gives each source (a speaker) its own voice
 * for the life of the conference, and keeps it when the speaker's directions close and reopen (a
 * listener turning translation off and on, switching language, the idle close, a provider drop):
 * the voice is a property of the speaker, not of a direction.
 *
 * Worker-safe: no Node imports.
 */

/**
 * The voice list from an environment variable: comma separated, trimmed, empty entries dropped,
 * duplicates (compared case-insensitively, as xAI compares voice ids) dropped after the first.
 * `undefined` when nothing usable remains.
 */
export function parseVoiceList(value: string | undefined): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	const seen = new Set<string>();
	const voices: string[] = [];
	for (const entry of value.split(',')) {
		const voice = entry.trim();
		if (voice === '' || seen.has(voice.toLowerCase())) {
			continue;
		}
		seen.add(voice.toLowerCase());
		voices.push(voice);
	}
	return voices.length > 0 ? voices : undefined;
}

/** Sources remembered per assigner; past this the least recently heard one is forgotten. */
export const DEFAULT_MAX_REMEMBERED_SOURCES = 256;

export class VoiceAssigner {
	/** Source → voice, in least-recently-used order (a Map iterates in insertion order; a hit re-inserts). */
	private readonly assigned = new Map<string, string>();

	/**
	 * @param voices - The voices to hand out, in order of preference for a tie.
	 * @param maxRememberedSources - How many sources to remember; the least recently asked for is
	 *   forgotten first, and asked for again it may get a different voice.
	 */
	constructor(
		private readonly voices: readonly string[],
		private readonly maxRememberedSources = DEFAULT_MAX_REMEMBERED_SOURCES,
	) {
		if (voices.length === 0) {
			throw new RangeError('VoiceAssigner needs at least one voice');
		}
		if (!Number.isInteger(maxRememberedSources) || maxRememberedSources < 1) {
			throw new RangeError(`maxRememberedSources must be a positive integer, got ${maxRememberedSources}`);
		}
	}

	/**
	 * The voice for a source. A source seen before keeps its voice; a new one gets the voice the
	 * fewest remembered sources have, the earliest in the list on a tie, so that a conference's
	 * speakers spread over the list before any voice is heard twice.
	 */
	voiceFor(source: string): string {
		const existing = this.assigned.get(source);
		if (existing !== undefined) {
			// Re-insert so the Map's order stays least-recently-used first.
			this.assigned.delete(source);
			this.assigned.set(source, existing);
			return existing;
		}

		const load = new Map<string, number>(this.voices.map((v) => [v, 0]));
		for (const voice of this.assigned.values()) {
			load.set(voice, (load.get(voice) ?? 0) + 1);
		}
		let chosen = this.voices[0];
		for (const voice of this.voices) {
			if ((load.get(voice) ?? 0) < (load.get(chosen) ?? 0)) {
				chosen = voice;
			}
		}

		if (this.assigned.size >= this.maxRememberedSources) {
			const oldest = this.assigned.keys().next().value;
			if (oldest !== undefined) {
				this.assigned.delete(oldest);
			}
		}
		this.assigned.set(source, chosen);
		return chosen;
	}

	/** Whether a source is currently remembered (for tests and logs). */
	has(source: string): boolean {
		return this.assigned.has(source);
	}
}
