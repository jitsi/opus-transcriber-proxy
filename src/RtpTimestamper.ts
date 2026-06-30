/**
 * Generates the RTP timestamp and 16-bit RTP sequence number for an outbound
 * stream of fixed-duration (20 ms) audio frames, mapping a bursty, not-quite-
 * real-time source (the OpenAI translation output) onto a single continuous RTP
 * timeline.
 *
 * The hard requirement is **monotonicity**: the timestamp returned by
 * {@link nextFrameTimestamp} never decreases, no matter how the source delivers
 * audio. OpenAI streams a response faster than real time (a 2 s utterance can
 * arrive in ~200 ms), and successive responses are separated by real silence.
 * Naively resetting the timestamp from a wall clock at each response would let a
 * burst-ahead media position jump backwards on the next response — invalid RTP.
 *
 * The model is a **media-playout clock**: {@link playoutEndWall} tracks the
 * wall-clock instant at which the media emitted so far would finish playing.
 * Each frame advances it by one frame duration (the media's own clock), NOT by
 * how long emitting took. For each new frame we compare `now` to that playout
 * end:
 *
 *   - `now <= playoutEndWall` — the source is still ahead of (or at) real time
 *     (a burst, or steady streaming). No gap: the frame is contiguous with the
 *     previous one. This makes two OpenAI chunks arriving 1 s apart, each
 *     shorter than the audio already buffered, produce one uninterrupted stream.
 *   - `now - playoutEndWall > gapThresholdMs` — the source went idle for longer
 *     than the buffered media (a real pause between utterances). Insert that
 *     silence as a proportional jump in the RTP timestamp, so a 10 s gap between
 *     responses is reflected as ~10 s of RTP time rather than being collapsed.
 *
 * `gapThresholdMs` swallows scheduling jitter so near-real-time delivery does
 * not sprinkle the stream with tiny spurious gaps. The sequence number is an
 * independent uint16 counter that wraps, matching JVB's reinterpretation of
 * `media.chunk` as a 16-bit RTP sequence number.
 */
export const RTP_CLOCK_RATE = 48000;
export const FRAME_DURATION_MS = 20;

export interface RtpTimestamperOptions {
	/** RTP clock rate in Hz. Default 48000 (the rate JVB expects on the return path). */
	clockRate?: number;
	/** Media frame duration in ms. Default 20. */
	frameDurationMs?: number;
	/**
	 * Minimum idle (ms past the buffered media) before a silence gap is inserted.
	 * Below this, delivery jitter is treated as contiguous. Default 100.
	 */
	gapThresholdMs?: number;
	/** Injectable wall clock (ms). Defaults to Date.now. Override in tests. */
	now?: () => number;
}

export interface RtpFrameTiming {
	/** Monotonically non-decreasing RTP timestamp (in clockRate ticks). */
	timestamp: number;
	/** uint16 RTP sequence number (wraps at 0xffff). */
	sequenceNumber: number;
}

export class RtpTimestamper {
	private readonly clockRate: number;
	private readonly frameDurationMs: number;
	private readonly samplesPerFrame: number;
	private readonly gapThresholdMs: number;
	private readonly now: () => number;

	private nextTimestamp = 0;
	private sequenceNumber = -1;
	/** Wall-clock instant at which the media emitted so far finishes playing. */
	private playoutEndWall: number | undefined = undefined;

	constructor(options: RtpTimestamperOptions = {}) {
		this.clockRate = options.clockRate ?? RTP_CLOCK_RATE;
		this.frameDurationMs = options.frameDurationMs ?? FRAME_DURATION_MS;
		this.samplesPerFrame = Math.round((this.clockRate / 1000) * this.frameDurationMs);
		this.gapThresholdMs = options.gapThresholdMs ?? 100;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Compute the RTP timing for the next 20 ms frame. Inserts a silence gap when
	 * the source idled longer than the audio already buffered for playout, and is
	 * guaranteed monotonic in the timestamp.
	 */
	nextFrameTimestamp(): RtpFrameTiming {
		const now = this.now();
		if (this.playoutEndWall === undefined) {
			this.playoutEndWall = now;
		}

		const idleMs = now - this.playoutEndWall;
		if (idleMs > this.gapThresholdMs) {
			// Source was silent longer than the buffered media — advance the RTP
			// timeline by the real gap and re-anchor playout to now.
			this.nextTimestamp += Math.round((idleMs / 1000) * this.clockRate);
			this.playoutEndWall = now;
		}

		const timestamp = this.nextTimestamp;
		this.nextTimestamp += this.samplesPerFrame;
		this.playoutEndWall += this.frameDurationMs;

		this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
		return { timestamp, sequenceNumber: this.sequenceNumber };
	}
}
