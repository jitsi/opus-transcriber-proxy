/**
 * Tests for AgentPacer: real-time pacing of the agent's return audio.
 *
 * Covers:
 * - frames within the lead budget are released immediately
 * - frames beyond the lead budget wait for media playout (timer-driven)
 * - clear() drops queued frames but not already-released ones, and flushes queued marks
 * - marks fire in order once the audio ahead of them has been released
 * - close() stops the timer and releases nothing further
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentPacer } from '../../src/agent/AgentPacer';

/** A pacer on a manual clock: advance(ms) moves time and fires due timers. */
function manualPacer(leadMs: number) {
	let now = 0;
	let timer: { fn: () => void; due: number } | undefined;
	const pacer = new AgentPacer({
		leadMs,
		now: () => now,
		setTimer: (fn, ms) => {
			timer = { fn, due: now + ms };
			return timer;
		},
		clearTimer: () => {
			timer = undefined;
		},
	});
	const released: Uint8Array[] = [];
	const marks: string[] = [];
	pacer.onFrame = (payload) => released.push(payload);
	pacer.onMark = (name) => marks.push(name);
	const advance = (ms: number) => {
		now += ms;
		while (timer !== undefined && timer.due <= now) {
			const fn = timer.fn;
			timer = undefined;
			fn();
		}
	};
	return { pacer, released, marks, advance };
}

function frame(id: number): Uint8Array {
	return new Uint8Array([id]);
}

describe('AgentPacer', () => {
	it('releases frames immediately while within the lead budget', () => {
		const { pacer, released } = manualPacer(100);
		for (let i = 0; i < 5; i++) {
			pacer.push(frame(i));
		}
		// 5 frames = 100 ms of media = exactly the lead budget.
		expect(released.length).toBe(5);
	});

	it('holds frames beyond the lead budget until media plays out', () => {
		const { pacer, released, advance } = manualPacer(100);
		for (let i = 0; i < 10; i++) {
			pacer.push(frame(i));
		}
		expect(released.length).toBe(5);
		// After 60 ms of wall clock, 3 more 20 ms frames fit in the budget.
		advance(60);
		expect(released.length).toBe(8);
		advance(1000);
		expect(released.length).toBe(10);
	});

	it('clear() drops only the un-released frames and reports the count', () => {
		const { pacer, released } = manualPacer(100);
		for (let i = 0; i < 10; i++) {
			pacer.push(frame(i));
		}
		expect(released.length).toBe(5);
		expect(pacer.clear()).toBe(5);
		expect(released.length).toBe(5);
		expect(pacer.queuedFrames).toBe(0);
	});

	it('fires marks after the audio queued ahead of them, and flushes them on clear()', () => {
		const { pacer, released, marks, advance } = manualPacer(40);
		pacer.push(frame(0));
		pacer.push(frame(1));
		pacer.mark('first');
		pacer.push(frame(2));
		pacer.mark('second');
		// Budget of 40 ms = 2 frames released immediately; 'first' fires right behind them.
		expect(released.length).toBe(2);
		expect(marks).toEqual(['first']);
		advance(20);
		expect(released.length).toBe(3);
		expect(marks).toEqual(['first', 'second']);

		pacer.push(frame(3));
		pacer.push(frame(4));
		pacer.push(frame(5));
		pacer.mark('third');
		const releasedBefore = released.length;
		pacer.clear();
		// The un-released frames are gone, but the mark is answered.
		expect(released.length).toBe(releasedBefore);
		expect(marks).toEqual(['first', 'second', 'third']);
	});

	it('release resumes correctly after an idle gap', () => {
		const { pacer, released, advance } = manualPacer(40);
		pacer.push(frame(0));
		pacer.push(frame(1));
		expect(released.length).toBe(2);
		// Long idle: the playout clock must re-anchor to now, not accumulate unused budget.
		advance(10_000);
		for (let i = 2; i < 10; i++) {
			pacer.push(frame(i));
		}
		expect(released.length).toBe(4);
	});

	it('close() drops everything and releases nothing further', () => {
		const { pacer, released, marks, advance } = manualPacer(40);
		for (let i = 0; i < 10; i++) {
			pacer.push(frame(i));
		}
		pacer.mark('pending');
		pacer.close();
		advance(10_000);
		expect(released.length).toBe(2);
		expect(marks).toEqual([]);
		pacer.push(frame(99));
		expect(released.length).toBe(2);
	});

	it('uses the injected timer rather than wall-clock scheduling', () => {
		const setTimer = vi.fn(() => ({}));
		const pacer = new AgentPacer({ leadMs: 20, now: () => 0, setTimer, clearTimer: vi.fn() });
		pacer.onFrame = vi.fn();
		pacer.push(frame(0));
		pacer.push(frame(1));
		expect(setTimer).toHaveBeenCalledTimes(1);
	});
});
