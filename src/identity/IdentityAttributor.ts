import type { ISidecarClient, IdentifyResult } from './SidecarClient';
import type { Word, AttributedSegment } from './types';

export interface IdentityAttributorOptions {
	sessionId: string;
	streamId: string;
	sampleRate?: number; // default 16000
	maxBufferSec?: number; // ring cap, default 120
}

export interface UtteranceAnalysis {
	speakerCount: number;
	segments: AttributedSegment[];
}

/**
 * Per-stream PCM ring buffer + speaker attribution. Maintains a media clock
 * (origin = first appended sample, matching the audio sent to the ASR backend)
 * so xAI's absolute per-word times and the sidecar's turns share a timeline.
 *
 * On a final, it slices the utterance's PCM, asks the sidecar to diarize+identify
 * it, converts the returned turns to absolute media time, and attributes each
 * word to a speaker. Fully off the hot path: attributeFinal never throws and
 * returns null when the feature can't produce a result.
 */
export class IdentityAttributor {
	private chunks: Buffer[] = [];
	private bufferedBytes = 0;
	private bufStartSec = 0;
	private readonly bytesPerSec: number;
	private readonly maxBytes: number;

	constructor(
		private sidecar: ISidecarClient,
		private o: IdentityAttributorOptions,
	) {
		const sr = o.sampleRate ?? 16000;
		this.bytesPerSec = sr * 2; // s16le mono
		this.maxBytes = (o.maxBufferSec ?? 120) * this.bytesPerSec;
	}

	appendPcm(pcm: Uint8Array): void {
		// Copy — the decoder may reuse the underlying buffer after this returns.
		this.chunks.push(Buffer.from(pcm));
		this.bufferedBytes += pcm.byteLength;
		while (this.bufferedBytes > this.maxBytes && this.chunks.length > 1) {
			const dropped = this.chunks.shift()!;
			this.bufferedBytes -= dropped.length;
			this.bufStartSec += dropped.length / this.bytesPerSec;
		}
	}

	/**
	 * Append `seconds` of digital silence so the ring's media clock stays aligned with what the ASR
	 * backend actually received. The xAI backend injects idle silence to flush a trailing utterance
	 * (forceCommit) — audio the ring never saw — which would otherwise shift every later word's time
	 * ahead of the ring and misattribute the wrong span. JIT-16065.
	 */
	appendSilence(seconds: number): void {
		if (!(seconds > 0)) return;
		const bytes = Math.round(seconds * this.bytesPerSec) & ~1; // even (s16le)
		if (bytes > 0) this.appendPcm(new Uint8Array(bytes));
	}

	/**
	 * Drop all buffered audio and reset the media clock to 0. Called on every backend reconnect: a
	 * fresh ASR stream restarts its per-word clock at 0, but the ring clock keeps counting, so without
	 * this the two diverge and post-reconnect words map to entirely wrong audio. JIT-16065.
	 */
	reset(): void {
		this.chunks = [];
		this.bufferedBytes = 0;
		this.bufStartSec = 0;
	}

	// `all` is the pre-concatenated ring, passed in by the caller so a multi-slice attribution
	// concatenates the ring (up to ~maxBufferSec × bytesPerSec, several MB) once, not per speaker.
	private sliceSec(all: Buffer, startSec: number, endSec: number): Buffer | null {
		let rs = Math.floor((startSec - this.bufStartSec) * this.bytesPerSec);
		let re = Math.ceil((endSec - this.bufStartSec) * this.bytesPerSec);
		rs = Math.max(0, rs) & ~1; // even byte (s16le sample) boundaries
		re = Math.min(all.length, re) & ~1;
		if (re <= rs) return null;
		return all.subarray(rs, re);
	}

	/**
	 * Attribute an utterance to speakers using the TRANSCRIPTION BACKEND's diarization labels
	 * (`word.speaker`), and the sidecar only to IDENTIFY each speaker's voice (embed + match — no
	 * pyannote). This removes the sidecar's diarization from the hot path (the ~15-25s latency source
	 * that caused laggy CC + end-of-meeting store tail-loss). Words with no `speaker` collapse to a
	 * single speaker (0), so non-diarizing backends still get a fast single-speaker identify. JIT-16065.
	 *
	 * Returns speakerCount + per-run segments (in order, each labelled with its speaker's resolved
	 * identity). Null when there are no words. (Enrollment audio comes from recentWindow, not here.)
	 */
	async analyze(words: Word[], tenant: string): Promise<UtteranceAnalysis | null> {
		if (!words.length) return null;

		// Group consecutive words into runs by backend speaker label.
		interface Run {
			speaker: number;
			words: Word[];
		}
		const runs: Run[] = [];
		for (const w of words) {
			const spk = w.speaker ?? 0;
			const last = runs[runs.length - 1];
			if (last && last.speaker === spk) last.words.push(w);
			else runs.push({ speaker: spk, words: [w] });
		}

		// Identify each distinct speaker from the concatenation of all their runs' audio.
		const runsBySpeaker = new Map<number, Run[]>();
		for (const r of runs) {
			const arr = runsBySpeaker.get(r.speaker) ?? [];
			arr.push(r);
			runsBySpeaker.set(r.speaker, arr);
		}
		const minBytes = this.bytesPerSec * 0.5; // need >= 0.5s of audio to attempt a match
		const idBySpeaker = new Map<number, IdentifyResult>();
		const all = Buffer.concat(this.chunks); // concatenate the ring once, reused across all speakers
		await Promise.all(
			[...runsBySpeaker.entries()].map(async ([spk, spkRuns]) => {
				const slice = this.concatSlices(
					all,
					spkRuns.map((r) => [r.words[0].start, r.words[r.words.length - 1].end] as [number, number]),
				);
				if (!slice || slice.length < minBytes) return;
				const m = await this.sidecar.identify(tenant, slice);
				if (m && m.identity) idBySpeaker.set(spk, m);
			}),
		);

		// Per-run attributed segments, in order, each labelled with its speaker's resolved identity.
		const segments: AttributedSegment[] = runs.map((run) => {
			const m = idBySpeaker.get(run.speaker);
			return {
				sessionSpeakerId: run.speaker,
				handle: null,
				identity: m?.identity ?? null,
				name: m?.name ?? null,
				score: m?.score ?? 0,
				text: run.words.map((w) => w.text).join(' '),
				start: run.words[0].start,
				end: run.words[run.words.length - 1].end,
			};
		});

		return { speakerCount: runsBySpeaker.size, segments };
	}

	/**
	 * The most recent `seconds` of buffered PCM (or all buffered audio, if less) — used to auto-enroll
	 * individual (non-diarized) endpoints in the background. It reads from the rolling ring buffer, NOT
	 * from a single final's word span, so enrollment gets a stable >= enrollMinSpeechSec window
	 * regardless of how the backend chunks its finals: granular finals emit ~short spans that would
	 * otherwise never reach the enroll threshold and silently disable enrollment. No identify is run
	 * (the endpoint owner is already known; a spurious open-set match would misattribute). JIT-16065.
	 */
	recentWindow(seconds: number): { pcm: Buffer; windowSec: number } | null {
		const all = Buffer.concat(this.chunks);
		if (all.length === 0) return null;
		const want = Math.max(0, Math.floor(seconds * this.bytesPerSec)) & ~1; // even (s16le)
		const pcm = want > 0 && all.length > want ? all.subarray(all.length - want) : all;
		return { pcm, windowSec: pcm.length / this.bytesPerSec };
	}

	/** Concatenate PCM slices for a set of [startSec, endSec] ranges (one speaker's runs). */
	private concatSlices(all: Buffer, ranges: Array<[number, number]>): Buffer | null {
		const parts: Buffer[] = [];
		for (const [s, e] of ranges) {
			const b = this.sliceSec(all, s, e);
			if (b) parts.push(b);
		}
		return parts.length ? Buffer.concat(parts) : null;
	}
}
