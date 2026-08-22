/**
 * Paces the agent's return audio to ~real time before it is sent to the bridge.
 *
 * A voice-agent backend streams a response faster than real time (a 10 s answer can arrive in
 * under a second). The bridge injects whatever it receives immediately, and injected RTP cannot
 * be un-sent — so if the whole burst were forwarded at once, a barge-in `clear` could never cut
 * the bot off. The pacer holds encoded frames in a queue and releases one 20 ms frame per 20 ms
 * of wall-clock time, allowing at most `leadMs` of media to be in flight ahead of real time (a
 * small cushion against scheduler jitter). `clear()` drops everything still queued — only the
 * ≤ `leadMs` already released can still play out downstream.
 *
 * `mark(name)` enqueues a playback checkpoint behind the audio queued so far; `onMark` fires when
 * the queue drains past it (approximately when that audio has been *sent*, not when remote
 * clients have played it — the proxy has no playout feedback). A `clear()` flushes queued marks
 * through `onMark` immediately, so the customer always gets an answer for every mark it sent.
 *
 * Pure and clock/timer-injectable for tests; no I/O.
 */

export interface AgentPacerOptions {
	/** How much media (ms) may be released ahead of real time. Default 200. */
	leadMs?: number;
	/** Media frame duration in ms. Default 20. */
	frameDurationMs?: number;
	/** Injectable wall clock (ms). Defaults to Date.now. */
	now?: () => number;
	/** Injectable timer, defaults to setTimeout/clearTimeout. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

type QueueItem = { kind: 'frame'; payload: Uint8Array } | { kind: 'mark'; name: string };

export class AgentPacer {
	private readonly leadMs: number;
	private readonly frameDurationMs: number;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	private queue: QueueItem[] = [];
	private timerHandle: unknown = undefined;
	/** Wall-clock instant at which the media released so far finishes playing (the playout clock). */
	private playoutEndWall: number | undefined = undefined;
	private closed = false;

	/** A frame is due to be sent to the bridge. */
	onFrame?: (payload: Uint8Array) => void;
	/** The queue drained past a mark (or a clear() flushed it). */
	onMark?: (name: string) => void;

	constructor(options: AgentPacerOptions = {}) {
		this.leadMs = options.leadMs ?? 200;
		this.frameDurationMs = options.frameDurationMs ?? 20;
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	/** Enqueue one encoded 20 ms frame. */
	push(payload: Uint8Array): void {
		if (this.closed) return;
		this.queue.push({ kind: 'frame', payload });
		this.drain();
	}

	/** Enqueue a playback checkpoint behind the audio queued so far. */
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
		const dropped = this.queue;
		this.queue = [];
		if (this.timerHandle !== undefined) {
			this.clearTimer(this.timerHandle);
			this.timerHandle = undefined;
		}
		// The playout clock keeps its value: audio already released is still playing out downstream,
		// and the next push paces against that same timeline.
		let frames = 0;
		for (const item of dropped) {
			if (item.kind === 'mark') {
				this.onMark?.(item.name);
			} else {
				frames++;
			}
		}
		return frames;
	}

	/** The number of frames currently queued (not yet released). */
	get queuedFrames(): number {
		return this.queue.reduce((n, item) => (item.kind === 'frame' ? n + 1 : n), 0);
	}

	/** Stop the timer and drop state. Queued marks are NOT flushed (the session is going away). */
	close(): void {
		this.closed = true;
		this.queue = [];
		if (this.timerHandle !== undefined) {
			this.clearTimer(this.timerHandle);
			this.timerHandle = undefined;
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
				this.onMark?.(item.name);
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
			this.playoutEndWall += this.frameDurationMs;
			this.onFrame?.(item.payload);
		}
	}
}
