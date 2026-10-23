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

import type { TranslationTurn } from './TextTranslator';

export interface ConversationHistoryOptions {
	/** How many past turns to keep. 0 disables history entirely. */
	maxTurns: number;
	/** Cap on the total characters of kept text, so a long meeting cannot grow the prompt without bound. */
	maxChars: number;
	/**
	 * Whether to label turns with a speaker. When false no labels are generated at all, so nothing
	 * speaker-related can reach a provider or leak into translated text.
	 */
	includeSpeakers: boolean;
}

/**
 * The recent finals of one session, used as translation context.
 *
 * Why context at all: a bare sentence is often ambiguous out of the conversation it belongs to —
 * pronoun gender and formality (tu/vous, du/Sie) frequently cannot be resolved from the sentence
 * alone, and terminology drifts between turns when each is translated in isolation. Passing who
 * said what also lets the translator tell a reply apart from a continuation.
 *
 * Speaker labels are synthetic and per-session ("Speaker 1", "Speaker 2"), assigned in order of
 * first appearance. The proxy has no display names — only participant ids — and an opaque hex id
 * costs tokens and reads as noise to a model, so it is mapped to an ordinal instead. Labels are
 * prompt-only: they are kept out of the translated text by how the prompt is built, never by
 * matching against a provider's answer.
 */
export class ConversationHistory {
	private readonly options: ConversationHistoryOptions;
	private turns: TranslationTurn[] = [];
	private readonly speakerLabels = new Map<string, string>();

	constructor(options: ConversationHistoryOptions) {
		this.options = options;
	}

	/** The label for `participantId`, allocating the next ordinal on first sight. */
	speakerLabel(participantId: string): string | undefined {
		if (!this.options.includeSpeakers) {
			return undefined;
		}
		let label = this.speakerLabels.get(participantId);
		if (!label) {
			label = `Speaker ${this.speakerLabels.size + 1}`;
			this.speakerLabels.set(participantId, label);
		}
		return label;
	}

	/**
	 * The turns to send as context, oldest first.
	 *
	 * Returns a snapshot: the caller fans one turn out to several target languages, and every one of
	 * those requests must see the same context even though translations complete out of order.
	 */
	snapshot(): TranslationTurn[] {
		return [...this.turns];
	}

	/**
	 * Record a turn as context for later ones.
	 *
	 * Call this *after* building the requests for that turn — a turn is not its own context.
	 */
	add(turn: TranslationTurn): void {
		if (this.options.maxTurns <= 0 || !turn.text) {
			return;
		}
		this.turns.push(turn);
		if (this.turns.length > this.options.maxTurns) {
			this.turns.splice(0, this.turns.length - this.options.maxTurns);
		}
		// Drop from the front until the kept text fits. The newest turn is always kept, even when it
		// alone exceeds the cap: dropping it would silently lose the most relevant context.
		let total = this.turns.reduce((sum, t) => sum + t.text.length, 0);
		while (this.turns.length > 1 && total > this.options.maxChars) {
			total -= this.turns[0].text.length;
			this.turns.shift();
		}
	}

	clear(): void {
		this.turns = [];
		this.speakerLabels.clear();
	}
}
