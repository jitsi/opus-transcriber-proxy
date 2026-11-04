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
 * Tests for MediaPacer: real-time pacing of synthetic audio (the /agent return path and translated
 * audio) before it is sent to the bridge. The pacer is generic over what it queues; these tests
 * queue bare payloads on a manual clock.
 */

import { describe, it, expect, vi } from 'vitest';
import { MediaPacer, type MediaPacerOptions } from '../../src/MediaPacer';

/** A pacer on a manual clock: advance(ms) moves time and fires due timers (one per 20 ms step). */
function manualPacer(leadMs: number, options: Partial<MediaPacerOptions<Uint8Array>> = {}) {
	let now = 0;
	let timer: { fn: () => void; due: number } | undefined;
	const released: Uint8Array[] = [];
	const marks: string[] = [];
	const pacer = new MediaPacer<Uint8Array>({
		leadMs,
		now: () => now,
		setTimer: (fn, ms) => {
			timer = { fn, due: now + ms };
			return timer;
		},
		clearTimer: () => {
			timer = undefined;
		},
		onFrame: (payload) => released.push(payload),
		...options,
	});
	pacer.onMark = (name) => marks.push(name);
	const advance = (ms: number) => {
		now += ms;
		while (timer !== undefined && timer.due <= now) {
			const fn = timer.fn;
			timer = undefined;
			fn();
		}
	};
	/** Step the clock frame by frame, since the harness holds one timer at a time. */
	const advanceFrames = (frames: number) => {
		for (let i = 0; i < frames; i++) advance(20);
	};
	return { pacer, released, marks, advance, advanceFrames, ids: () => released.map((f) => f[0]) };
}

function frame(id: number): Uint8Array {
	return new Uint8Array([id]);
}

describe('MediaPacer', () => {
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

	it('raises a lead shorter than one frame to one frame instead of never releasing anything', () => {
		// With a lead under 20 ms no frame can ever fit the budget: the pacer would wait, re-anchor its clock on
		// waking and wait again, forever. Reachable from the operator-set TRANSLATION_PACE_LEAD_MS / AGENT_PACE_LEAD_MS.
		for (const leadMs of [0, 1, 10, 19]) {
			const { pacer, released, advanceFrames } = manualPacer(leadMs);
			for (let i = 0; i < 10; i++) pacer.push(frame(i));
			expect(released.length).toBe(1); // one frame in flight
			advanceFrames(9);
			expect(released.length).toBe(10);
		}
	});

	it('rejects options that cannot pace', () => {
		const onFrame = () => {};
		expect(() => new MediaPacer({ onFrame, leadMs: NaN })).toThrow(RangeError);
		expect(() => new MediaPacer({ onFrame, leadMs: -1 })).toThrow(RangeError);
		expect(() => new MediaPacer({ onFrame, frameDurationMs: 0 })).toThrow(RangeError);
		expect(() => new MediaPacer({ onFrame, maxQueuedFrames: 0 })).toThrow(RangeError);
		expect(() => new MediaPacer({ onFrame, maxQueuedFrames: 3, overflowDropFrames: 4 })).toThrow(RangeError);
		expect(() => new MediaPacer({ onFrame, overflowDropFrames: 0 })).toThrow(RangeError);
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

	it('close() drops everything, releases nothing further, and makes clear()/flush() no-ops', () => {
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
		pacer.mark('late');
		expect(released.length).toBe(2);
		expect(pacer.clear()).toBe(0);
		expect(pacer.flush()).toBe(0);
		expect(marks).toEqual([]);
	});

	it('uses the injected timer rather than wall-clock scheduling', () => {
		const setTimer = vi.fn(() => ({}));
		const pacer = new MediaPacer<Uint8Array>({ leadMs: 20, now: () => 0, setTimer, clearTimer: vi.fn(), onFrame: vi.fn() });
		pacer.push(frame(0));
		pacer.push(frame(1));
		expect(setTimer).toHaveBeenCalledTimes(1);
	});

	it('flush() releases everything queued at once, in order, and the next push paces against the advanced clock', () => {
		const { pacer, released, marks, advanceFrames, ids } = manualPacer(40);
		for (let i = 0; i < 6; i++) pacer.push(frame(i));
		pacer.mark('end');
		expect(released.length).toBe(2); // the 40 ms lead

		expect(pacer.flush()).toBe(4);
		expect(ids()).toEqual([0, 1, 2, 3, 4, 5]);
		expect(marks).toEqual(['end']);
		expect(pacer.queuedFrames).toBe(0);

		// The playout clock now ends 120 ms from now, so a new frame waits its turn instead of going out at once.
		pacer.push(frame(6));
		expect(released.length).toBe(6);
		advanceFrames(5);
		expect(released.length).toBe(7);
	});

	it('flush(maxFrames) releases the oldest frames up to the limit, drops the rest and still fires every mark', () => {
		const { pacer, marks, ids } = manualPacer(40);
		for (let i = 0; i < 8; i++) pacer.push(frame(i));
		pacer.mark('mid');
		for (let i = 8; i < 12; i++) pacer.push(frame(i));
		pacer.mark('end');
		expect(ids()).toEqual([0, 1]);
		expect(pacer.queuedFrames).toBe(10);

		expect(pacer.flush(3)).toBe(3);
		expect(ids()).toEqual([0, 1, 2, 3, 4]); // the audio nearest to playing
		expect(marks).toEqual(['mid', 'end']);
		expect(pacer.queuedFrames).toBe(0);
	});

	it('maxQueuedFrames drops the oldest queued frames to make room and reports how many', () => {
		const { pacer, advanceFrames, ids } = manualPacer(40, { maxQueuedFrames: 3 });
		const overflows: number[] = [];
		pacer.onOverflow = (n) => overflows.push(n);
		for (let i = 0; i < 6; i++) pacer.push(frame(i)); // 0,1 released; 2,3,4 queued; 5 evicts 2
		expect(ids()).toEqual([0, 1]);
		expect(overflows).toEqual([1]);
		expect(pacer.queuedFrames).toBe(3);

		advanceFrames(10);
		// 2 is gone; what plays is the newest audio.
		expect(ids()).toEqual([0, 1, 3, 4, 5]);
	});

	it('overflowDropFrames drops a block of the oldest frames at once, so a burst makes one skip rather than a hole per push', () => {
		const { pacer, advanceFrames, ids } = manualPacer(40, { maxQueuedFrames: 6, overflowDropFrames: 4 });
		const overflows: number[] = [];
		pacer.onOverflow = (n) => overflows.push(n);
		for (let i = 0; i < 8; i++) pacer.push(frame(i)); // 0,1 released; 2..7 queued (full)
		for (let i = 8; i < 12; i++) pacer.push(frame(i)); // 8 evicts 2..5 in one go; 9,10,11 then fit
		expect(overflows).toEqual([4]);
		expect(pacer.queuedFrames).toBe(6);

		advanceFrames(10);
		expect(ids()).toEqual([0, 1, 6, 7, 8, 9, 10, 11]);
	});

	it('an overflow keeps the marks between the dropped frames, in order, and a later flush fires them', () => {
		const { pacer, marks, ids } = manualPacer(40, { maxQueuedFrames: 3 });
		pacer.push(frame(0));
		pacer.push(frame(1));
		pacer.mark('a'); // fires at once: nothing queued ahead of it
		pacer.push(frame(2));
		pacer.mark('b');
		pacer.push(frame(3));
		pacer.push(frame(4));
		pacer.push(frame(5)); // evicts 2; 'b' stays at the head of the queue
		pacer.push(frame(6)); // evicts 3
		expect(marks).toEqual(['a']);
		expect(pacer.queuedFrames).toBe(3);

		expect(pacer.flush()).toBe(3);
		expect(marks).toEqual(['a', 'b']);
		expect(ids()).toEqual([0, 1, 4, 5, 6]);
	});

	it('a throwing onFrame is reported to onError and the release carries on with the next frame', () => {
		const errors: unknown[] = [];
		const { pacer, advanceFrames, ids } = manualPacer(40, {
			onFrame: (payload) => {
				if (payload[0] === 3) throw new Error('boom');
				released.push(payload);
			},
		});
		const released: Uint8Array[] = [];
		pacer.onError = (e) => errors.push(e);
		for (let i = 0; i < 6; i++) pacer.push(frame(i));
		advanceFrames(2); // frame 3 throws from the timer callback
		advanceFrames(5);
		expect(released.map((f) => f[0])).toEqual([0, 1, 2, 4, 5]);
		expect(errors).toHaveLength(1);
		expect(pacer.queuedFrames).toBe(0);
		expect(ids()).toEqual([]); // the harness's own collector was replaced
	});

	it('a throwing onFrame during flush() is reported and the rest of the flush still goes out', () => {
		const errors: unknown[] = [];
		const released: number[] = [];
		const { pacer } = manualPacer(40, {
			onFrame: (payload) => {
				if (payload[0] === 2) throw new Error('boom');
				released.push(payload[0]);
			},
		});
		pacer.onError = (e) => errors.push(e);
		for (let i = 0; i < 5; i++) pacer.push(frame(i));
		expect(pacer.flush()).toBe(3);
		expect(released).toEqual([0, 1, 3, 4]);
		expect(errors).toHaveLength(1);
	});

	it('without onError a throw from onFrame propagates', () => {
		const { pacer } = manualPacer(40, {
			onFrame: () => {
				throw new Error('boom');
			},
		});
		expect(() => pacer.push(frame(0))).toThrow('boom');
	});

	it('queuedFrames counts frames only and tracks releases, clears and flushes', () => {
		const { pacer, advance } = manualPacer(40);
		for (let i = 0; i < 5; i++) pacer.push(frame(i));
		pacer.mark('m');
		expect(pacer.queuedFrames).toBe(3);
		advance(20);
		expect(pacer.queuedFrames).toBe(2);
		expect(pacer.clear()).toBe(2);
		expect(pacer.queuedFrames).toBe(0);
	});
});
