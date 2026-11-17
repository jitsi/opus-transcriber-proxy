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

import type { IOpusDecoder } from '../../OpusDecoder/opusTypes';
import type { Logger } from '../../translate/runtime';
import { unrefTimer } from '../../translate/timers';
import { MixConfig, normalizeMixConfig } from '../mixConfig';
import { applyGainRamp, kneeFromDb, limitToPcm16, mixGain } from './limiter';
import { MIX_SAMPLES_PER_MS, MIX_SAMPLE_RATE, MixPacket, MixStats, MixTimeline, newMixStats, SourceTrack, TrackHost } from './SourceTrack';

/**
 * A source with no packet for this long, and nothing left to play, gives up its decoder (ms). Long enough that
 * someone who stops talking for a while keeps theirs: a new decoder has to initialise, which holds up the first
 * packets of the next talk. Looked for every [EXPIRY_SWEEP_TICKS], so it can take that much longer.
 */
const TRACK_EXPIRY_MS = 30_000;
const EXPIRY_SWEEP_TICKS = 250;
/**
 * Ticks run in one go when the timer fires late. A clock further behind than this (500 ms at the default
 * `frameMs`) skips ahead instead: the process stalled, and a burst of stale frames would help nobody.
 */
const MAX_CATCH_UP_TICKS = 25;
/** RTP ticks (48 kHz) per millisecond, for the timestamp of a mixed frame. */
const RTP_TICKS_PER_MS = 48;
/** The counts since the last report are handed to `onStats` this often (ms), and once more by the owner at the end. */
const STATS_INTERVAL_MS = 30_000;
/** A frame that fails is said the first time, then at most this often (ms). */
const FRAME_ERROR_LOG_INTERVAL_MS = 5000;
/** This many frames failing in a row end the session: it sends nothing, and looks alive. */
const FAILED_FRAMES_FATAL = 50;
/** This many decoders failing to initialise, with none working, end the session likewise. */
const DECODER_FAILURES_FATAL = 3;

export interface AgentMixerOptions {
	config: Readonly<MixConfig>;
	createDecoder: () => IOpusDecoder<typeof MIX_SAMPLE_RATE>;
	logger: Logger;
	/** One mixed frame: PCM16 mono at [MIX_SAMPLE_RATE], and its start on the mixer's 48 kHz timeline. */
	onFrame: (pcm: Uint8Array, rtpTimestamp: number) => void;
	/** The set of sources in a talk changed (sorted tags). */
	onMixedChange?: (tags: string[]) => void;
	/** The counts since the last call (see [AgentMixer.takeStatsDelta]), every [STATS_INTERVAL_MS]. */
	onStats?: (delta: MixStats) => void;
	/** Media was dropped, or a decoder failed, in a way the per-source path counts too (`agent_media_dropped`, `agent_decoder_failure`). */
	onMetric?: (name: 'agent_media_dropped' | 'agent_decoder_failure', errorType?: string) => void;
	/** The mix cannot work (frames keep failing, or no decoder initialises): the owner ends the session. */
	onFatal?: (reason: string) => void;
	/** Injectable wall clock (ms). Defaults to Date.now. */
	now?: () => number;
	/** Injectable timer, defaults to an unref'd setTimeout/clearTimeout. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/**
 * The `mix` fan-in: sums the sources the bridge forwards into one PCM stream.
 *
 * There is one output timeline, in samples. A tick every `frameMs` mixes the next frame of it: each source's audio
 * in that frame (placed there by its [SourceTrack]) is added up, and a source with nothing there adds nothing. The
 * tick times are counted from the start (`start + n * frameMs`), and a timer that fires late runs every tick that
 * is due, so timer error does not accumulate. The clock starts with the first packet, or at once when `continuous`.
 *
 * With the default `gain: unity` the sum is not scaled by the number of sources: a speaker is as loud in the mix
 * as in their own stream, whoever else is talking. Only the peaks of overlapping speech are touched, by the
 * limiter, and only in a frame that holds two or more sources, so one speaker alone comes out bit-exact.
 */
export class AgentMixer {
	private readonly config: Readonly<MixConfig>;
	private readonly options: AgentMixerOptions;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly frameSamples: number;
	private readonly knee: number;
	private readonly timeline: MixTimeline;
	private readonly host: TrackHost;
	private readonly tracks = new Map<string, SourceTrack>();
	private readonly sum: Float64Array;
	private readonly counts: MixStats = newMixStats();
	private reported: MixStats = newMixStats();

	private startMs = 0;
	/** Frames mixed (or skipped) so far: the playhead is `ticks * frameSamples`. */
	private ticks = 0;
	private timerHandle: unknown = undefined;
	private started = false;
	private closed = false;
	private lastGain = 1;
	private lastSources = 0;
	private mixedKey = '';
	private failedFramesInARow = 0;
	private frameErrorLoggedAtMs?: number;
	private frameErrorsUnreported = 0;
	private decoderFailuresInARow = 0;
	private fatal = false;

	constructor(options: AgentMixerOptions) {
		this.options = options;
		this.config = normalizeMixConfig(options.config);
		this.now = options.now ?? Date.now;
		this.setTimer =
			options.setTimer ??
			((fn, ms) => {
				const t = setTimeout(fn, ms);
				unrefTimer(t);
				return t;
			});
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.frameSamples = this.config.frameMs * MIX_SAMPLES_PER_MS;
		this.knee = kneeFromDb(this.config.limiterKneeDb);
		this.sum = new Float64Array(this.frameSamples);
		this.timeline = {
			nowMs: () => this.now(),
			nowPos: () => Math.round((this.now() - this.startMs) * MIX_SAMPLES_PER_MS),
			playhead: () => this.ticks * this.frameSamples,
		};
		this.host = {
			config: this.config,
			timeline: this.timeline,
			stats: this.counts,
			logger: options.logger,
			decoderReady: () => {
				this.decoderFailuresInARow = 0;
			},
			decoderFailed: () => this.decoderFailed(),
			mediaDropped: (reason) => options.onMetric?.('agent_media_dropped', reason),
		};
		if (this.config.continuous) {
			this.start();
		}
	}

	/** What the mixer and its tracks counted so far. */
	get stats(): Readonly<MixStats> {
		return this.counts;
	}

	/** The counts since the last call, for a counter that is added to as the session runs; `maxSources` is the most so far. */
	takeStatsDelta(): MixStats {
		const delta = newMixStats();
		for (const name of Object.keys(delta) as Array<keyof MixStats>) {
			delta[name] = name === 'maxSources' ? this.counts[name] : this.counts[name] - this.reported[name];
		}
		this.reported = { ...this.counts };
		return delta;
	}

	/** Starts the clock, if it is not running. The first frame is due one `frameMs` from now. */
	start(): void {
		if (this.started || this.closed) {
			return;
		}
		this.started = true;
		this.startMs = this.now();
		this.schedule();
	}

	/** One packet of a participant source. */
	push(tag: string, packet: MixPacket): void {
		if (this.closed) {
			return;
		}
		this.start();
		let track = this.tracks.get(tag);
		if (track === undefined) {
			track = new SourceTrack(tag, this.host, this.options.createDecoder());
			this.tracks.set(tag, track);
		}
		track.push(packet);
	}

	/** The bridge announced the source again: its `chunk` numbering starts over (see [SourceTrack.restart]). */
	restart(tag: string): void {
		this.tracks.get(tag)?.restart();
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (this.timerHandle !== undefined) {
			this.clearTimer(this.timerHandle);
			this.timerHandle = undefined;
		}
		for (const track of this.tracks.values()) {
			track.free();
		}
		this.tracks.clear();
	}

	private schedule(): void {
		const due = this.startMs + (this.ticks + 1) * this.config.frameMs;
		this.timerHandle = this.setTimer(() => this.run(), Math.max(0, due - this.now()));
	}

	private run(): void {
		this.timerHandle = undefined;
		if (this.closed) {
			return;
		}
		try {
			const due = Math.floor((this.now() - this.startMs) / this.config.frameMs) - this.ticks;
			if (due > MAX_CATCH_UP_TICKS) {
				// What was due is stale. Skip to now; the queued audio whose time has passed goes with it.
				const skipped = due - 1;
				this.ticks += skipped;
				this.counts.ticksSkipped += skipped;
				this.options.logger.warn(`agent: mix: the clock stalled for ${due * this.config.frameMs} ms; skipped ${skipped} frames`);
				for (const track of this.tracks.values()) {
					track.prune(this.timeline.playhead());
				}
			}
			while (!this.closed && this.startMs + (this.ticks + 1) * this.config.frameMs <= this.now()) {
				this.tick();
			}
		} catch (error) {
			this.options.logger.error('agent: mix: the mixer clock failed', error);
		} finally {
			if (!this.closed) {
				this.schedule();
			}
		}
	}

	private tick(): void {
		try {
			this.mixFrame();
			this.failedFramesInARow = 0;
		} catch (error) {
			this.frameFailed(error);
		}
		this.ticks++;
		if (this.ticks % EXPIRY_SWEEP_TICKS === 0) {
			this.expireTracks();
		}
		if (this.options.onStats && (this.ticks * this.config.frameMs) % STATS_INTERVAL_MS < this.config.frameMs) {
			this.options.onStats(this.takeStatsDelta());
		}
	}

	/** A frame that failed to mix or to be delivered: counted, said at a bounded rate, and fatal when it keeps happening. */
	private frameFailed(error: unknown): void {
		this.counts.framesFailed++;
		this.frameErrorsUnreported++;
		const now = this.now();
		if (this.frameErrorLoggedAtMs === undefined || now - this.frameErrorLoggedAtMs >= FRAME_ERROR_LOG_INTERVAL_MS) {
			const count = this.frameErrorsUnreported > 1 ? ` (${this.frameErrorsUnreported} frames since the last report)` : '';
			this.options.logger.error(`agent: mix: failed to mix or deliver a frame${count}`, error);
			this.frameErrorLoggedAtMs = now;
			this.frameErrorsUnreported = 0;
		}
		if (++this.failedFramesInARow >= FAILED_FRAMES_FATAL) {
			this.fail(`${FAILED_FRAMES_FATAL} frames in a row failed to mix`);
		}
	}

	private decoderFailed(): void {
		this.options.onMetric?.('agent_decoder_failure');
		let ready = 0;
		for (const track of this.tracks.values()) {
			if (track.isReady) {
				ready++;
			}
		}
		if (++this.decoderFailuresInARow >= DECODER_FAILURES_FATAL && ready === 0) {
			this.fail('no Opus decoder initialises');
		}
	}

	private fail(reason: string): void {
		if (this.fatal) {
			return;
		}
		this.fatal = true;
		this.options.logger.error(`agent: mix: ${reason}; the mix cannot work`);
		this.options.onFatal?.(reason);
	}

	private mixFrame(): void {
		const fromPos = this.ticks * this.frameSamples;
		const toPos = fromPos + this.frameSamples;

		let sources: SourceTrack[] = [];
		for (const track of this.tracks.values()) {
			if (track.hasAudioIn(fromPos, toPos)) {
				sources.push(track);
			}
		}
		if (this.config.maxSpeakers > 0 && sources.length > this.config.maxSpeakers) {
			sources = sources
				.map((track) => ({ track, energy: track.recentEnergy() }))
				.sort((a, b) => b.energy - a.energy)
				.slice(0, this.config.maxSpeakers)
				.map((entry) => entry.track);
			this.counts.framesCapped++;
		}

		// The frame's place is given up before anything can fail: a frame that fails is not mixed again.
		const lastSources = this.lastSources;
		this.lastSources = sources.length;
		try {
			if (sources.length > 0 || this.config.continuous) {
				this.sum.fill(0);
				for (const track of sources) {
					track.addTo(this.sum, fromPos);
				}
				const out = new Int16Array(this.frameSamples);
				if (sources.length > 0) {
					const gain = mixGain(this.config.gain, sources.length);
					// After a frame of silence there is nothing to ramp from: start at the new gain.
					applyGainRamp(this.sum, lastSources === 0 ? gain : this.lastGain, gain);
					this.lastGain = gain;
					// One source alone is its own decoded audio: with unity gain the clamp leaves it bit-exact.
					const limited = limitToPcm16(this.sum, out, sources.length > 1 ? this.config.limiter : 'clamp', this.knee);
					if (limited) {
						this.counts.framesLimited++;
					}
				}
				this.counts.framesSent++;
				this.counts.maxSources = Math.max(this.counts.maxSources, sources.length);
				this.options.onFrame(new Uint8Array(out.buffer), this.ticks * this.config.frameMs * RTP_TICKS_PER_MS);
			}
		} finally {
			for (const track of this.tracks.values()) {
				track.prune(toPos);
			}
		}
		this.reportMixed(toPos);
	}

	/**
	 * The sources in a talk: those with audio queued or played less than a talk gap ago, so a pause between words
	 * is not a change. A source the cap leaves out of the sum is listed all the same.
	 */
	private reportMixed(playhead: number): void {
		if (this.options.onMixedChange === undefined) {
			return;
		}
		const talkGapSamples = this.config.talkGapMs * MIX_SAMPLES_PER_MS;
		const tags: string[] = [];
		for (const track of this.tracks.values()) {
			if (track.inTalkAt(playhead, talkGapSamples)) {
				tags.push(track.tag);
			}
		}
		tags.sort();
		const key = tags.join(',');
		if (key !== this.mixedKey) {
			this.mixedKey = key;
			this.options.onMixedChange(tags);
		}
	}

	private expireTracks(): void {
		const now = this.now();
		for (const [tag, track] of this.tracks) {
			if (track.isIdle(now, TRACK_EXPIRY_MS)) {
				track.free();
				this.tracks.delete(tag);
			}
		}
	}

	/** The number of sources that hold a decoder. */
	get trackCount(): number {
		return this.tracks.size;
	}
}
