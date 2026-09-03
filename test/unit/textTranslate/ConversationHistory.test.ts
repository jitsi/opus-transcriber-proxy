/**
 * Tests for the per-session translation context buffer: what it keeps, what it drops, and how it
 * labels speakers.
 */

import { describe, expect, it } from 'vitest';
import { ConversationHistory } from '../../../src/textTranslate/ConversationHistory';

function history(overrides: Partial<{ maxTurns: number; maxChars: number; includeSpeakers: boolean }> = {}) {
	return new ConversationHistory({ maxTurns: 3, maxChars: 100, includeSpeakers: true, ...overrides });
}

describe('ConversationHistory', () => {
	describe('speaker labels', () => {
		it('assigns ordinals in order of first appearance and keeps them stable', () => {
			const h = history();
			expect(h.speakerLabel('abc')).toBe('Speaker 1');
			expect(h.speakerLabel('def')).toBe('Speaker 2');
			expect(h.speakerLabel('abc')).toBe('Speaker 1');
		});

		it('returns nothing when speakers are disabled', () => {
			const h = history({ includeSpeakers: false });
			expect(h.speakerLabel('abc')).toBeUndefined();
		});

		it('starts over after clear', () => {
			const h = history();
			h.speakerLabel('abc');
			h.speakerLabel('def');
			h.clear();
			expect(h.speakerLabel('def')).toBe('Speaker 1');
		});
	});

	describe('turns', () => {
		it('returns turns oldest first', () => {
			const h = history();
			h.add({ text: 'one' });
			h.add({ text: 'two' });
			expect(h.snapshot().map((t) => t.text)).toEqual(['one', 'two']);
		});

		it('keeps at most maxTurns', () => {
			const h = history({ maxTurns: 2 });
			h.add({ text: 'one' });
			h.add({ text: 'two' });
			h.add({ text: 'three' });
			expect(h.snapshot().map((t) => t.text)).toEqual(['two', 'three']);
		});

		it('drops from the front to stay under maxChars', () => {
			const h = history({ maxTurns: 10, maxChars: 10 });
			h.add({ text: 'aaaaa' });
			h.add({ text: 'bbbbb' });
			h.add({ text: 'ccccc' });
			expect(h.snapshot().map((t) => t.text)).toEqual(['bbbbb', 'ccccc']);
		});

		it('keeps the newest turn even when it alone exceeds maxChars', () => {
			const h = history({ maxTurns: 10, maxChars: 5 });
			h.add({ text: 'aaaaa' });
			h.add({ text: 'a very long turn that is over the cap on its own' });
			expect(h.snapshot()).toHaveLength(1);
			expect(h.snapshot()[0].text).toContain('over the cap');
		});

		it('keeps nothing when history is disabled', () => {
			const h = history({ maxTurns: 0 });
			h.add({ text: 'one' });
			expect(h.snapshot()).toEqual([]);
		});

		it('ignores an empty turn', () => {
			const h = history();
			h.add({ text: '' });
			expect(h.snapshot()).toEqual([]);
		});

		it('returns a copy, so a caller cannot mutate the buffer and later turns do not change it', () => {
			const h = history();
			h.add({ text: 'one' });
			const snapshot = h.snapshot();
			h.add({ text: 'two' });
			snapshot.push({ text: 'injected' });
			expect(h.snapshot().map((t) => t.text)).toEqual(['one', 'two']);
		});

		it('forgets everything on clear', () => {
			const h = history();
			h.add({ text: 'one' });
			h.clear();
			expect(h.snapshot()).toEqual([]);
		});
	});
});
