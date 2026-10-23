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

// Shared types and the common interface for the low-level Opus decoder, implemented by both the
// native (libopus N-API addon) and WASM (Emscripten) backends. The OpusDecoder facade picks one at
// runtime (see OpusDecoder.ts); consumers depend only on these types.

import type { DecodeError, DecodedAudio } from '../AudioDecoder';

export type OpusDecoderDefaultSampleRate = 48000;
export type OpusDecoderSampleRate = 8000 | 12000 | 16000 | 24000 | OpusDecoderDefaultSampleRate;

// Re-export DecodeError from AudioDecoder for backwards compatibility.
export type { DecodeError } from '../AudioDecoder';

export interface OpusDecodedAudio<SampleRate extends OpusDecoderSampleRate = OpusDecoderDefaultSampleRate> extends DecodedAudio {
	sampleRate: SampleRate;
	channels: number;
}

export interface OpusDecoderOptions<SampleRate extends OpusDecoderSampleRate | undefined = undefined> {
	sampleRate?: SampleRate;
	channels?: number;
}

/**
 * The surface both backends implement and the facade delegates to. The conditional return type
 * mirrors the historical wrapper: an unspecified sample rate resolves to the 48 kHz default.
 */
export interface IOpusDecoder<SampleRate extends OpusDecoderSampleRate | undefined = undefined> {
	readonly ready: Promise<void>;
	decodeFrame(opusFrame: Uint8Array): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
	conceal(
		opusFrame: Uint8Array | undefined,
		samplesToConceal: number,
	): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
	reset(): void;
	free(): void;
}
