// Low-level Opus encoder facade. Selects the native (libopus N-API addon) or WASM (Emscripten)
// backend at runtime via config.opus.backend (OPUS_BACKEND), keeping the historical public API
// (`new OpusEncoder(config)`, `ready`, `encodeFrame`, `getFrameSize`, `getFrameSizeBytes`, `free`).
//
// The chosen backend is loaded with a dynamic import() so the other one is never evaluated — a
// native deployment never runs OpusEncoderWasm's top-level WASM file read, and vice versa. Init is
// therefore asynchronous; callers already await `ready` before encoding, so behaviour is unchanged.

import { config } from '../config';
import type { IOpusEncoder, OpusEncoderConfig } from './opusEncoderTypes';

export type { OpusEncoderConfig, OpusEncoderSampleRate } from './opusEncoderTypes';

export class OpusEncoder implements IOpusEncoder {
	private impl: IOpusEncoder | undefined;
	public readonly ready: Promise<void>;

	constructor(config_: OpusEncoderConfig) {
		this.ready = this.init(config_);
	}

	private async init(config_: OpusEncoderConfig): Promise<void> {
		if (config.opus.backend === 'native') {
			const { OpusEncoderNative } = await import('./OpusEncoderNative');
			this.impl = new OpusEncoderNative(config_);
		} else {
			const { OpusEncoderWasm } = await import('./OpusEncoderWasm');
			// Register the Node (fs-loaded) WASM binding (see OpusDecoder.ts).
			const { registerNodeOpusWasm } = await import('../OpusDecoder/wasmSourceNode');
			registerNodeOpusWasm();
			this.impl = new OpusEncoderWasm(config_);
		}
		await this.impl.ready;
	}

	private require(): IOpusEncoder {
		if (this.impl === undefined) {
			throw new Error('OpusEncoder used before ready resolved');
		}
		return this.impl;
	}

	encodeFrame(pcmData: Uint8Array): Uint8Array[] {
		return this.require().encodeFrame(pcmData);
	}

	getFrameSize(): number {
		return this.require().getFrameSize();
	}

	getFrameSizeBytes(): number {
		return this.require().getFrameSizeBytes();
	}

	free(): void {
		this.impl?.free();
	}
}
