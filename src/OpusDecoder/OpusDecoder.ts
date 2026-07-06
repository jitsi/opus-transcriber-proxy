// Low-level Opus decoder facade. Selects the native (libopus N-API addon) or WASM (Emscripten)
// backend at runtime via config.opus.backend (OPUS_BACKEND), keeping the historical public API
// (`new OpusDecoder({ sampleRate, channels })`, `ready`, `decodeFrame`, `conceal`, `reset`, `free`).
//
// The chosen backend is loaded with a dynamic import() so the other one is never evaluated — in
// particular a native deployment never runs OpusDecoderWasm's top-level WASM file read, and a WASM
// deployment never requires the native addon. This makes init asynchronous; callers already await
// `ready` before decoding, so behaviour is unchanged.

import { config } from '../config';
import type {
	IOpusDecoder,
	OpusDecodedAudio,
	OpusDecoderDefaultSampleRate,
	OpusDecoderOptions,
	OpusDecoderSampleRate,
} from './opusTypes';

export type {
	DecodeError,
	OpusDecodedAudio,
	OpusDecoderDefaultSampleRate,
	OpusDecoderOptions,
	OpusDecoderSampleRate,
} from './opusTypes';

type Decoded<SampleRate extends OpusDecoderSampleRate | undefined> = OpusDecodedAudio<
	SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate
>;

export class OpusDecoder<SampleRate extends OpusDecoderSampleRate | undefined = undefined>
	implements IOpusDecoder<SampleRate>
{
	private impl: IOpusDecoder<SampleRate> | undefined;
	private readonly _ready: Promise<void>;

	constructor(options: OpusDecoderOptions<SampleRate> = {}) {
		this._ready = this.init(options);
	}

	private async init(options: OpusDecoderOptions<SampleRate>): Promise<void> {
		if (config.opus.backend === 'native') {
			const { OpusDecoderNative } = await import('./OpusDecoderNative');
			this.impl = new OpusDecoderNative<SampleRate>(options);
		} else {
			const { OpusDecoderWasm } = await import('./OpusDecoderWasm');
			// Register the Node (fs-loaded) WASM binding; kept in a separate dynamically-imported module
			// so a native deployment never pulls `fs`/the glue into its graph.
			const { registerNodeOpusWasm } = await import('./wasmSourceNode');
			await registerNodeOpusWasm();
			this.impl = new OpusDecoderWasm<SampleRate>(options);
		}
		await this.impl.ready;
	}

	get ready(): Promise<void> {
		return this._ready;
	}

	private require(): IOpusDecoder<SampleRate> {
		if (this.impl === undefined) {
			throw new Error('OpusDecoder used before ready resolved');
		}
		return this.impl;
	}

	decodeFrame(opusFrame: Uint8Array): Decoded<SampleRate> {
		return this.require().decodeFrame(opusFrame);
	}

	conceal(opusFrame: Uint8Array | undefined, samplesToConceal: number): Decoded<SampleRate> {
		return this.require().conceal(opusFrame, samplesToConceal);
	}

	reset(): void {
		this.require().reset();
	}

	free(): void {
		this.impl?.free();
	}
}
