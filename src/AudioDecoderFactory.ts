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

import type { AudioFormat } from './AudioFormat';
import type { AudioDecoder } from './AudioDecoder';
import { OpusAudioDecoder } from './OpusDecoder/OpusAudioDecoder';
import { type OpusDecoderSampleRate } from './OpusDecoder/OpusDecoder';
import { PassThroughDecoder } from './PassThroughDecoder';
import { L16Decoder } from './L16Decoder';
import { OggOpusDecapsulator } from './OggOpusDecapsulator';
import { CascadedDecoder } from './CascadedDecoder';

/**
 * Create an audio decoder appropriate for converting from inputFormat to outputFormat.
 *
 * - ogg  → ogg:  PassThroughDecoder (backend wants raw Ogg)
 * - opus → opus: PassThroughDecoder (backend wants raw Opus)
 * - ogg  → opus: OggOpusDecapsulator (strip container, emit raw Opus frames)
 * - l16  → l16:  L16Decoder (resample or identity)
 * - opus → l16:  OpusAudioDecoder (decode Opus to PCM)
 * - ogg  → l16:  CascadedDecoder(OggOpusDecapsulator → OpusAudioDecoder)
 */
export function createAudioDecoder(inputFormat: AudioFormat, outputFormat: AudioFormat): AudioDecoder {
	if (outputFormat.encoding === 'ogg') {
		if (inputFormat.encoding !== 'ogg') {
			throw new Error(
				`Cannot pass through '${inputFormat.encoding}' input as 'ogg' output: encodings must match for pass-through`,
			);
		}
		return new PassThroughDecoder();
	}

	if (outputFormat.encoding === 'opus') {
		if (inputFormat.encoding === 'opus') {
			return new PassThroughDecoder();
		}
		if (inputFormat.encoding === 'ogg') {
			return new OggOpusDecapsulator();
		}
		throw new Error(
			`Cannot pass through '${inputFormat.encoding}' input as 'opus' output: encodings must match for pass-through`,
		);
	}

	// Output is l16
	if (inputFormat.encoding === 'l16') {
		const inputSampleRate = inputFormat.sampleRate ?? 24000;
		const outputSampleRate = outputFormat.sampleRate ?? 24000;
		return new L16Decoder(inputSampleRate, outputSampleRate);
	}
	if (inputFormat.encoding === 'ogg') {
		const sampleRate = (outputFormat.sampleRate ?? 24000) as OpusDecoderSampleRate;
		return new CascadedDecoder(new OggOpusDecapsulator(), new OpusAudioDecoder(sampleRate));
	}
	if (inputFormat.encoding !== 'opus') {
		// Unreachable for well-typed callers ('opus' is the only remaining union member);
		// kept as a defensive guard against as-any casts or future union additions.
		throw new Error(`Unsupported input encoding '${inputFormat.encoding}' for PCM output: use 'opus', 'l16', or 'ogg'`);
	}
	const sampleRate = (outputFormat.sampleRate ?? 24000) as OpusDecoderSampleRate;
	return new OpusAudioDecoder(sampleRate);
}
