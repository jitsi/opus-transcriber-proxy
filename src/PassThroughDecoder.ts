import type { AudioDecoder, DecodedAudio } from './AudioDecoder';
import { NO_CHUNK_INFO } from './AudioDecoder';

/**
 * Pass-through decoder that doesn't actually decode anything.
 * Used when the backend wants raw audio (e.g. raw Opus frames or Ogg-Opus).
 *
 * Still participates in chunk-sequence tracking so out-of-order packets are
 * discarded consistently with the Opus decoder path.  No concealment is
 * performed because the raw frames are forwarded as-is.
 */
export class PassThroughDecoder implements AudioDecoder {
	private _ready: Promise<void>;
	private _lastChunkNo = NO_CHUNK_INFO;

	constructor() {
		this._ready = Promise.resolve();
	}

	get ready(): Promise<void> {
		return this._ready;
	}

	decodeChunk(frame: Uint8Array, chunkNo: number, _timestamp: number): DecodedAudio[] | null {
		if (chunkNo !== NO_CHUNK_INFO && this._lastChunkNo !== NO_CHUNK_INFO) {
			const chunkDelta = chunkNo - this._lastChunkNo;
			if (chunkDelta <= 0) {
				return null; // out-of-order or replayed packet — discard
			}
		}

		if (chunkNo !== NO_CHUNK_INFO) {
			this._lastChunkNo = chunkNo;
		}

		return [{ audioData: frame, samplesDecoded: frame.length, errors: [], kind: 'normal' }];
	}

	reset(): void {
		this._lastChunkNo = NO_CHUNK_INFO;
	}

	free(): void {
		// No resources to release
	}
}
