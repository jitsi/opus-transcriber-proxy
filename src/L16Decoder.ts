import type { AudioDecoder, DecodedAudio } from './AudioDecoder';
import { NO_CHUNK_INFO } from './AudioDecoder';
import { resamplePCM16, RESAMPLER_SUPPORTED_SAMPLE_RATES } from './Resampler';

/**
 * AudioDecoder for L16 (raw PCM16) input.
 *
 * If the input and output sample rates match, frames are passed through
 * unchanged. If they differ, each frame is resampled using linear
 * interpolation before being forwarded.
 *
 * Chunk-sequence tracking is performed (same as PassThroughDecoder) so
 * out-of-order packets are discarded consistently across decoder types.
 */
export class L16Decoder implements AudioDecoder {
	private _lastChunkNo = NO_CHUNK_INFO;
	private _ready = Promise.resolve();
	private _inputSampleRate: number;
	private _outputSampleRate: number;

	constructor(inputSampleRate: number, outputSampleRate: number) {
		if (!RESAMPLER_SUPPORTED_SAMPLE_RATES.has(inputSampleRate)) {
			throw new Error(
				`Unsupported L16 input sample rate: ${inputSampleRate}. Supported rates: ${[...RESAMPLER_SUPPORTED_SAMPLE_RATES].join(', ')}`
			);
		}
		if (!RESAMPLER_SUPPORTED_SAMPLE_RATES.has(outputSampleRate)) {
			throw new Error(
				`Unsupported L16 output sample rate: ${outputSampleRate}. Supported rates: ${[...RESAMPLER_SUPPORTED_SAMPLE_RATES].join(', ')}`
			);
		}
		this._inputSampleRate = inputSampleRate;
		this._outputSampleRate = outputSampleRate;
	}

	get ready(): Promise<void> {
		return this._ready;
	}

	decodeChunk(frame: Uint8Array, chunkNo: number, _timestamp: number): DecodedAudio[] | null {
		if (chunkNo !== NO_CHUNK_INFO && this._lastChunkNo !== NO_CHUNK_INFO) {
			if (chunkNo - this._lastChunkNo <= 0) {
				return null; // out-of-order or replayed packet — discard
			}
		}

		if (chunkNo !== NO_CHUNK_INFO) {
			this._lastChunkNo = chunkNo;
		}

		const audioData = resamplePCM16(frame, this._inputSampleRate, this._outputSampleRate);
		return [{ audioData, samplesDecoded: audioData.length / 2, errors: [], kind: 'normal' }];
	}

	reset(): void {
		this._lastChunkNo = NO_CHUNK_INFO;
	}

	free(): void {
		// No resources to release
	}
}
