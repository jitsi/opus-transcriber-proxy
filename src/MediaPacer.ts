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
 * Paces synthetic audio to ~real time before it is sent to the bridge.
 *
 * A voice-agent backend or a speech-to-speech translator streams its output faster than real time
 * (a 10 s agent answer can arrive in under a second; xAI's realtime translation delivers each
 * translated phrase, up to several seconds of audio, in one burst of a few hundred milliseconds).
 * The bridge injects whatever it receives immediately, and injected RTP cannot be un-sent. Two
 * things go wrong when a whole burst is forwarded at once: a barge-in `clear` on the agent path
 * could never cut the bot off, and a WebRTC client's jitter buffer (NetEQ, 200 packets = 4 s by
 * default) overflows and flushes, so the listener hears only part of the burst while the
 * transcript, which travels over signalling, arrives complete. The pacer holds encoded frames in
 * a queue and releases one 20 ms frame per 20 ms of wall-clock time, allowing at most `leadMs`
 * of media to be in flight ahead of real time (a small cushion against scheduler jitter). The lead
 * is never less than one frame: with less, no frame could ever fit the budget and nothing would be
 * released.
 * `clear()` drops everything still queued — only the ≤ `leadMs` already released can still play
 * out downstream.
 *
 * `mark(name)` enqueues a playback checkpoint behind the audio queued so far; `onMark` fires when
 * the queue drains past it (approximately when that audio has been *sent*, not when remote
 * clients have played it — the proxy has no playout feedback). A `clear()` flushes queued marks
 * through `onMark` immediately, so an agent always gets an answer for every mark it sent.
 *
 * A throw from `onFrame` or `onMark` is reported to `onError` and the release goes on with the
 * next item: the pacer's timer callback has no caller to catch it, and one bad frame must not
 * strand the rest of the queue (nor, at close, abort the owner's teardown). Without an `onError`
 * the throw propagates as it would from any callback.
 *
 * Used by `AgentProxy` (the agent's return path) and `TranslatorConnection` (translated audio).
 * Pure and clock/timer-injectable for tests; no I/O, no Node imports (it is part of the
 * Worker-safe translation core, see scripts/check-worker-safe.mjs). The default timers are
 * unref'd, so queued audio never keeps a process alive that has nothing else to do: an owner that
 * wants a queue played out before exit must keep the process alive itself.
 */

import { unrefTimer } from './translate/timers';

export interface MediaPacerOptions<F> {
	/** A frame is due to be sent to the bridge. The pacer's one output. */
	onFrame: (frame: F) => void;
	/**
	 * How much media (ms) may be released ahead of real time. Default 200. Raised to one frame
	 * (`frameDurationMs`) when smaller, see the class doc.
	 */
	leadMs?: number;
	/**
	 * The most frames the queue may hold. When a push finds it full, the OLDEST queued frames are
	 * dropped to make room (the newest audio is the one still worth playing) and `onOverflow` is
	 * told how many went. Unset: unbounded, the owner caps it itself (the agent path drops the
	 * newest instead, see `AgentProxy.pushAgentFrame`).
	 */
	maxQueuedFrames?: number;
	/**
	 * How many frames an overflow drops at once, default 1. Dropping one frame per push, with a
	 * burst of pushes arriving into a full queue, punches a 20 ms hole into the audio about to play
	 * for every frame appended, which is heard as a bad connection; dropping a block of a few
	 * seconds loses the same audio as one clean skip. At most `maxQueuedFrames`.
	 */
	overflowDropFrames?: number;
	/** Media frame duration in ms. Default 20. */
	frameDurationMs?: number;
	/** Injectable wall clock (ms). Defaults to Date.now. */
	now?: () => number;
	/** Injectable timer, defaults to setTimeout/clearTimeout. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

type QueueItem<F> = { kind: 'frame'; frame: F } | { kind: 'mark'; name: string };

/**
 * `F` is whatever the owner queues per 20 ms frame; the pacer only counts and releases them.
 */
export class MediaPacer<F> {
	private readonly leadMs: number;
	private readonly frameDurationMs: number;
	private readonly maxQueuedFrames: number | undefined;
	private readonly overflowDropFrames: number;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly onFrame: (frame: F) => void;

	private queue: QueueItem<F>[] = [];
	/** Frames in `queue` (marks excluded), kept so `queuedFrames` is O(1) on a queue the owner checks per push. */
	private frameCount = 0;
	private timerHandle: unknown = undefined;
	/** Wall-clock instant at which the media released so far finishes playing (the playout clock). */
	private playoutEndWall: number | undefined = undefined;
	private closed = false;

	/** The queue drained past a mark (or a clear() flushed it). */
	onMark?: (name: string) => void;
	/** `maxQueuedFrames` was hit: this many of the oldest queued frames were dropped to make room. */
	onOverflow?: (dropped: number) => void;
	/** `onFrame` or `onMark` threw; the release continues with the next item. Unset: the throw propagates. */
	onError?: (error: unknown) => void;

	constructor(options: MediaPacerOptions<F>) {
		this.onFrame = options.onFrame;
		this.frameDurationMs = options.frameDurationMs ?? 20;
		if (!(this.frameDurationMs > 0)) {
			throw new RangeError(`MediaPacer: frameDurationMs must be positive, got ${options.frameDurationMs}`);
		}
		const leadMs = options.leadMs ?? 200;
		if (!(leadMs >= 0)) {
			throw new RangeError(`MediaPacer: leadMs must be a non-negative number, got ${options.leadMs}`);
		}
		this.leadMs = Math.max(leadMs, this.frameDurationMs);
		this.maxQueuedFrames = options.maxQueuedFrames;
		if (this.maxQueuedFrames !== undefined && !(this.maxQueuedFrames >= 1)) {
			throw new RangeError(`MediaPacer: maxQueuedFrames must be at least 1, got ${options.maxQueuedFrames}`);
		}
		this.overflowDropFrames = options.overflowDropFrames ?? 1;
		if (!(this.overflowDropFrames >= 1) || (this.maxQueuedFrames !== undefined && this.overflowDropFrames > this.maxQueuedFrames)) {
			throw new RangeError(
				`MediaPacer: overflowDropFrames must be between 1 and maxQueuedFrames, got ${options.overflowDropFrames}`,
			);
		}
		this.now = options.now ?? Date.now;
		// The default timers are unref'd: queued audio must not keep a shutting-down process alive.
		this.setTimer =
			options.setTimer ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				unrefTimer(t);
				return t;
			});
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	/** Enqueue one encoded 20 ms frame. Ignored after close(). */
	push(frame: F): void {
		if (this.closed) return;
		if (this.maxQueuedFrames !== undefined && this.frameCount >= this.maxQueuedFrames) {
			// Drop the oldest frames (marks between them stay queued and fire in order) down to the block
			// below the cap, so the next pushes of the same burst find room instead of each evicting one frame.
			const keep = this.maxQueuedFrames - this.overflowDropFrames;
			let dropped = 0;
			for (let i = 0; i < this.queue.length && this.frameCount > keep; ) {
				if (this.queue[i].kind === 'frame') {
					this.queue.splice(i, 1);
					this.frameCount--;
					dropped++;
				} else {
					i++;
				}
			}
			this.onOverflow?.(dropped);
		}
		this.queue.push({ kind: 'frame', frame });
		this.frameCount++;
		this.drain();
	}

	/** Enqueue a playback checkpoint behind the audio queued so far. Ignored after close(). */
	mark(name: string): void {
		if (this.closed) return;
		this.queue.push({ kind: 'mark', name });
		this.drain();
	}

	/**
	 * Barge-in: drop all queued frames. Queued marks are flushed through onMark (the audio they
	 * trailed is gone, so they are "reached" by definition). Returns the number of frames dropped.
	 */
	clear(): number {
		if (this.closed) return 0;
		const dropped = this.queue;
		this.queue = [];
		this.frameCount = 0;
		this.stopTimer();
		// The playout clock keeps its value: audio already released is still playing out downstream,
		// and the next push paces against that same timeline.
		let frames = 0;
		for (const item of dropped) {
			if (item.kind === 'mark') {
				this.release(item);
			} else {
				frames++;
			}
		}
		return frames;
	}

	/** The number of frames currently queued (not yet released). */
	get queuedFrames(): number {
		return this.frameCount;
	}

	/**
	 * Release what is queued right now, in order, through `onFrame` / `onMark`, ignoring the lead: the
	 * owner is going away and would otherwise lose the audio (the translator's direction closing mid-phrase).
	 * At most `maxFrames` frames go out, the oldest first (the audio nearest to playing); the rest are dropped,
	 * since a burst longer than the client's jitter buffer would be flushed by the client anyway. Marks all
	 * fire. The playout clock advances by the frames released, so a later push paces against it (a property
	 * of the pacer; the owners that call this close right after). Returns the number of frames released; the
	 * caller knows how many were dropped from `queuedFrames` before the call.
	 */
	flush(maxFrames = Infinity): number {
		if (this.closed) return 0;
		this.stopTimer();
		const items = this.queue;
		this.queue = [];
		this.frameCount = 0;
		const now = this.now();
		if (this.playoutEndWall === undefined || this.playoutEndWall < now) {
			this.playoutEndWall = now;
		}
		let released = 0;
		for (const item of items) {
			if (item.kind === 'frame') {
				if (released >= maxFrames) continue;
				released++;
				this.playoutEndWall += this.frameDurationMs;
			}
			this.release(item);
		}
		return released;
	}

	/** Stop the timer and drop state. Queued marks are NOT flushed (the session is going away). */
	close(): void {
		this.closed = true;
		this.queue = [];
		this.frameCount = 0;
		this.stopTimer();
	}

	private stopTimer(): void {
		if (this.timerHandle !== undefined) {
			this.clearTimer(this.timerHandle);
			this.timerHandle = undefined;
		}
	}

	/** Hand one item to the owner; a throw is reported, not propagated, when `onError` is set. */
	private release(item: QueueItem<F>): void {
		try {
			if (item.kind === 'mark') {
				this.onMark?.(item.name);
			} else {
				this.onFrame(item.frame);
			}
		} catch (error) {
			if (this.onError === undefined) throw error;
			this.onError(error);
		}
	}

	private drain(): void {
		if (this.timerHandle !== undefined) {
			// A timer is already scheduled; it will re-enter drain when it fires.
			return;
		}
		const now = this.now();
		if (this.playoutEndWall === undefined || this.playoutEndWall < now) {
			// Fresh stream, or the previous audio finished playing while the queue was empty.
			this.playoutEndWall = now;
		}

		while (this.queue.length > 0) {
			const item = this.queue[0];
			if (item.kind === 'mark') {
				this.queue.shift();
				this.release(item);
				continue;
			}
			const aheadMs = this.playoutEndWall - now;
			if (aheadMs + this.frameDurationMs > this.leadMs) {
				// Releasing this frame would exceed the lead budget: wait until enough media has played out.
				const waitMs = aheadMs + this.frameDurationMs - this.leadMs;
				this.timerHandle = this.setTimer(() => {
					this.timerHandle = undefined;
					this.drain();
				}, waitMs);
				return;
			}
			this.queue.shift();
			this.frameCount--;
			this.playoutEndWall += this.frameDurationMs;
			this.release(item);
		}
	}
}
