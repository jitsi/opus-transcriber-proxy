/*
 * Copyright @ 2025 - present 8x8, Inc.
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
 * Chains two AudioDecoder instances so that the output of the outer decoder
 * becomes the input of the inner decoder.
 *
 * Intended use: OggOpusDecapsulator (outer) → OpusAudioDecoder (inner) to
 * convert Ogg-Opus input directly to PCM output.
 *
 * Chunk-sequence tracking (out-of-order detection) is performed by the outer
 * decoder using the chunkNo / timestamp from the media event.  The inner
 * decoder always receives NO_CHUNK_INFO so it treats every packet it sees as
 * in-order; this means OpusAudioDecoder will not emit concealment frames for
 * Opus packets lost inside a dropped Ogg page.  Cross-page concealment
 * requires knowledge of how many packets the dropped page contained, which is
 * unknowable without receiving the page.
 *
 * ready resolves when both inner and outer decoders are ready.
 * reset() and free() are forwarded to both decoders.
 */
export class CascadedDecoder implements AudioDecoder {
	private _outer: AudioDecoder;
	private _inner: AudioDecoder;

	constructor(outer: AudioDecoder, inner: AudioDecoder) {
		this._outer = outer;
		this._inner = inner;
	}

	get ready(): Promise<void> {
		return Promise.all([this._outer.ready, this._inner.ready]).then(() => undefined);
	}

	decodeChunk(frame: Uint8Array, chunkNo: number, timestamp: number): DecodedAudio[] | null {
		const outerResults = this._outer.decodeChunk(frame, chunkNo, timestamp);
		if (outerResults === null) {
			return null;
		}

		const results: DecodedAudio[] = [];
		for (const outerFrame of outerResults) {
			const innerResults = this._inner.decodeChunk(outerFrame.audioData, NO_CHUNK_INFO, NO_CHUNK_INFO);
			if (innerResults !== null) {
				results.push(...innerResults);
			}
		}
		return results;
	}

	reset(): void {
		this._outer.reset();
		this._inner.reset();
	}

	free(): void {
		this._outer.free();
		this._inner.free();
	}
}
