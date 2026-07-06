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
