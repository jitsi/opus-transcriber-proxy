/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
	readonly ready: Promise<void> = Promise.resolve();
	private _lastChunkNo = NO_CHUNK_INFO;

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

		return [{ audioData: frame, samplesDecoded: 0, errors: [], kind: 'normal' }];
	}

	reset(): void {
		this._lastChunkNo = NO_CHUNK_INFO;
	}

	free(): void {
		// No resources to release
	}
}
