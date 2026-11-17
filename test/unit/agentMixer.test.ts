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
 * Tests for the `mix` fan-in's mixer (AgentMixer, SourceTrack, the limiter), on a fake clock.
 *
 * The fake decoder turns a packet into 20 ms of one constant sample value (the packet's two bytes), so a frame
 * of the mix shows at a glance which sources are in it; concealed audio is the constant 7.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentMixer } from '../../src/agent/mix/Mixer';
import { applyGainRamp, kneeFromDb, limitToPcm16, mixGain } from '../../src/agent/mix/limiter';
import { mixEventCounts } from '../../src/agent/mix/metrics';
import type { MixStats } from '../../src/agent/mix/SourceTrack';
import { DEFAULT_MIX_CONFIG, MixConfig } from '../../src/agent/mixConfig';

const FRAME = 480; // 20 ms at 24 kHz
const CONCEALED = 7;

function constantPcm(value: number, samples: number): Uint8Array {
	return new Uint8Array(new Int16Array(samples).fill(value).buffer);
}

function fakeDecoder(ready: Promise<void> = Promise.resolve()) {
	return {
		ready,
		decodeFrame: vi.fn((frame: Uint8Array) => ({
			audioData: constantPcm(new Int16Array(frame.slice().buffer)[0], FRAME),
			samplesDecoded: FRAME,
			errors: [] as unknown[],
		})),
		conceal: vi.fn((_frame: Uint8Array | undefined, samples: number) => ({
			audioData: constantPcm(CONCEALED, samples),
			samplesDecoded: samples,
			errors: [] as unknown[],
		})),
		reset: vi.fn(),
		free: vi.fn(),
	};
}

/** A clock that only moves when told to, running the timers that fall due on the way. */
function fakeClock() {
	let t = 0;
	let timers: Array<{ fn: () => void; at: number }> = [];
	const run = (end: number, late: number) => {
		for (;;) {
			const next = timers.filter((timer) => timer.at + late <= end).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			timers = timers.filter((timer) => timer !== next);
			t = Math.max(t, next.at + late);
			next.fn();
		}
		t = end;
	};
	return {
		now: () => t,
		setTimer: (fn: () => void, ms: number) => {
			const handle = { fn, at: t + ms };
			timers.push(handle);
			return handle;
		},
		clearTimer: (handle: unknown) => {
			timers = timers.filter((timer) => timer !== handle);
		},
		advance: (ms: number) => run(t + ms, 0),
		/** As advance, but every timer fires `late` ms after it is due. */
		advanceLate: (ms: number, late: number) => run(t + ms, late),
		/** Time passes with no timer running: a stalled process. */
		stall(ms: number) {
			t += ms;
		},
		get pendingTimers() {
			return timers.length;
		},
	};
}

interface Frame {
	samples: Int16Array;
	timestamp: number;
}

interface SetupExtras {
	/** The `ready` of each new decoder; resolved at once when not given. */
	ready?: () => Promise<void>;
	/** Runs in `onFrame`, before the frame is recorded; may throw. */
	onFrame?: () => void;
}

function setup(overrides: Partial<MixConfig> = {}, extras: SetupExtras = {}) {
	const clock = fakeClock();
	const frames: Frame[] = [];
	const mixed: string[][] = [];
	const metrics: string[] = [];
	const fatal: string[] = [];
	const deltas: MixStats[] = [];
	const decoders: Array<ReturnType<typeof fakeDecoder>> = [];
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const mixer = new AgentMixer({
		config: { ...DEFAULT_MIX_CONFIG, ...overrides },
		createDecoder: () => {
			const decoder = fakeDecoder(extras.ready?.());
			decoders.push(decoder);
			return decoder as any;
		},
		logger,
		onFrame: (pcm, timestamp) => {
			extras.onFrame?.();
			frames.push({ samples: new Int16Array(pcm.slice().buffer), timestamp });
		},
		onMixedChange: (tags) => mixed.push(tags),
		onStats: (delta) => deltas.push(delta),
		onMetric: (name, errorType) => metrics.push(errorType ? `${name}:${errorType}` : name),
		onFatal: (reason) => fatal.push(reason),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	/** Packet `chunk` of a source: 20 ms of the constant `value`, at its place on the sender's clock. */
	const packet = (value: number, chunk: number, extra: Record<string, unknown> = {}) => ({
		frame: new Uint8Array(new Int16Array([value]).buffer),
		chunk,
		timestamp: 5000 + chunk * 960,
		...extra,
	});
	/** Lets a new source's decoder become ready (a few microtasks). */
	const settle = async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	};
	/** The constant value of each frame; a frame that is not constant shows as its first and last sample. */
	const values = () =>
		frames.map((f) => (f.samples.every((s) => s === f.samples[0]) ? f.samples[0] : `${f.samples[0]}..${f.samples[f.samples.length - 1]}`));
	/** The place of each frame on the timeline, in frames of 20 ms. */
	const ticks = () => frames.map((f) => f.timestamp / 960);
	return { clock, frames, mixed, metrics, fatal, deltas, decoders, logger, mixer, packet, settle, values, ticks };
}

describe('mix limiter', () => {
	it('scales by the number of sources only when asked to', () => {
		expect(mixGain('unity', 4)).toBe(1);
		expect(mixGain('sqrt', 4)).toBe(0.5);
		expect(mixGain('average', 4)).toBe(0.25);
		expect(mixGain('average', 1)).toBe(1);
		expect(mixGain('sqrt', 0)).toBe(1);
	});

	it('ramps a gain change across the frame and ends on the new gain', () => {
		const sum = new Float64Array(4).fill(1000);
		applyGainRamp(sum, 1, 0.5);
		expect(Array.from(sum)).toEqual([875, 750, 625, 500]);
		const untouched = new Float64Array(4).fill(1000);
		applyGainRamp(untouched, 1, 1);
		expect(Array.from(untouched)).toEqual([1000, 1000, 1000, 1000]);
	});

	it('soft: leaves samples below the knee alone and never passes full scale', () => {
		const knee = kneeFromDb(-3);
		expect(knee).toBe(23197);
		const sum = Float64Array.from([0, 100, -100, knee, -knee, knee + 1000, -(knee + 1000), 40000, -40000, 1e9, -1e9]);
		const out = new Int16Array(sum.length);
		expect(limitToPcm16(sum, out, 'soft', knee)).toBe(true);
		expect(Array.from(out.slice(0, 5))).toEqual([0, 100, -100, knee, -knee]);
		// Above the knee: bent, monotonic, symmetric, and bounded.
		expect(out[5]).toBeGreaterThan(knee);
		expect(out[5]).toBeLessThan(knee + 1000);
		expect(out[6]).toBe(-out[5]);
		expect(out[7]).toBeGreaterThan(out[5]);
		expect(out[7]).toBeLessThan(32767);
		expect(out[9]).toBe(32767);
		expect(out[10]).toBe(-out[9]);
	});

	it('soft: says nothing was changed when nothing reached the knee', () => {
		const out = new Int16Array(2);
		expect(limitToPcm16(Float64Array.from([1000, -20000]), out, 'soft', kneeFromDb(-3))).toBe(false);
		expect(Array.from(out)).toEqual([1000, -20000]);
	});

	it('clamp: cuts at full scale and nowhere else', () => {
		const out = new Int16Array(4);
		expect(limitToPcm16(Float64Array.from([30000, 40000, -40000, -30000]), out, 'clamp', kneeFromDb(-3))).toBe(true);
		expect(Array.from(out)).toEqual([30000, 32767, -32768, -30000]);
	});

	it('a knee at full scale is a clamp', () => {
		const out = new Int16Array(2);
		limitToPcm16(Float64Array.from([32000, 50000]), out, 'soft', kneeFromDb(0));
		expect(Array.from(out)).toEqual([32000, 32767]);
	});
});

describe('AgentMixer', () => {
	it('plays one source one buffer late, bit-exact, at the pace of its RTP timestamps', async () => {
		const { clock, mixer, packet, settle, values, frames } = setup();
		for (let chunk = 0; chunk < 5; chunk++) {
			mixer.push('a', packet(100 + chunk, chunk));
			await settle();
			clock.advance(20);
		}
		clock.advance(100);
		// The first packet arrived at 0 and plays from 60 ms: the frame mixed at 80 ms.
		expect(values()).toEqual([100, 101, 102, 103, 104]);
		expect(frames[0].timestamp).toBe(3 * 960);
		expect(frames.map((f) => f.timestamp - frames[0].timestamp)).toEqual([0, 960, 1920, 2880, 3840]);
		expect(mixer.stats).toMatchObject({ packets: 5, latePackets: 0, framesSent: 5, framesLimited: 0, maxSources: 1 });
	});

	it('sends nothing while nobody talks, and a frame on every tick when continuous', async () => {
		const gaps = setup();
		gaps.clock.advance(200);
		gaps.mixer.push('a', gaps.packet(5, 0));
		await gaps.settle();
		gaps.clock.advance(200);
		expect(gaps.values()).toEqual([5]);

		const continuous = setup({ continuous: true });
		continuous.mixer.start();
		continuous.clock.advance(100);
		expect(continuous.values()).toEqual([0, 0, 0, 0, 0]);
		expect(continuous.frames.map((f) => f.timestamp)).toEqual([0, 960, 1920, 2880, 3840]);
	});

	it('absorbs arrival jitter up to the buffer: the output follows the sender clock, not the arrival times', async () => {
		const { clock, mixer, packet, settle, values } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(20);
		mixer.push('a', packet(2, 1));
		clock.advance(70); // packet 2 is 50 ms late, and arrives together with packet 3
		mixer.push('a', packet(3, 2));
		mixer.push('a', packet(4, 3));
		clock.advance(100);
		expect(values()).toEqual([1, 2, 3, 4]);
		expect(mixer.stats.latePackets).toBe(0);
	});

	it('sums overlapping sources without changing the level of either', async () => {
		const { clock, mixer, packet, settle, values } = setup();
		// a talks for 6 frames; b joins for frames 2 and 3.
		for (let chunk = 0; chunk < 6; chunk++) {
			mixer.push('a', packet(1000, chunk));
			if (chunk === 2 || chunk === 3) {
				mixer.push('b', packet(300, chunk));
			}
			await settle();
			clock.advance(20);
		}
		clock.advance(100);
		expect(values()).toEqual([1000, 1000, 1300, 1300, 1000, 1000]);
		expect(mixer.stats.maxSources).toBe(2);
		expect(mixer.stats.framesLimited).toBe(0);
	});

	it('limits the peaks of an overlap, softly by default and with a clamp when asked', async () => {
		for (const [limiter, check] of [
			['soft', (v: number) => v > kneeFromDb(-3) && v < 32767],
			['clamp', (v: number) => v === 32767],
		] as const) {
			const { clock, mixer, packet, settle, frames } = setup({ limiter });
			mixer.push('a', packet(20000, 0));
			mixer.push('b', packet(20000, 0));
			await settle();
			clock.advance(100);
			expect(frames).toHaveLength(1);
			expect(check(frames[0].samples[0]), limiter).toBe(true);
			expect(mixer.stats.framesLimited).toBe(1);
		}
	});

	it('leaves one source alone bit-exact even at full scale', async () => {
		const { clock, mixer, packet, settle, values } = setup();
		mixer.push('a', packet(32767, 0));
		mixer.push('a', packet(-32768, 1));
		await settle();
		clock.advance(120);
		expect(values()).toEqual([32767, -32768]);
		expect(mixer.stats.framesLimited).toBe(0);
	});

	it('gain average: scales the sum by the number of sources, ramping into it', async () => {
		const { clock, mixer, packet, settle, frames, values } = setup({ gain: 'average' });
		mixer.push('a', packet(1000, 0));
		await settle();
		clock.advance(20);
		for (let chunk = 1; chunk < 4; chunk++) {
			mixer.push('a', packet(1000, chunk));
			mixer.push('b', packet(600, chunk));
			await settle();
			clock.advance(20);
		}
		clock.advance(100);
		// a alone, then the frame where b joins ramps from gain 1 to 1/2, then both at half.
		expect(values()[0]).toBe(1000);
		expect(frames[1].samples[0]).toBeGreaterThan(800);
		expect(frames[1].samples[FRAME - 1]).toBe(800);
		expect(values().slice(2)).toEqual([800, 800]);
	});

	it('conceals a short loss before the packet that follows it', async () => {
		const { clock, mixer, packet, settle, values, decoders } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(20);
		mixer.push('a', packet(2, 1));
		clock.advance(40); // chunk 2 never arrives
		mixer.push('a', packet(4, 3));
		clock.advance(120);
		expect(values()).toEqual([1, 2, CONCEALED, 4]);
		expect(decoders[0].conceal).toHaveBeenCalledWith(expect.any(Uint8Array), FRAME);
		expect(mixer.stats).toMatchObject({ concealments: 1, concealedMs: 20 });
	});

	it('does not conceal when concealment is off, or when the gap is longer than it may conceal', async () => {
		const off = setup({ concealMs: 0 });
		off.mixer.push('a', off.packet(1, 0));
		await off.settle();
		off.clock.advance(40);
		off.mixer.push('a', off.packet(3, 2));
		off.clock.advance(120);
		expect(off.values()).toEqual([1, 3]);
		expect(off.decoders[0].conceal).not.toHaveBeenCalled();

		const long = setup({ concealMs: 40 });
		long.mixer.push('a', long.packet(1, 0));
		await long.settle();
		long.clock.advance(80);
		long.mixer.push('a', long.packet(5, 4)); // 60 ms lost
		long.clock.advance(120);
		expect(long.values()).toEqual([1, 5]);
		expect(long.decoders[0].conceal).not.toHaveBeenCalled();
	});

	it('plays a late packet as it arrives, and the rest of the talk after it: a pause, not a hole', async () => {
		const { clock, mixer, packet, settle, frames, values } = setup({ bufferMs: 20 });
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(200); // the path stalls for 200 ms, then delivers what it held
		mixer.push('a', packet(2, 1));
		mixer.push('a', packet(3, 2));
		mixer.push('a', packet(4, 3));
		clock.advance(20);
		mixer.push('a', packet(5, 4)); // on time again, relative to the new anchor
		clock.advance(200);
		expect(values()).toEqual([1, 2, 3, 4, 5]);
		// 1 played at 20 ms; 2 arrived at 200 ms and plays from there, with 3, 4 and 5 right behind it.
		expect(frames.map((f) => f.timestamp / 960)).toEqual([1, 10, 11, 12, 13]);
		expect(mixer.stats).toMatchObject({ latePackets: 1, anchorsLate: 1, anchorsDeep: 0, skippedMs: 0 });
	});

	it('lateResyncPackets above 1: drops the late packets before the one that takes the new anchor', async () => {
		const { clock, mixer, packet, settle, values } = setup({ bufferMs: 20, lateResyncPackets: 3 });
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(200); // the path stalls: the next packets are 180 ms late
		mixer.push('a', packet(2, 1));
		mixer.push('a', packet(3, 2));
		clock.advance(20);
		expect(mixer.stats).toMatchObject({ latePackets: 2, anchorsLate: 0 });
		mixer.push('a', packet(4, 3)); // the third late one in a row: play from here
		mixer.push('a', packet(5, 4));
		clock.advance(120);
		expect(values()).toEqual([1, 4, 5]);
		expect(mixer.stats).toMatchObject({ latePackets: 3, anchorsLate: 1 });
	});

	it('starts a new talk one buffer after its first packet, however long the silence was', async () => {
		const { clock, mixer, packet, settle, frames, values } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(1000);
		// One second of silence on the sender's clock too (the bridge forwards no silence).
		mixer.push('a', { ...packet(2, 1), timestamp: 5000 + 48000 });
		clock.advance(200);
		expect(values()).toEqual([1, 2]);
		// Played 60 ms after it arrived at 1000 ms: the frame that starts at 1060 ms.
		expect(frames[1].timestamp).toBe(53 * 960);
		expect(mixer.stats.anchorsTalk).toBe(2);
		expect(mixer.stats.latePackets).toBe(0);
	});

	it('discards an old or repeated packet rather than decode it out of order', async () => {
		const { clock, mixer, packet, settle, values, decoders } = setup();
		mixer.push('a', packet(1, 5));
		await settle();
		mixer.push('a', packet(9, 5));
		mixer.push('a', packet(9, 4));
		mixer.push('a', packet(2, 6));
		clock.advance(140);
		expect(values()).toEqual([1, 2]);
		expect(decoders[0].decodeFrame).toHaveBeenCalledTimes(2);
		expect(mixer.stats.outOfOrderPackets).toBe(2);
	});

	it('takes the numbering of a restarted source: the bridge starts chunk again with a new start event', async () => {
		const { clock, mixer, packet, settle, values } = setup();
		// The first stream of the source ends at chunk 30000; its next one begins below that, as a new SSRC can.
		mixer.push('a', packet(1, 30000));
		await settle();
		clock.advance(20);
		mixer.restart('a');
		for (let i = 0; i < 3; i++) {
			mixer.push('a', { ...packet(2 + i, 29500 + i), timestamp: 5000 + (30001 + i) * 960 });
			clock.advance(20);
		}
		clock.advance(200);
		expect(values()).toEqual([1, 2, 3, 4]);
		expect(mixer.stats.outOfOrderPackets).toBe(0);
		expect(mixer.stats.concealments).toBe(0);
	});

	it('takes a run of packets that all look old as a restarted source, and says so once', async () => {
		const { clock, mixer, packet, settle, values, logger } = setup();
		mixer.push('a', packet(1, 30000));
		await settle();
		clock.advance(20);
		// No start event this time: ten packets in a row below the last chunk are not ten stragglers.
		for (let i = 0; i < 12; i++) {
			mixer.push('a', { ...packet(100 + i, 29500 + i), timestamp: 5000 + (30001 + i) * 960 });
			clock.advance(20);
		}
		clock.advance(200);
		expect(values()).toEqual([1, 110, 111]);
		expect(mixer.stats.outOfOrderPackets).toBe(10);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('numbering started again'));
	});

	it('skips the oldest audio of a source queued further ahead than maxBufferMs, back to one buffer', async () => {
		const { clock, mixer, packet, settle, values } = setup({ bufferMs: 60, maxBufferMs: 160 });
		mixer.push('a', packet(0, 0));
		await settle();
		// A burst far faster than real time: every packet is 20 ms later on the sender's clock, none on ours.
		// Packets 0..5 sit 60..160 ms ahead; packet 6 would sit 180 ms ahead.
		for (let chunk = 1; chunk <= 6; chunk++) {
			mixer.push('a', packet(chunk, chunk));
		}
		expect(mixer.stats).toMatchObject({ anchorsDeep: 1, skippedMs: 60 });
		clock.advance(400);
		// Moved 120 ms earlier, which put packets 0..2 before the first frame not yet mixed: 60 ms never played.
		expect(values()).toEqual([3, 4, 5, 6]);
		expect(mixer.stats.latePackets).toBe(0);
	});

	it('leaves a source alone that is ahead by less than maxBufferMs', async () => {
		const { clock, mixer, packet, settle, values } = setup();
		mixer.push('a', packet(0, 0));
		await settle();
		for (let chunk = 1; chunk <= 10; chunk++) {
			mixer.push('a', packet(chunk, chunk));
		}
		clock.advance(400);
		expect(values()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(mixer.stats).toMatchObject({ anchorsDeep: 0, skippedMs: 0 });
	});

	it('caps the mix at the loudest sources when a cap is set', async () => {
		const { clock, mixer, packet, settle, values } = setup({ maxSpeakers: 1 });
		for (let chunk = 0; chunk < 3; chunk++) {
			mixer.push('quiet', packet(100, chunk, { audioLevel: 60 }));
			mixer.push('loud', packet(900, chunk, { audioLevel: 20 }));
			await settle();
			clock.advance(20);
		}
		clock.advance(100);
		expect(values()).toEqual([900, 900, 900]);
		expect(mixer.stats.framesCapped).toBe(3);
	});

	it('mixes frames of the configured duration', async () => {
		const { clock, mixer, packet, settle, frames } = setup({ frameMs: 40, bufferMs: 0 });
		mixer.push('a', packet(3, 0));
		mixer.push('a', packet(4, 1));
		await settle();
		clock.advance(80);
		expect(frames).toHaveLength(1);
		expect(frames[0].samples).toHaveLength(2 * FRAME);
		expect([frames[0].samples[0], frames[0].samples[2 * FRAME - 1]]).toEqual([3, 4]);
		clock.advance(40);
		mixer.push('a', { ...packet(5, 2), timestamp: 5000 + 48000 });
		clock.advance(80);
		expect(frames[1].timestamp - frames[0].timestamp).toBe(3 * 1920);
	});

	it('reports who is in a talk, without flapping on the pauses inside one', async () => {
		const { clock, mixer, packet, settle, mixed } = setup({ talkGapMs: 200 });
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(100);
		mixer.push('b', packet(2, 0));
		await settle();
		clock.advance(100);
		// a pauses for 100 ms inside its talk: still in the mix.
		mixer.push('a', { ...packet(1, 1), timestamp: 5000 + 960 + 100 * 48 * 2 });
		clock.advance(500);
		expect(mixed).toEqual([['a'], ['a', 'b'], ['a'], []]);
	});

	it('frees the decoder of a source that went quiet, and makes a new one when it comes back', async () => {
		const { clock, mixer, packet, settle, decoders, values } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(20_000);
		expect(mixer.trackCount).toBe(1);
		clock.advance(15_000);
		expect(mixer.trackCount).toBe(0);
		expect(decoders[0].free).toHaveBeenCalledTimes(1);
		mixer.push('a', packet(2, 500));
		await settle();
		clock.advance(200);
		expect(decoders).toHaveLength(2);
		expect(values()).toEqual([1, 2]);
	});

	it('skips ahead after a stall instead of sending a burst of stale frames', async () => {
		const { clock, mixer, settle, frames } = setup({ continuous: true });
		mixer.start();
		clock.advance(40);
		await settle();
		clock.stall(5000);
		clock.advance(20);
		expect(frames.length).toBeLessThan(10);
		expect(mixer.stats.ticksSkipped).toBeGreaterThan(200);
		// The timeline kept its place: the next frame's timestamp is where real time is.
		expect(frames[frames.length - 1].timestamp).toBeGreaterThan(5000 * 48);
	});

	it('drops what waits for a decoder that fails to initialise, and what comes after', async () => {
		const clock = fakeClock();
		const frames: Frame[] = [];
		const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		let fail!: (error: Error) => void;
		const failing = { ...fakeDecoder(), ready: new Promise<void>((_, reject) => (fail = reject)) };
		const mixer = new AgentMixer({
			config: { ...DEFAULT_MIX_CONFIG },
			createDecoder: () => failing as any,
			logger,
			onFrame: (pcm, timestamp) => frames.push({ samples: new Int16Array(pcm.slice().buffer), timestamp }),
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		});
		const frame = new Uint8Array(new Int16Array([1]).buffer);
		mixer.push('a', { frame, chunk: 0, timestamp: 0 });
		fail(new Error('no wasm'));
		await Promise.resolve();
		await Promise.resolve();
		mixer.push('a', { frame, chunk: 1, timestamp: 960 });
		mixer.push('a', { frame, chunk: 2, timestamp: 1920 });
		clock.advance(200);
		expect(frames).toEqual([]);
		expect(failing.decodeFrame).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('stops its clock and frees every decoder on close', async () => {
		const { clock, mixer, packet, settle, decoders, frames } = setup();
		mixer.push('a', packet(1, 0));
		mixer.push('b', packet(2, 0));
		await settle();
		mixer.close();
		mixer.close();
		expect(clock.pendingTimers).toBe(0);
		expect(decoders.map((d) => d.free.mock.calls.length)).toEqual([1, 1]);
		mixer.push('a', packet(1, 1));
		clock.advance(200);
		expect(frames).toEqual([]);
	});

	// ---- the clock ----

	it('runs every tick that is due when its timer fires late: no frame is lost and the timeline does not drift', async () => {
		const { clock, mixer, frames, ticks } = setup({ continuous: true });
		clock.advanceLate(1000, 45);
		expect(frames.length).toBeGreaterThanOrEqual(47);
		expect(ticks()).toEqual(frames.map((_, i) => i));
		expect(mixer.stats.ticksSkipped).toBe(0);
	});

	it('asks for the time left to the next tick after a late timer, not for a whole frame', () => {
		let t = 0;
		const delays: number[] = [];
		let pending: (() => void) | undefined;
		new AgentMixer({
			config: { ...DEFAULT_MIX_CONFIG, continuous: true },
			createDecoder: () => fakeDecoder() as any,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			onFrame: () => {},
			now: () => t,
			setTimer: (fn, ms) => {
				delays.push(ms);
				pending = fn;
				return fn;
			},
			clearTimer: () => {},
		});
		t = 27; // due at 20, fired 7 ms late
		pending!();
		t = 47;
		pending!();
		expect(delays).toEqual([20, 13, 13]);
	});

	it('after a stall, drops the audio whose time passed, says so, and goes on from now', async () => {
		const { clock, mixer, packet, settle, values, ticks, logger } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		mixer.push('a', packet(2, 1));
		mixer.push('a', packet(3, 2));
		clock.stall(5000);
		clock.advance(20);
		mixer.push('a', packet(4, 3));
		clock.advance(200);
		expect(values()).toEqual([4]);
		expect(ticks()).toEqual([251]);
		expect(mixer.stats).toMatchObject({ ticksSkipped: 249, anchorsLate: 1 });
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/the clock stalled for 5000 ms; skipped 249 frames/));
	});

	it('a frame that fails to be delivered is said once and the clock goes on', async () => {
		let fail = true;
		const { clock, frames, logger, mixer, fatal } = setup(
			{ continuous: true },
			{
				onFrame: () => {
					if (fail) {
						fail = false;
						throw new Error('send failed');
					}
				},
			},
		);
		clock.advance(100);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(frames).toHaveLength(4);
		expect(mixer.stats.framesFailed).toBe(1);
		expect(fatal).toEqual([]);
	});

	it('gives up when frames keep failing, at a bounded log rate: a mix that sends nothing must not look alive', async () => {
		const { clock, logger, mixer, fatal, frames } = setup(
			{ continuous: true },
			{
				onFrame: () => {
					throw new Error('send failed');
				},
			},
		);
		clock.advance(2000);
		expect(frames).toEqual([]);
		expect(fatal).toEqual(['50 frames in a row failed to mix']);
		expect(mixer.stats.framesFailed).toBe(100);
		// The first failure, and the fatal line; not one line per frame.
		expect(logger.error.mock.calls.length).toBeLessThanOrEqual(3);
	});

	it('hands the counts since the last report to onStats every 30 s, and the rest on request', async () => {
		const { clock, mixer, packet, settle, deltas } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(30_000);
		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toMatchObject({ packets: 1, framesSent: 1 });
		mixer.push('a', { ...packet(2, 1), timestamp: 5000 + 30 * 48000 });
		clock.advance(1000);
		expect(mixer.takeStatsDelta()).toMatchObject({ packets: 1, framesSent: 1, anchorsTalk: 1 });
		expect(mixer.takeStatsDelta()).toMatchObject({ packets: 0, framesSent: 0 });
		expect(mixer.stats).toMatchObject({ packets: 2, framesSent: 2 });
	});

	it('names every count as a metric event', () => {
		const stats = { ...setup().mixer.stats, packets: 9, latePackets: 2, anchorsLate: 2, anchorsDeep: 1, skippedMs: 59.6, decodeErrors: 3 };
		expect(mixEventCounts(stats)).toMatchObject({
			packet: 9,
			late_packet: 2,
			resync: 3,
			skipped_ms: 60,
			decode_error: 3,
			pending_dropped: 0,
		});
		// Every count is exported, except the three that only make sense as a session's total or split.
		const exported = Object.keys(mixEventCounts(stats)).length;
		expect(exported).toBe(
			Object.keys(stats).length - ['concealedMs', 'anchorsTalk', 'anchorsLate', 'anchorsDeep', 'maxSources'].length + 1,
		);
	});

	// ---- the decoder ----

	it('plays the packets held while a decoder initialises in order, at their own times, with no delay beyond the wait', async () => {
		let release!: () => void;
		const { clock, mixer, packet, settle, values, ticks } = setup({}, { ready: () => new Promise<void>((resolve) => (release = resolve)) });
		for (let chunk = 0; chunk < 5; chunk++) {
			mixer.push('a', packet(10 + chunk, chunk));
			clock.advance(20);
		}
		release(); // ready at 100 ms, 40 ms after the first packet was due to play
		await settle();
		for (let chunk = 5; chunk < 8; chunk++) {
			mixer.push('a', packet(10 + chunk, chunk));
			clock.advance(20);
		}
		clock.advance(400);
		expect(values()).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
		// The first one plays as soon as it can, at 100 ms; had it been placed one buffer from then, at 160 ms.
		expect(ticks()[0]).toBe(5);
		expect(mixer.stats).toMatchObject({ latePackets: 0, anchorsLate: 0, anchorsDeep: 0, skippedMs: 0 });
	});

	it('holds at most 50 packets for a decoder; the rest are dropped, counted, and said once', async () => {
		let release!: () => void;
		const { mixer, packet, settle, decoders, logger, metrics } = setup(
			{},
			{ ready: () => new Promise<void>((resolve) => (release = resolve)) },
		);
		for (let chunk = 0; chunk < 60; chunk++) {
			mixer.push('a', packet(chunk, chunk));
		}
		release();
		await settle();
		expect(mixer.stats.pendingDropped).toBe(10);
		expect(decoders[0].decodeFrame).toHaveBeenCalledTimes(50);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('while its decoder initialises'));
		expect(metrics).toEqual(['agent_media_dropped:decoder_pending']);
	});

	it('frees a decoder that becomes ready after the mixer closed, and decodes nothing with it', async () => {
		let release!: () => void;
		const { mixer, packet, settle, decoders } = setup({}, { ready: () => new Promise<void>((resolve) => (release = resolve)) });
		mixer.push('a', packet(1, 0));
		mixer.close();
		expect(decoders[0].free).not.toHaveBeenCalled();
		release();
		await settle();
		expect(decoders[0].free).toHaveBeenCalledTimes(1);
		expect(decoders[0].decodeFrame).not.toHaveBeenCalled();
	});

	it('a restart that arrives while the decoder initialises takes effect in its place, behind the packets before it', async () => {
		let release!: () => void;
		const { clock, mixer, packet, settle, values } = setup({}, { ready: () => new Promise<void>((resolve) => (release = resolve)) });
		mixer.push('a', packet(1, 30000));
		mixer.restart('a');
		mixer.push('a', { ...packet(2, 29500), timestamp: 5000 + 30001 * 960 });
		release();
		await settle();
		clock.advance(200);
		expect(values()).toEqual([1, 2]);
		expect(mixer.stats.outOfOrderPackets).toBe(0);
	});

	it('counts a decoder that fails to initialise as the per-source path does, and frees it', async () => {
		const { clock, mixer, packet, settle, decoders, logger, metrics, fatal, frames } = setup(
			{},
			{ ready: () => Promise.reject(new Error('no wasm')) },
		);
		mixer.push('a', packet(1, 0));
		await settle();
		mixer.push('a', packet(2, 1));
		mixer.push('a', packet(3, 2));
		clock.advance(200);
		expect(frames).toEqual([]);
		expect(decoders[0].decodeFrame).not.toHaveBeenCalled();
		expect(mixer.stats.decoderFailures).toBe(1);
		expect(metrics).toEqual(['agent_decoder_failure', 'agent_media_dropped:decoder_failed']);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(fatal).toEqual([]);
		mixer.close();
		expect(decoders[0].free).toHaveBeenCalledTimes(1);
	});

	it('gives up when no decoder initialises at all, but not while one source works', async () => {
		const broken = setup({}, { ready: () => Promise.reject(new Error('no wasm')) });
		for (const tag of ['a', 'b', 'c']) {
			broken.mixer.push(tag, broken.packet(1, 0));
			await broken.settle();
		}
		expect(broken.fatal).toEqual(['no Opus decoder initialises']);

		let n = 0;
		const partial = setup({}, { ready: () => (n++ === 0 ? Promise.resolve() : Promise.reject(new Error('no wasm'))) });
		for (const tag of ['ok', 'a', 'b', 'c']) {
			partial.mixer.push(tag, partial.packet(1, 0));
			await partial.settle();
		}
		expect(partial.fatal).toEqual([]);
		expect(partial.mixer.stats.decoderFailures).toBe(3);
	});

	it('a packet that does not decode adds nothing, is counted, and is said at a bounded rate; the next one plays', async () => {
		const { clock, mixer, packet, settle, values, decoders, logger } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		decoders[0].decodeFrame.mockImplementationOnce(() => ({
			audioData: new Uint8Array(0),
			samplesDecoded: 0,
			errors: [{ message: 'corrupt' }],
		}));
		mixer.push('a', packet(2, 1));
		decoders[0].decodeFrame.mockImplementationOnce(() => {
			throw new Error('boom');
		});
		mixer.push('a', packet(3, 2));
		mixer.push('a', packet(4, 3));
		clock.advance(300);
		expect(mixer.stats.decodeErrors).toBe(2);
		expect(values()).toEqual([1, 4]);
		// The first is said with its reason; the second, a moment later, waits for the next report.
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/failed to decode media for tag a: corrupt$/));
		decoders[0].decodeFrame.mockImplementationOnce(() => {
			throw new Error('boom again');
		});
		clock.advance(6000);
		mixer.push('a', { ...packet(5, 4), timestamp: 5000 + 10 * 48000 });
		expect(logger.warn).toHaveBeenLastCalledWith(expect.stringMatching(/boom again \(2 packets since the last report\)$/));
	});

	// ---- concealment ----

	it('does not conceal a pause on the sender clock when no chunk is missing', async () => {
		const { clock, mixer, packet, settle, values, decoders } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(120);
		mixer.push('a', { ...packet(2, 1), timestamp: 5000 + 960 + 100 * 48 });
		clock.advance(300);
		expect(decoders[0].conceal).not.toHaveBeenCalled();
		expect(values()).toEqual([1, 2]);
	});

	it('gives the decoder the packet after the gap, and conceals a gap of exactly concealMs', async () => {
		const { clock, mixer, packet, settle, decoders } = setup({ concealMs: 40 });
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(60);
		const next = packet(4, 3); // chunks 1 and 2 missing: 40 ms
		mixer.push('a', next);
		expect(decoders[0].conceal).toHaveBeenCalledWith(next.frame, 2 * FRAME);
		expect(mixer.stats).toMatchObject({ concealments: 1, concealedMs: 40 });
	});

	it('places nothing for a gap the decoder could not conceal, and counts it', async () => {
		const { clock, mixer, packet, settle, values, decoders } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		decoders[0].conceal.mockImplementationOnce((_frame: Uint8Array | undefined, samples: number) => ({
			audioData: constantPcm(CONCEALED, samples),
			samplesDecoded: samples,
			errors: [{ message: 'x' }],
		}));
		clock.advance(40);
		mixer.push('a', packet(3, 2));
		decoders[0].conceal.mockImplementationOnce(() => {
			throw new Error('no plc');
		});
		clock.advance(40);
		mixer.push('a', packet(5, 4));
		clock.advance(200);
		expect(values()).toEqual([1, 3, 5]);
		expect(mixer.stats).toMatchObject({ concealments: 0, concealFailures: 2 });
	});

	// ---- the anchor rules ----

	it('follows the moved anchor after a skip: one skip, then in step', async () => {
		const { clock, mixer, packet, settle, values } = setup({ bufferMs: 60, maxBufferMs: 160 });
		mixer.push('a', packet(0, 0));
		await settle();
		for (let chunk = 1; chunk <= 6; chunk++) {
			mixer.push('a', packet(chunk, chunk));
		}
		clock.advance(20);
		mixer.push('a', packet(7, 7));
		clock.advance(20);
		mixer.push('a', packet(8, 8));
		clock.advance(400);
		expect(values()).toEqual([3, 4, 5, 6, 7, 8]);
		expect(mixer.stats).toMatchObject({ anchorsDeep: 1, skippedMs: 60, latePackets: 0 });
	});

	it('never skips a source in step when maxBufferMs is set below the buffer: it is raised to leave room', async () => {
		const { clock, mixer, packet, settle, values } = setup({ bufferMs: 200, maxBufferMs: 100 });
		for (let chunk = 0; chunk < 10; chunk++) {
			mixer.push('a', packet(chunk + 1, chunk));
			await settle();
			clock.advance(20);
		}
		clock.advance(600);
		expect(mixer.stats.anchorsDeep).toBe(0);
		expect(values()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it('plays a new talk after the one still queued, not on top of it', async () => {
		const { clock, mixer, packet, settle, values } = setup({ bufferMs: 60, maxBufferMs: 2000 });
		mixer.push('a', packet(1, 0));
		await settle();
		for (let chunk = 1; chunk < 10; chunk++) {
			mixer.push('a', packet(1, chunk));
		}
		// Queued to 260 ms. A new talk (the sender's clock jumps 1 s) arrives at 20 ms.
		clock.advance(20);
		mixer.push('a', { ...packet(1, 10), timestamp: 5000 + 48000 });
		clock.advance(600);
		expect(values()).toEqual(new Array(11).fill(1));
	});

	it('takes a timestamp that jumps back as a new talk, played one buffer later, not dropped', async () => {
		const { clock, mixer, packet, settle, values } = setup();
		mixer.push('a', { ...packet(1, 0), timestamp: 100000 });
		await settle();
		clock.advance(20);
		mixer.push('a', { ...packet(2, 1), timestamp: 5000 });
		clock.advance(300);
		expect(values()).toEqual([1, 2]);
		expect(mixer.stats.anchorsTalk).toBe(2);
	});

	it('takes a chunk far below the last one as a restarted stream at once', async () => {
		const { clock, mixer, packet, settle, values, decoders } = setup();
		mixer.push('a', packet(1, 5000));
		await settle();
		clock.advance(20);
		mixer.push('a', { ...packet(2, 0), timestamp: 5000 + 5001 * 960 });
		clock.advance(200);
		expect(values()).toEqual([1, 2]);
		expect(mixer.stats.outOfOrderPackets).toBe(0);
		expect(decoders[0].conceal).not.toHaveBeenCalled();
	});

	it('places packets with no timestamp one after the other, and says once that it does', async () => {
		const { clock, mixer, settle, values, logger } = setup();
		for (let chunk = 0; chunk < 4; chunk++) {
			mixer.push('a', { frame: new Uint8Array(new Int16Array([chunk + 1]).buffer), chunk });
			await settle();
			clock.advance(20);
		}
		clock.advance(200);
		expect(values()).toEqual([1, 2, 3, 4]);
		expect(mixer.stats.anchorsTalk).toBe(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no usable timestamp'));
	});

	it('a packet that overlaps the one before it follows on; the overlap is not summed', async () => {
		const { clock, mixer, packet, settle, values } = setup();
		mixer.push('a', packet(100, 0));
		await settle();
		mixer.push('a', { ...packet(100, 1), timestamp: 5000 + 480 });
		clock.advance(300);
		expect(values()).toEqual([100, 100]);
	});

	it('a packet is late only when its frame has started to be mixed, not when real time passed its start', async () => {
		const { clock, mixer, packet, settle, ticks } = setup({ bufferMs: 20 });
		mixer.push('a', packet(1, 0)); // plays at 20 ms
		await settle();
		clock.advance(45);
		mixer.push('a', packet(2, 1)); // its place starts at 40 ms; the frame 40..60 is mixed at 60 ms
		clock.advance(200);
		expect(mixer.stats.latePackets).toBe(0);
		expect(ticks()).toEqual([1, 2]);
	});

	it('lateResyncPackets counts late packets in a row: an on-time one between two late ones starts the count again', async () => {
		const { clock, mixer, packet, settle } = setup({ bufferMs: 20, lateResyncPackets: 2 });
		mixer.push('a', packet(1, 0));
		await settle();
		clock.advance(70); // chunk 1 was due at 40 ms: late. Chunk 3 (due at 80 ms) is on time.
		mixer.push('a', packet(2, 1));
		mixer.push('a', packet(4, 3));
		clock.advance(200);
		expect(mixer.stats).toMatchObject({ latePackets: 1, anchorsLate: 0, concealedMs: 20 });
		mixer.push('a', packet(5, 4)); // due long ago: late, but the first late one since an on-time packet
		expect(mixer.stats).toMatchObject({ latePackets: 2, anchorsLate: 0 });
	});

	// ---- the cap, the gain, expiry ----

	it('ranks for the cap by the decoded level when the bridge sends none, and by the level of the bridge when it does', async () => {
		const decoded = setup({ maxSpeakers: 1 });
		for (let chunk = 0; chunk < 3; chunk++) {
			decoded.mixer.push('quiet', decoded.packet(100, chunk));
			decoded.mixer.push('loud', decoded.packet(9000, chunk));
			await decoded.settle();
			decoded.clock.advance(20);
		}
		decoded.clock.advance(100);
		expect(decoded.values()).toEqual([9000, 9000, 9000]);

		// The bridge says the source with the small samples is the louder one: its word is taken.
		const stated = setup({ maxSpeakers: 1 });
		for (let chunk = 0; chunk < 3; chunk++) {
			stated.mixer.push('small', stated.packet(100, chunk, { audioLevel: 10 }));
			stated.mixer.push('large', stated.packet(9000, chunk, { audioLevel: 90 }));
			await stated.settle();
			stated.clock.advance(20);
		}
		stated.clock.advance(100);
		expect(stated.values()).toEqual([100, 100, 100]);
	});

	it('a source the cap left out of a frame does not pile up: its audio of that frame is gone', async () => {
		const { clock, mixer, packet, settle, values } = setup({ maxSpeakers: 1 });
		for (let chunk = 0; chunk < 3; chunk++) {
			mixer.push('quiet', packet(100, chunk, { audioLevel: 60 }));
			mixer.push('loud', packet(900, chunk, { audioLevel: 20 }));
			await settle();
			clock.advance(20);
		}
		for (let chunk = 3; chunk < 6; chunk++) {
			mixer.push('quiet', packet(100, chunk, { audioLevel: 60 }));
			clock.advance(20);
		}
		clock.advance(200);
		expect(values()).toEqual([900, 900, 900, 100, 100, 100]);
	});

	it('gain average: sources that start together after silence start at the new gain, with no ramp', async () => {
		const { clock, mixer, packet, settle, values } = setup({ gain: 'average' });
		mixer.push('a', packet(1000, 0));
		mixer.push('b', packet(600, 0));
		await settle();
		clock.advance(200);
		expect(values()).toEqual([800]);
	});

	it('keeps the decoder of a source that still sends, however long its pauses', async () => {
		const { clock, mixer, packet, settle, decoders } = setup();
		mixer.push('a', packet(1, 0));
		await settle();
		for (let i = 1; i <= 40; i++) {
			clock.advance(1000);
			mixer.push('a', { ...packet(1, i), timestamp: 5000 + i * 48000 });
		}
		expect(mixer.trackCount).toBe(1);
		expect(decoders).toHaveLength(1);
	});
});
