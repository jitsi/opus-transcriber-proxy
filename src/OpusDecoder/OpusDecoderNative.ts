// Low-level Opus decoder. Binds directly to native libopus via N-API
// (opus_native.node). This is the `native` backend; OpusDecoderWasm is the
// Emscripten/WASM sibling. Both implement IOpusDecoder, and OpusDecoder picks
// one at runtime via OPUS_BACKEND. The public surface (constructor options,
// `ready`, `decodeFrame`, `conceal`, `reset`, `free` and the `OpusDecodedAudio`
// shape) is identical across the two so callers are backend-agnostic.

import logger from '../logger';
import type { DecodeError } from '../AudioDecoder';
import { nativeOpus, type NativeOpusDecoder } from './nativeOpus';
import type {
	IOpusDecoder,
	OpusDecodedAudio,
	OpusDecoderDefaultSampleRate,
	OpusDecoderSampleRate,
} from './opusTypes';

const VALID_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000];

export class OpusDecoderNative<SampleRate extends OpusDecoderSampleRate | undefined = undefined>
	implements IOpusDecoder<SampleRate>
{
	private _sampleRate: OpusDecoderSampleRate;
	private _channels: number;
	/** Maximum output samples per channel for a single packet: 120 ms at the output rate. */
	private _maxFrameSize: number;
	private _frameNumber: number = 0;
	private _inputBytes: number = 0;
	private _outputSamples: number = 0;
	private _decoder: NativeOpusDecoder | undefined;
	private _ready: Promise<void>;

	constructor(
		options: {
			sampleRate?: SampleRate;
			channels?: number;
		} = {},
	) {
		const { sampleRate, channels } = options;

		this._sampleRate = VALID_SAMPLE_RATES.includes(sampleRate as number) ? (sampleRate as OpusDecoderSampleRate) : 48000;
		this._channels = typeof channels === 'number' ? channels : 2;
		this._maxFrameSize = Math.round(0.12 * this._sampleRate);

		try {
			this._decoder = new nativeOpus.OpusDecoder(this._sampleRate, this._channels);
			logger.debug('OpusDecoder native module loaded');
		} catch (error) {
			logger.error(`libopus opus_decoder_create failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}

		this._ready = Promise.resolve();
	}

	get ready(): Promise<void> {
		return this._ready;
	}

	reset(): void {
		if (this._decoder === undefined) {
			throw new Error('Decoder freed or not initialized');
		}
		this._decoder.reset();
	}

	free(): void {
		if (this._decoder !== undefined) {
			this._decoder.destroy();
			this._decoder = undefined;
		}
	}

	private emptyResult(errors: DecodeError[]): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate> {
		return {
			errors,
			audioData: new Uint8Array(0),
			channels: this._channels,
			samplesDecoded: 0,
			sampleRate: this._sampleRate,
		} as OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
	}

	private buildResult(
		errors: DecodeError[],
		pcm: Buffer,
	): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate> {
		const samplesDecoded = pcm.length / 2 / this._channels;
		// Copy out of the addon-owned buffer into a standalone Uint8Array.
		const audioData = new Uint8Array(pcm.length);
		audioData.set(pcm);
		return {
			errors,
			audioData,
			channels: this._channels,
			samplesDecoded,
			sampleRate: this._sampleRate,
		} as OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
	}

	decodeFrame(opusFrame: Uint8Array): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate> {
		const errors: DecodeError[] = [];

		if (this._decoder === undefined) {
			logger.error('Decoder freed or not initialized');
			errors.push({ message: 'Decoder freed or not initialized', frameLength: 0, frameNumber: 0, inputBytes: 0, outputSamples: 0 });
			return this.emptyResult(errors);
		}

		let pcm: Buffer;
		try {
			pcm = this._decoder.decode(Buffer.from(opusFrame), this._maxFrameSize, false);
		} catch (error) {
			const message = `libopus decode failed: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(message);
			errors.push({
				message,
				frameLength: opusFrame.length,
				frameNumber: this._frameNumber,
				inputBytes: this._inputBytes,
				outputSamples: this._outputSamples,
			});
			this._frameNumber++;
			this._inputBytes += opusFrame.length;
			return this.emptyResult(errors);
		}

		this._frameNumber++;
		this._inputBytes += opusFrame.length;
		this._outputSamples += pcm.length / 2 / this._channels;

		return this.buildResult(errors, pcm);
	}

	conceal(
		opusFrame: Uint8Array | undefined,
		samplesToConceal: number,
	): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate> {
		const errors: DecodeError[] = [];

		if (this._decoder === undefined) {
			logger.error('Decoder freed or not initialized');
			errors.push({ message: 'Decoder freed or not initialized', frameLength: 0, frameNumber: 0, inputBytes: 0, outputSamples: 0 });
			return this.emptyResult(errors);
		}

		let frameSize = Math.round(samplesToConceal);
		if (frameSize > this._maxFrameSize) {
			frameSize = this._maxFrameSize;
		}

		const inLength = opusFrame !== undefined ? opusFrame.length : 0;
		let pcm: Buffer;
		try {
			// opusFrame present -> FEC decode of the next frame; absent -> PLC.
			pcm = this._decoder.decode(opusFrame !== undefined ? Buffer.from(opusFrame) : null, frameSize, opusFrame !== undefined);
		} catch (error) {
			const message = `libopus conceal failed: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(message);
			errors.push({
				message,
				frameLength: inLength,
				frameNumber: this._frameNumber,
				inputBytes: this._inputBytes,
				outputSamples: this._outputSamples,
			});
			this._frameNumber++;
			this._inputBytes += inLength;
			return this.emptyResult(errors);
		}

		this._frameNumber++;
		this._inputBytes += inLength;
		this._outputSamples += pcm.length / 2 / this._channels;

		return this.buildResult(errors, pcm);
	}
}
