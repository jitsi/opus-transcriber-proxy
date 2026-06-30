/**
 * Tests for RtpTimestamper — the RTP timestamp / sequence-number generator on the
 * translation return path (src/RtpTimestamper.ts).
 *
 * The OpenAI translation output is bursty and not real-time: a whole utterance can
 * arrive far faster than it plays, and successive utterances are separated by real
 * silence. These tests pin the behaviour the JVB return path depends on:
 *
 *  - the timestamp NEVER decreases, even when many frames are produced at the same
 *    wall-clock instant (a burst delivered faster than real time);
 *  - consecutive OpenAI chunks whose inter-arrival gap is shorter than the audio
 *    already buffered for playout produce ONE continuous RTP timeline (no gap);
 *  - a wall-clock idle longer than the buffered media inserts a proportional jump
 *    in the RTP timestamp (a real pause is preserved, not collapsed);
 *  - jitter below the gap threshold is treated as contiguous;
 *  - the sequence number increments from 0 and wraps as a uint16.
 *
 * A fake clock is injected so every assertion is deterministic.
 */

import { describe, it, expect } from 'vitest';
import { RtpTimestamper } from '../../src/RtpTimestamper';

const SAMPLES_PER_FRAME = 960; // 20 ms at 48 kHz

/** A timestamper driven by a mutable fake clock. */
function withClock() {
	let now = 0;
	const t = new RtpTimestamper({ now: () => now });
	return {
		t,
		set: (ms: number) => {
			now = ms;
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe('RtpTimestamper', () => {
	it('anchors at the first frame: timestamp starts at 0 and steps by one frame at steady real time', () => {
		const { t, set } = withClock();
		set(0);
		expect(t.nextFrameTimestamp().timestamp).toBe(0);
		set(20);
		expect(t.nextFrameTimestamp().timestamp).toBe(SAMPLES_PER_FRAME);
		set(40);
		expect(t.nextFrameTimestamp().timestamp).toBe(2 * SAMPLES_PER_FRAME);
	});

	it('never decreases the timestamp when a whole chunk is emitted in one burst (same wall instant)', () => {
		const { t, set } = withClock();
		set(1000); // 100 frames (2 s of media) all produced "now" — far faster than real time
		let prev = -1;
		for (let i = 0; i < 100; i++) {
			const { timestamp } = t.nextFrameTimestamp();
			expect(timestamp).toBe(i * SAMPLES_PER_FRAME); // strictly contiguous, no gap inserted
			expect(timestamp).toBeGreaterThan(prev);
			prev = timestamp;
		}
	});

	it('produces a continuous timeline when the next chunk arrives within the buffered media', () => {
		const { t, set } = withClock();
		// Chunk A: 2 s of media (100 frames) burst-delivered at t=1000ms. Playout now ends at t=3000ms.
		set(1000);
		for (let i = 0; i < 100; i++) t.nextFrameTimestamp();

		// Chunk B arrives 1 s later (t=2000ms) — still inside the buffered media (< 3000ms),
		// so it must continue the same timeline with no inserted gap.
		set(2000);
		expect(t.nextFrameTimestamp().timestamp).toBe(100 * SAMPLES_PER_FRAME);
		expect(t.nextFrameTimestamp().timestamp).toBe(101 * SAMPLES_PER_FRAME);
	});

	it('inserts a proportional RTP-timestamp jump when the source idles longer than the buffered media', () => {
		const { t, set } = withClock();
		set(0);
		t.nextFrameTimestamp(); // frame 0 at ts 0; playout ends at 20ms

		// 10 s of real silence before the next frame. Gap = (10000-20)ms ≈ 9.98 s → 479040 ticks,
		// added on top of the one-frame advance (960) already pending → ts 480000 (≈ 10 s of RTP time).
		set(10000);
		expect(t.nextFrameTimestamp().timestamp).toBe(480000);
		// And it keeps stepping by one frame from there.
		set(10020);
		expect(t.nextFrameTimestamp().timestamp).toBe(480000 + SAMPLES_PER_FRAME);
	});

	it('treats sub-threshold jitter as contiguous (no gap inserted)', () => {
		const { t, set } = withClock();
		set(0);
		t.nextFrameTimestamp(); // ts 0; playout ends at 20ms
		// 99 ms past playout end is below the 100 ms default threshold → no gap.
		set(119);
		expect(t.nextFrameTimestamp().timestamp).toBe(SAMPLES_PER_FRAME);
	});

	it('inserts a gap once jitter exceeds the threshold', () => {
		const { t, set } = withClock();
		set(0);
		t.nextFrameTimestamp(); // ts 0; playout ends at 20ms
		// 101 ms past playout end exceeds the 100 ms threshold → gap inserted.
		set(121);
		expect(t.nextFrameTimestamp().timestamp).toBeGreaterThan(SAMPLES_PER_FRAME);
	});

	it('honours a custom gap threshold', () => {
		let now = 0;
		const t = new RtpTimestamper({ now: () => now, gapThresholdMs: 500 });
		now = 0;
		t.nextFrameTimestamp();
		now = 300; // 280 ms past playout end, below the 500 ms threshold → contiguous
		expect(t.nextFrameTimestamp().timestamp).toBe(SAMPLES_PER_FRAME);
	});

	it('emits sequence numbers starting at 0 and incrementing', () => {
		const { t, advance } = withClock();
		for (let i = 0; i < 5; i++) {
			expect(t.nextFrameTimestamp().sequenceNumber).toBe(i);
			advance(20);
		}
	});

	it('wraps the sequence number as a uint16 (0xffff -> 0)', () => {
		const { t } = withClock(); // wall clock fixed at 0 — sequence wrap is independent of timing
		let last = -1;
		for (let i = 0; i < 0x10000; i++) {
			last = t.nextFrameTimestamp().sequenceNumber;
		}
		expect(last).toBe(0xffff); // the 65536th frame
		expect(t.nextFrameTimestamp().sequenceNumber).toBe(0); // wraps
		expect(t.nextFrameTimestamp().sequenceNumber).toBe(1);
	});

	it('keeps the timestamp monotonic across an arbitrary mix of bursts and gaps', () => {
		const { t, set } = withClock();
		const schedule = [0, 0, 0, 50, 50, 5000, 5020, 5020, 30000, 30000, 30000];
		let prev = -1;
		for (const ms of schedule) {
			set(ms);
			const { timestamp } = t.nextFrameTimestamp();
			expect(timestamp).toBeGreaterThan(prev);
			prev = timestamp;
		}
	});
});
