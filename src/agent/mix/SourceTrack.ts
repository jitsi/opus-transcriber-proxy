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

import { computeAudioLevel } from '../../OpusEncoder/audioLevel';
import type { IOpusDecoder } from '../../OpusDecoder/opusTypes';
import type { Logger } from '../../translate/runtime';
import type { MixConfig } from '../mixConfig';

/** The mixer's sample rate: what the agent leg speaks, and what the decoders are opened at. */
export const MIX_SAMPLE_RATE = 24000;
export const MIX_SAMPLES_PER_MS = MIX_SAMPLE_RATE / 1000;
/** The bridge's `timestamp` is on the 48 kHz RTP clock: two ticks per mixer sample. */
const RTP_TICKS_PER_SAMPLE = 2;
/** Packets held while the decoder initialises (WASM instantiation is asynchronous). */
const MAX_PENDING_PACKETS = 50;
/** A `chunk` this far below the last one is a restarted stream, not an old packet. */
const CHUNK_RESTART_DISTANCE = 1000;
/** This many packets in a row that all look old are a restarted stream too, not stragglers. */
const OLD_PACKETS_FOR_RESTART = 10;
/** The span the cap's ranking averages a source's level over (ms). */
const LEVEL_WINDOW_MS = 200;
/** A source's repeated decode failures are said again at most this often (ms). */
const DECODE_WARN_INTERVAL_MS = 5000;

/** One bridge `media` packet of a source. `chunk`, `timestamp` and `audioLevel` are whole numbers or absent. */
export interface MixPacket {
	frame: Uint8Array;
	/**
	 * The bridge's per-source packet index (the extended RTP sequence number). A gap is a packet the bridge did
	 * not forward: one that was lost on the way to it, or one it dropped itself (a source outside the loudest).
	 */
	chunk?: number;
	/** The packet's RTP timestamp (48 kHz). */
	timestamp?: number;
	/** RFC 6464 level (0 loudest, 127 silence), when the bridge sent one. */
	audioLevel?: number;
}

/** Where the mixer is on its timeline: positions are samples at [MIX_SAMPLE_RATE]. */
export interface MixTimeline {
	/** Wall clock (ms). */
	nowMs(): number;
	/** The position real time is at. */
	nowPos(): number;
	/** The start of the next frame to be mixed; audio before it can no longer be played. */
	playhead(): number;
}

/** Counted by the tracks and the mixer; logged when the session ends and added to the metrics as it runs. */
export interface MixStats {
	/** Packets the bridge sent for the mix. */
	packets: number;
	/** Packets whose place had started to be mixed when they arrived; with `lateResyncPackets` 1 they play all the same. */
	latePackets: number;
	/** Packets dropped because the source's decoder was still initialising and its queue was full. */
	pendingDropped: number;
	/** Packets discarded because their `chunk` was not above the last one. */
	outOfOrderPackets: number;
	/** Packets that did not decode. */
	decodeErrors: number;
	/** Sources whose decoder failed to initialise. */
	decoderFailures: number;
	/** Gaps filled by the decoder (FEC or loss concealment), and how much audio that was. */
	concealments: number;
	concealedMs: number;
	/** Gaps the decoder was asked to fill and could not. */
	concealFailures: number;
	/** Anchors set: at the start of a talk, for a late packet, and for a queue past `maxBufferMs`. */
	anchorsTalk: number;
	anchorsLate: number;
	anchorsDeep: number;
	/** Queued audio that was never played, to bring a source back to its buffer depth (ms). */
	skippedMs: number;
	/** Frames sent to the agent; of those, the ones the limiter changed and the ones the cap left a source out of. */
	framesSent: number;
	framesLimited: number;
	framesCapped: number;
	/** Frames that failed to mix or to be delivered. */
	framesFailed: number;
	/** Ticks not mixed because the clock had stalled past the catch-up limit. */
	ticksSkipped: number;
	/** The most sources summed in one frame. */
	maxSources: number;
}

export function newMixStats(): MixStats {
	return {
		packets: 0,
		latePackets: 0,
		pendingDropped: 0,
		outOfOrderPackets: 0,
		decodeErrors: 0,
		decoderFailures: 0,
		concealments: 0,
		concealedMs: 0,
		concealFailures: 0,
		anchorsTalk: 0,
		anchorsLate: 0,
		anchorsDeep: 0,
		skippedMs: 0,
		framesSent: 0,
		framesLimited: 0,
		framesCapped: 0,
		framesFailed: 0,
		ticksSkipped: 0,
		maxSources: 0,
	};
}

/** What a track gets from the mixer it belongs to. */
export interface TrackHost {
	readonly config: Readonly<MixConfig>;
	readonly timeline: MixTimeline;
	readonly stats: MixStats;
	readonly logger: Logger;
	/** The track's decoder is ready, or failed to initialise. */
	decoderReady(): void;
	decoderFailed(): void;
	/** Media of the track was dropped for a reason an operator counts (`agent_media_dropped`). */
	mediaDropped(reason: string): void;
}

interface Segment {
	/** Position of the first sample. */
	pos: number;
	pcm: Int16Array;
}

/** What waits for the decoder: a packet with where real time was when it arrived, or a restart of the numbering. */
type Pending = { packet: MixPacket; arrivedPos: number } | 'restart';

function toPcm16(bytes: Uint8Array): Int16Array {
	const length = bytes.byteLength & ~1;
	// A copy: the decoder may reuse its buffer, and a view needs an even offset.
	return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length));
}

/**
 * One participant source in the mix: its Opus decoder, and its decoded audio placed on the mixer's timeline.
 *
 * A packet is decoded as it arrives (unless it is old, or the decoder is not ready), so the decoder stays warm.
 * Where its audio goes is decided by its RTP timestamp, relative to an anchor ("this timestamp plays `bufferMs`
 * from now") set at the start of each talk: the order of the packets and the spacing between them come from the
 * sender's clock, not from when they arrive, so arrival jitter of up to `bufferMs` does not reach the output.
 *
 * The anchor moves in three cases:
 *  - A new talk (an RTP gap above `talkGapMs`). The bridge stops forwarding a silent source after a few packets,
 *    so a pause of that length is one, and it is what takes out clock drift and the delay the talk before it
 *    picked up (as far as that talk's audio has played out).
 *  - A late packet (its place has started to be mixed). With the default `lateResyncPackets` of 1 it is not
 *    dropped: it plays now and the rest of the talk follows it, so a delay spike costs a pause in that speaker's
 *    audio rather than a hole. The source's delay is then the worst delay of the talk so far, until the talk ends.
 *  - Audio queued further ahead than `maxBufferMs` (a delay spike or a burst longer than that, or a sender clock
 *    that runs fast): the source moves earlier, just enough to be one buffer deep again, and the queued audio
 *    that this puts before the playhead is never played.
 *
 * Its segments are in the order of their positions and never overlap.
 */
export class SourceTrack {
	readonly tag: string;
	private readonly host: TrackHost;
	private readonly decoder: IOpusDecoder<typeof MIX_SAMPLE_RATE>;
	private decoderStatus: 'pending' | 'ready' | 'failed' | 'freed' = 'pending';
	private pending: Pending[] = [];

	private segments: Segment[] = [];
	private anchorTimestamp?: number;
	private anchorPos = 0;
	/** The end of the last audio this source produced (placed or not): where the next packet's gap is measured from. */
	private lastEnd?: number;
	private lastChunk?: number;
	private consecutiveOld = 0;
	private consecutiveLate = 0;
	private levels: Array<{ atMs: number; energy: number }> = [];
	/** Wall clock of the last packet, for expiry. */
	private lastPacketMs: number;
	/** The end of the last audio actually placed on the timeline. */
	private placedEnd?: number;

	private warnedFailed = false;
	private warnedPendingFull = false;
	private warnedNoNumbering = false;
	private warnedRestart = false;
	private decodeWarnedAtMs?: number;
	private decodeErrorsUnreported = 0;

	constructor(tag: string, host: TrackHost, decoder: IOpusDecoder<typeof MIX_SAMPLE_RATE>) {
		this.tag = tag;
		this.host = host;
		this.decoder = decoder;
		this.lastPacketMs = host.timeline.nowMs();
		// Two handlers, not a catch after the first: only a decoder that did not initialise is a failed decoder.
		decoder.ready.then(
			() => this.onDecoderReady(),
			(error: unknown) => this.onDecoderFailed(error),
		);
	}

	private onDecoderReady(): void {
		if (this.decoderStatus === 'freed') {
			// free() before ready is a no-op, so free() could not release it.
			this.decoder.free();
			return;
		}
		this.decoderStatus = 'ready';
		this.host.decoderReady();
		const queued = this.pending;
		this.pending = [];
		for (const item of queued) {
			if (item === 'restart') {
				this.restartNow();
			} else {
				this.process(item.packet, item.arrivedPos);
			}
		}
	}

	private onDecoderFailed(error: unknown): void {
		if (this.decoderStatus === 'freed') {
			return;
		}
		this.decoderStatus = 'failed';
		this.pending = [];
		this.host.stats.decoderFailures++;
		this.host.logger.error(`agent: mix: failed to initialise the decoder for tag ${this.tag}:`, error);
		this.host.decoderFailed();
	}

	push(packet: MixPacket): void {
		if (this.decoderStatus === 'freed') {
			return;
		}
		this.lastPacketMs = this.host.timeline.nowMs();
		this.host.stats.packets++;
		if (this.decoderStatus === 'ready') {
			this.process(packet, this.host.timeline.nowPos());
		} else if (this.decoderStatus === 'pending') {
			if (this.pending.length < MAX_PENDING_PACKETS) {
				this.pending.push({ packet, arrivedPos: this.host.timeline.nowPos() });
				return;
			}
			this.host.stats.pendingDropped++;
			if (!this.warnedPendingFull) {
				this.warnedPendingFull = true;
				this.host.logger.warn(
					`agent: mix: dropping media for tag ${this.tag} while its decoder initialises (${MAX_PENDING_PACKETS} packets queued)`,
				);
				this.host.mediaDropped('decoder_pending');
			}
		} else if (!this.warnedFailed) {
			this.warnedFailed = true;
			this.host.logger.warn(`agent: mix: dropping media for tag ${this.tag}: its decoder failed to initialise`);
			this.host.mediaDropped('decoder_failed');
		}
	}

	/**
	 * The bridge announced the source again (`start`): a new stream under the same name, whose `chunk` numbering
	 * starts over and may begin below the old one. Takes effect in the order it arrived, also behind packets that
	 * still wait for the decoder.
	 */
	restart(): void {
		if (this.decoderStatus === 'pending') {
			this.pending.push('restart');
		} else if (this.decoderStatus === 'ready') {
			this.restartNow();
		}
	}

	private restartNow(): void {
		this.lastChunk = undefined;
		this.consecutiveOld = 0;
		// The next packet starts a talk: nothing ties the new stream's timestamps to the old anchor.
		this.anchorTimestamp = undefined;
		this.lastEnd = undefined;
		this.consecutiveLate = 0;
		try {
			this.decoder.reset();
		} catch (error) {
			this.host.logger.debug(`agent: mix: failed to reset the decoder for tag ${this.tag}: ${String(error)}`);
		}
	}

	/**
	 * `arrivedPos` is where real time was when the packet arrived, which is earlier than now for one that waited
	 * for the decoder. It only places the start of a talk: a short wait for the decoder then costs no delay.
	 */
	private process(packet: MixPacket, arrivedPos: number): void {
		const { config, timeline, stats, logger } = this.host;
		const chunk = packet.chunk;
		const timestamp = packet.timestamp;
		if ((chunk === undefined || timestamp === undefined) && !this.warnedNoNumbering) {
			this.warnedNoNumbering = true;
			logger.warn(
				`agent: mix: media for tag ${this.tag} has no usable ${chunk === undefined ? 'chunk' : 'timestamp'}; ` +
					'placing it by arrival, without loss detection',
			);
		}
		let lost = 0;
		if (chunk !== undefined && this.lastChunk !== undefined) {
			const delta = chunk - this.lastChunk;
			if (delta <= 0 && delta > -CHUNK_RESTART_DISTANCE) {
				if (++this.consecutiveOld <= OLD_PACKETS_FOR_RESTART) {
					// Old or repeated: decoding it now would corrupt the decoder's state for the packets after it.
					stats.outOfOrderPackets++;
					return;
				}
				// A whole run of them is a stream whose numbering started again with no `start` to say so.
				if (!this.warnedRestart) {
					this.warnedRestart = true;
					logger.warn(`agent: mix: the chunk numbering started again for tag ${this.tag} without a start event`);
				}
				this.restartNow();
			} else {
				lost = delta > 0 ? delta - 1 : 0;
			}
		}
		this.consecutiveOld = 0;
		if (chunk !== undefined) {
			this.lastChunk = chunk;
		}

		const bufferSamples = config.bufferMs * MIX_SAMPLES_PER_MS;
		const talkGapSamples = config.talkGapMs * MIX_SAMPLES_PER_MS;

		// Where the sender's clock puts this packet, if it continues the current talk.
		let pos: number | undefined;
		if (this.lastEnd !== undefined) {
			if (timestamp !== undefined && this.anchorTimestamp !== undefined) {
				pos = this.anchorPos + Math.round((timestamp - this.anchorTimestamp) / RTP_TICKS_PER_SAMPLE);
			} else if (timestamp === undefined && this.anchorTimestamp === undefined) {
				// No timestamps at all: packets follow one another.
				pos = this.lastEnd;
			}
		}
		const gap = pos !== undefined && this.lastEnd !== undefined ? pos - this.lastEnd : undefined;
		if (pos === undefined || gap === undefined || Math.abs(gap) > talkGapSamples) {
			pos = this.setAnchor(timestamp, arrivedPos + bufferSamples);
			stats.anchorsTalk++;
			lost = 0;
		} else if (gap < 0) {
			// Overlaps what is already there by less than a talk gap: follow on rather than sum the overlap.
			pos = this.lastEnd!;
		} else if (pos - timeline.nowPos() > config.maxBufferMs * MIX_SAMPLES_PER_MS) {
			// Further ahead of real time than a source may be queued. Move the source earlier by the excess, which
			// leaves it one buffer deep; the queued audio that this puts before the playhead is never played.
			// Measured from now, not from when the packet arrived: what counts is how much is waiting to play.
			const excess = pos - (timeline.nowPos() + bufferSamples);
			const skipped = this.pullBack(excess);
			logger.debug(
				`agent: mix: ${this.tag} is ${Math.round((pos - timeline.nowPos()) / MIX_SAMPLES_PER_MS)} ms ahead; ` +
					`moved ${Math.round(excess / MIX_SAMPLES_PER_MS)} ms earlier, ${Math.round(skipped / MIX_SAMPLES_PER_MS)} ms of it never plays`,
			);
			pos -= excess;
			stats.anchorsDeep++;
			stats.skippedMs += skipped / MIX_SAMPLES_PER_MS;
		}

		// A gap in the bridge's numbering, short enough to conceal: fill it before decoding the packet that follows
		// it (libopus recovers the last missing frame from that packet's in-band FEC when it has one). The gap is a
		// packet lost on the way to the bridge, or one the bridge dropped because the source was not among the
		// loudest at that moment; the two cannot be told apart here, and both sound better filled than cut.
		const concealSamples = config.concealMs * MIX_SAMPLES_PER_MS;
		if (lost > 0 && this.lastEnd !== undefined && pos > this.lastEnd && pos - this.lastEnd <= concealSamples) {
			try {
				const concealed = this.decoder.conceal(packet.frame, pos - this.lastEnd);
				if (concealed && concealed.errors.length === 0 && concealed.audioData.length > 0) {
					const pcm = toPcm16(concealed.audioData);
					this.place(this.lastEnd, pcm);
					stats.concealments++;
					stats.concealedMs += pcm.length / MIX_SAMPLES_PER_MS;
				} else {
					stats.concealFailures++;
				}
			} catch (error) {
				stats.concealFailures++;
				logger.debug(`agent: mix: concealment failed for tag ${this.tag}: ${String(error)}`);
			}
		}

		let pcm: Int16Array;
		let level: number;
		try {
			const decoded = this.decoder.decodeFrame(packet.frame);
			if (decoded.errors.length > 0 || decoded.audioData.length === 0) {
				this.decodeFailed(decoded.errors.length > 0 ? String(decoded.errors[0]?.message ?? decoded.errors[0]) : 'no audio');
				return;
			}
			pcm = toPcm16(decoded.audioData);
			level = packet.audioLevel ?? computeAudioLevel(decoded.audioData);
		} catch (error) {
			this.decodeFailed(error instanceof Error ? error.message : String(error));
			return;
		}
		this.levels.push({ atMs: this.lastPacketMs, energy: Math.max(0, 127 - level) });
		if (this.levels.length > 32) {
			this.levels.shift();
		}

		if (pos < timeline.playhead()) {
			// Its place has started to be mixed without it. Decoded all the same, to keep the decoder's state.
			stats.latePackets++;
			if (++this.consecutiveLate < config.lateResyncPackets) {
				this.lastEnd = pos + pcm.length;
				return;
			}
			// Plays now, with no buffer added: that it is late shows how much delay this talk needs, and adding the
			// buffer on top at every late packet would ratchet the source's delay up. (Now, not when it arrived:
			// a packet that waited for the decoder is late all the same.)
			const lateBy = Math.round((timeline.playhead() - pos) / MIX_SAMPLES_PER_MS);
			pos = this.setAnchor(timestamp, timeline.nowPos());
			logger.debug(`agent: mix: ${this.tag} is ${lateBy} ms late; its talk continues from now`);
			stats.anchorsLate++;
		}
		this.consecutiveLate = 0;
		this.place(pos, pcm);
	}

	/** A packet that does not decode: counted every time, said the first time and then at most every few seconds. */
	private decodeFailed(reason: string): void {
		const { stats, logger, timeline } = this.host;
		stats.decodeErrors++;
		this.decodeErrorsUnreported++;
		const now = timeline.nowMs();
		if (this.decodeWarnedAtMs !== undefined && now - this.decodeWarnedAtMs < DECODE_WARN_INTERVAL_MS) {
			return;
		}
		const count = this.decodeErrorsUnreported > 1 ? ` (${this.decodeErrorsUnreported} packets since the last report)` : '';
		logger.warn(`agent: mix: failed to decode media for tag ${this.tag}: ${reason}${count}`);
		this.decodeWarnedAtMs = now;
		this.decodeErrorsUnreported = 0;
	}

	/** Sets the anchor: this timestamp plays at `target`, and never before audio already placed or already mixed. */
	private setAnchor(timestamp: number | undefined, target: number): number {
		const lastSegment = this.segments[this.segments.length - 1];
		const queuedEnd = lastSegment !== undefined ? lastSegment.pos + lastSegment.pcm.length : -Infinity;
		this.anchorPos = Math.max(target, this.host.timeline.playhead(), queuedEnd);
		this.anchorTimestamp = timestamp;
		this.consecutiveLate = 0;
		return this.anchorPos;
	}

	/**
	 * Moves the source's queued audio, and its anchor, `samples` earlier. Returns how much of that audio is now
	 * before the playhead, and so will never play (in samples).
	 */
	private pullBack(samples: number): number {
		const playhead = this.host.timeline.playhead();
		let skipped = 0;
		for (const segment of this.segments) {
			segment.pos -= samples;
			skipped += Math.max(0, Math.min(segment.pos + segment.pcm.length, playhead) - segment.pos);
		}
		this.segments = this.segments.filter((segment) => segment.pos + segment.pcm.length > playhead);
		this.anchorPos -= samples;
		if (this.lastEnd !== undefined) {
			this.lastEnd -= samples;
		}
		if (this.placedEnd !== undefined) {
			this.placedEnd -= samples;
		}
		return skipped;
	}

	private place(pos: number, pcm: Int16Array): void {
		this.segments.push({ pos, pcm });
		this.lastEnd = pos + pcm.length;
		this.placedEnd = this.lastEnd;
	}

	/** Whether the source has audio anywhere in [fromPos, toPos). */
	hasAudioIn(fromPos: number, toPos: number): boolean {
		for (const segment of this.segments) {
			if (segment.pos < toPos && segment.pos + segment.pcm.length > fromPos) {
				return true;
			}
		}
		return false;
	}

	/** Adds the source's audio in [fromPos, fromPos + sum.length) to `sum`. */
	addTo(sum: Float64Array, fromPos: number): void {
		const toPos = fromPos + sum.length;
		for (const segment of this.segments) {
			const start = Math.max(segment.pos, fromPos);
			const end = Math.min(segment.pos + segment.pcm.length, toPos);
			for (let p = start; p < end; p++) {
				sum[p - fromPos] += segment.pcm[p - segment.pos];
			}
		}
	}

	/** Forgets the audio before `playhead`: it has been mixed, or its time has passed. */
	prune(playhead: number): void {
		if (this.segments.length > 0 && this.segments[0].pos + this.segments[0].pcm.length <= playhead) {
			this.segments = this.segments.filter((segment) => segment.pos + segment.pcm.length > playhead);
		}
	}

	/** The source's recent loudness (0 silent to 127 loudest), for the cap's ranking. */
	recentEnergy(): number {
		const since = this.host.timeline.nowMs() - LEVEL_WINDOW_MS;
		let total = 0;
		let count = 0;
		for (const sample of this.levels) {
			if (sample.atMs >= since) {
				total += sample.energy;
				count++;
			}
		}
		return count > 0 ? total / count : 0;
	}

	/**
	 * Whether the source is in a talk at `playhead`: it has audio queued, or its audio ended less than
	 * `talkGapSamples` ago. A pause between words is then not the end of a talk.
	 */
	inTalkAt(playhead: number, talkGapSamples: number): boolean {
		return this.placedEnd !== undefined && playhead - this.placedEnd < talkGapSamples;
	}

	/** Whether the source has sent nothing for `expiryMs` and has nothing left to play or to decode. */
	isIdle(nowMs: number, expiryMs: number): boolean {
		return nowMs - this.lastPacketMs > expiryMs && this.segments.length === 0 && this.pending.length === 0;
	}

	get isReady(): boolean {
		return this.decoderStatus === 'ready';
	}

	free(): void {
		if (this.decoderStatus === 'freed') {
			return;
		}
		const wasPending = this.decoderStatus === 'pending';
		this.decoderStatus = 'freed';
		this.segments = [];
		this.pending = [];
		if (!wasPending) {
			// A decoder still initialising is released when it becomes ready (onDecoderReady).
			this.decoder.free();
		}
	}
}
