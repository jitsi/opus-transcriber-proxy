import type { AudioDecoder, DecodedAudio } from '../AudioDecoder';
import { NO_CHUNK_INFO } from '../AudioDecoder';
import { OpusDecoder, type OpusDecoderSampleRate } from './OpusDecoder';

/** Opus always uses a 48 kHz clock for RTP timestamps, regardless of output sample rate */
const OPUS_CLOCK_RATE = 48000;

/**
 * Higher-level Opus decoder that owns chunk-sequence tracking and packet-loss
 * concealment logic.  Wraps the low-level WASM OpusDecoder.
 */
export class OpusAudioDecoder implements AudioDecoder {
	private _decoder: OpusDecoder<OpusDecoderSampleRate>;
	private _lastChunkNo = NO_CHUNK_INFO;
	private _lastTimestamp = NO_CHUNK_INFO;
	private _lastFrameSamples = -1;
	private _sampleRate: OpusDecoderSampleRate;
	/** Maximum loss concealment: 120 ms at the configured output sample rate */
	private _maxConcealmentSamples: number;

	constructor(sampleRate: OpusDecoderSampleRate = 24000) {
		this._sampleRate = sampleRate;
		this._maxConcealmentSamples = Math.round(0.120 * sampleRate);
		this._decoder = new OpusDecoder({ sampleRate, channels: 1 });
	}

	get ready(): Promise<void> {
		return this._decoder.ready;
	}

	decodeChunk(frame: Uint8Array, chunkNo: number, timestamp: number): DecodedAudio[] | null {
		const results: DecodedAudio[] = [];

		if (chunkNo !== NO_CHUNK_INFO && this._lastChunkNo !== NO_CHUNK_INFO) {
			const chunkDelta = chunkNo - this._lastChunkNo;

			if (chunkDelta <= 0) {
				return null; // out-of-order or replayed packet — discard
			}

			const lostFrames = chunkDelta - 1;
			if (lostFrames > 0 && this._lastFrameSamples > 0) {
				const lostFramesInSamples = lostFrames * this._lastFrameSamples;
				const timestampDelta = timestamp !== NO_CHUNK_INFO ? timestamp - this._lastTimestamp : 0;
				const timestampDeltaInSamples = timestampDelta > 0 ? (timestampDelta / OPUS_CLOCK_RATE) * this._sampleRate : Infinity;
				const samplesToConceal = Math.min(lostFramesInSamples, timestampDeltaInSamples, this._maxConcealmentSamples);

				const concealed = this._decoder.conceal(frame, samplesToConceal);
				results.push({ ...concealed, kind: 'concealment' });
			}
		}

		if (chunkNo !== NO_CHUNK_INFO) {
			this._lastChunkNo = chunkNo;
			this._lastTimestamp = timestamp;
		}

		const decoded = this._decoder.decodeFrame(frame);
		if (decoded.errors.length === 0) {
			this._lastFrameSamples = decoded.samplesDecoded;
		}
		results.push({ ...decoded, kind: 'normal' });

		return results;
	}

	reset(): void {
		this._lastChunkNo = NO_CHUNK_INFO;
		this._lastTimestamp = NO_CHUNK_INFO;
		this._lastFrameSamples = -1;
	}

	free(): void {
		this._decoder.free();
	}
}
