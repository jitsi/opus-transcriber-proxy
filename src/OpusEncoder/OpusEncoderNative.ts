// Low-level Opus encoder. Binds directly to native libopus via N-API
// (opus_native.node). This is the `native` backend; OpusEncoderWasm is the
// Emscripten/WASM sibling. Both implement IOpusEncoder, and OpusEncoder picks
// one at runtime via OPUS_BACKEND. The public surface (constructor config,
// `ready`, `encodeFrame`, `getFrameSize`, `getFrameSizeBytes`, `free`) is
// identical across the two so callers are backend-agnostic.

import { nativeOpus, OPUS_APPLICATION, type NativeOpusEncoder } from '../OpusDecoder/nativeOpus';
import type { IOpusEncoder, OpusEncoderConfig } from './opusEncoderTypes';

export class OpusEncoderNative implements IOpusEncoder {
	private encoder: NativeOpusEncoder | null = null;
	private config: Required<OpusEncoderConfig>;
	private frameSize: number = 0;
	private isReady: boolean = false;
	private inputBuffer: Uint8Array = new Uint8Array(0);

	public ready: Promise<void>;

	constructor(config: OpusEncoderConfig) {
		this.config = {
			sampleRate: config.sampleRate,
			channels: config.channels,
			application: config.application || 'voip',
			bitrate: config.bitrate || 64000,
			complexity: config.complexity || 5,
		};

		this.ready = this.init();
	}

	private async init(): Promise<void> {
		const application = OPUS_APPLICATION[this.config.application];

		this.encoder = new nativeOpus.OpusEncoder(this.config.sampleRate, this.config.channels, application);

		// 20ms frames at the configured sample rate.
		this.frameSize = this.config.sampleRate / 50;

		this.encoder.setBitrate(this.config.bitrate);
		this.encoder.setComplexity(this.config.complexity);

		this.isReady = true;
	}

	encodeFrame(pcmData: Uint8Array): Uint8Array[] {
		if (!this.isReady || !this.encoder) {
			throw new Error('Encoder not ready');
		}

		// Append to input buffer
		const newBuffer = new Uint8Array(this.inputBuffer.length + pcmData.length);
		newBuffer.set(this.inputBuffer);
		newBuffer.set(pcmData, this.inputBuffer.length);
		this.inputBuffer = newBuffer;

		const frameSizeBytes = this.getFrameSizeBytes();
		const encodedFrames: Uint8Array[] = [];

		while (this.inputBuffer.length >= frameSizeBytes) {
			const frameData = this.inputBuffer.subarray(0, frameSizeBytes);

			const encoded = this.encoder.encode(Buffer.from(frameData), this.frameSize);
			encodedFrames.push(new Uint8Array(encoded));

			this.inputBuffer = this.inputBuffer.subarray(frameSizeBytes);
		}

		return encodedFrames;
	}

	free(): void {
		if (this.encoder) {
			this.encoder.destroy();
			this.encoder = null;
			this.isReady = false;
		}
	}

	getFrameSize(): number {
		return this.frameSize;
	}

	getFrameSizeBytes(): number {
		return this.frameSize * this.config.channels * 2; // 16-bit samples
	}
}
