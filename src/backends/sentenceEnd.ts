/**
 * Whether a piece of transcript text ends a sentence. Shared by the xAI long-turn cap (where it
 * decides whether held segments may be released at the soft word budget, and where a long
 * segment may be cut) and the granular segmenter (where it closes a batch early), so the two
 * agree on what a sentence end is.
 *
 * A sentence terminator is the Unicode Sentence_Terminal property (., ?, !, 。, ।, ۔, ։, ።, ။, ។
 * …), possibly followed by closing quotes or brackets. Greek's `;` question mark is not in the
 * property and Thai and Lao have no terminator, so for them this is simply never true, which
 * every caller treats as "wait for the size limit", never as a reason to cut. An abbreviation
 * ("Dr.", "etc.") passes as a sentence end, which can move a release by a few words; harmless.
 */
export const SENTENCE_END_RE = /\p{Sentence_Terminal}[\p{Pe}\p{Pf}"'”’)\]]*$/u;

export function endsSentence(text: string): boolean {
	return SENTENCE_END_RE.test(text.trimEnd());
}
