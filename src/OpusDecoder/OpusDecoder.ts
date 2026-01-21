// Code adapted from wasm-audio-deocders https://eshaz.github.io/wasm-audio-decoders/
// "The source code that originates in this project is licensed under
// the MIT license. Please note that any external source code included
// by repository, such as the decoding libraries included as git
// submodules and compiled into the dist files, may have different
// licensing terms."

// Provide Node.js globals for emscripten module.  HACK.
if (typeof globalThis.__filename === 'undefined') {
	globalThis.__filename = './opus-decoder.js';
}
if (typeof globalThis.__dirname === 'undefined') {
	globalThis.__dirname = '.';
}

import OpusDecoderModule from '../../dist/opus-decoder.cjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger';

// Load WASM module from file system for Node.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const wasmPath = path.join(__dirname, '../../dist/opus-decoder.wasm');
const wasmBuffer = fs.readFileSync(wasmPath);
const wasm = new WebAssembly.Module(wasmBuffer);

export type OpusDecoderDefaultSampleRate = 48000;
export type OpusDecoderSampleRate = 8000 | 12000 | 16000 | 24000 | OpusDecoderDefaultSampleRate;

export interface DecodeError {
	message: string;
	frameLength: number;
	frameNumber: number;
	inputBytes: number;
	outputSamples: number;
}

export interface OpusDecodedAudio<SampleRate extends OpusDecoderSampleRate = OpusDecoderDefaultSampleRate> {
	pcmData: Int16Array;
	samplesDecoded: number;
	sampleRate: SampleRate;
	errors: DecodeError[];
	channels: number;
}

interface OpusWasmInstance {
	opus_frame_decoder_create: (sampleRate: number, channels: number) => number;
	opus_frame_decoder_destroy: (decoder: number) => void;
	opus_frame_decoder_reset: (decoder: number) => void;
	opus_frame_decode: (
		decoder: number,
		inputPtr: number,
		inputLength: number,
		outputPtr: number,
		frameSize: number,
		enableFec: number,
	) => number;
	malloc: (size: number) => number;
	free: (ptr: number) => void;
	HEAP: ArrayBuffer;
	module: any;
}

interface TypedArrayAllocation<T extends Uint8Array | Int16Array> {
	ptr: number;
	len: number;
	buf: T;
}

type TypedArrayConstructor = Uint8ArrayConstructor | Int16ArrayConstructor;

export class OpusDecoder<SampleRate extends OpusDecoderSampleRate | undefined = undefined> {
	static errors = new Map([
		[-1, 'OPUS_BAD_ARG: One or more invalid/out of range arguments'],
		[-2, 'OPUS_BUFFER_TOO_SMALL: Not enough bytes allocated in the buffer'],
		[-3, 'OPUS_INTERNAL_ERROR: An internal error was detected'],
		[-4, 'OPUS_INVALID_PACKET: The compressed data passed is corrupted'],
		[-5, 'OPUS_UNIMPLEMENTED: Invalid/unsupported request number'],
		[-6, 'OPUS_INVALID_STATE: An encoder or decoder structure is invalid or already freed'],
		[-7, 'OPUS_ALLOC_FAIL: Memory allocation has failed'],
	]);

	static opusModule = new Promise<OpusWasmInstance>((resolve, reject) => {
		OpusDecoderModule({
			instantiateWasm(info: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
				try {
					let instance = new WebAssembly.Instance(wasm, info);
					receive(instance);
					return instance.exports;
				} catch (error) {
					reject(error);
					throw error;
				}
			},
		})
			.then((module: any) => {
				resolve({
					opus_frame_decoder_create: module._opus_frame_decoder_create,
					opus_frame_decoder_destroy: module._opus_frame_decoder_destroy,
					opus_frame_decoder_reset: module._opus_frame_decoder_reset,
					opus_frame_decode: module._opus_frame_decode,
					malloc: module._malloc,
					free: module._free,
					HEAP: module.wasmMemory.buffer,
					module,
				});
			})
			.catch((error) => {
				reject(error);
			});
	});

	private _sampleRate: OpusDecoderSampleRate;
	private _channels: number;
	private _inputSize: number;
	private _outputChannelSize: number;
	private _inputBytes: number;
	private _outputSamples: number;
	private _frameNumber: number;
	private _pointers: Set<number>;
	private _ready: Promise<void>;
	private wasm!: OpusWasmInstance;
	private _input!: TypedArrayAllocation<Uint8Array>;
	private _output!: TypedArrayAllocation<Int16Array>;
	private _decoder: number | undefined;

	constructor(
		options: {
			sampleRate?: SampleRate;
			channels?: number;
		} = {},
	) {
		const isNumber = (param: unknown): param is number => typeof param === 'number';

		const { sampleRate, channels } = options;

		// libopus sample rate
		this._sampleRate = [8e3, 12e3, 16e3, 24e3, 48e3].includes(sampleRate as number) ? (sampleRate as OpusDecoderSampleRate) : 48000;

		// channel mapping family 0
		this._channels = isNumber(channels) ? channels : 2;

		this._inputSize = 32000 * 0.12 * this._channels; // 256kbs per channel
		this._outputChannelSize = 120 * 48; // 120 ms at 48 kHz

		this._inputBytes = 0;
		this._outputSamples = 0;
		this._frameNumber = 0;

		this._pointers = new Set();

		this._ready = this._init();
	}

	get ready(): Promise<void> {
		return this._ready;
	}

	async _init(): Promise<void> {
		const wasmInstance = await OpusDecoder.opusModule;
		this.wasm = wasmInstance;

		logger.debug('OpusDecoder WASM module loaded');

		this._input = this.allocateTypedArray(this._inputSize, Uint8Array);

		this._output = this.allocateTypedArray(this._channels * this._outputChannelSize, Int16Array);

		this._decoder = this.wasm.opus_frame_decoder_create(this._sampleRate, this._channels);

		if (this._decoder < 0) {
			const error = `libopus opus_decoder_create failed: ${OpusDecoder.errors.get(this._decoder) || 'Unknown Error'}`;
			logger.error(error);
			throw Error(error);
		}
	}

	reset() {
		if (this._decoder === undefined) {
			throw new Error('Decoder freed or not initialized');
		}
		this.wasm.opus_frame_decoder_reset(this._decoder);
	}

	allocateTypedArray<T extends Uint8Array | Int16Array>(
		len: number,
		TypedArray: TypedArrayConstructor,
		setPointer: boolean = true,
	): TypedArrayAllocation<T> {
		const ptr = this.wasm.malloc(TypedArray.BYTES_PER_ELEMENT * len);
		if (setPointer) this._pointers.add(ptr);

		return {
			ptr: ptr,
			len: len,
			buf: new TypedArray(this.wasm.HEAP, ptr, len) as T,
		};
	}

	free(): void {
		this._pointers.forEach((ptr) => {
			this.wasm.free(ptr);
		});
		this._pointers.clear();

		if (this._decoder !== undefined) {
			this.wasm.opus_frame_decoder_destroy(this._decoder);
			this._decoder = undefined;
		}
	}

	addError(
		errors: DecodeError[],
		message: string,
		frameLength: number,
		frameNumber: number,
		inputBytes: number,
		outputSamples: number,
	): void {
		errors.push({
			message: message,
			frameLength: frameLength,
			frameNumber: frameNumber,
			inputBytes: inputBytes,
			outputSamples: outputSamples,
		});
	}

	decodeFrame(opusFrame: Uint8Array): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate> {
		const errors: DecodeError[] = [];

		if (this._decoder === undefined) {
			this.addError(errors, 'Decoder freed or not initialized', 0, 0, 0, 0);
			logger.error('Decoder freed or not initialized');
			return {
				errors,
				pcmData: new Int16Array(0),
				channels: this._channels,
				samplesDecoded: 0,
				sampleRate: this._sampleRate,
			} as OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
		}

		this._input.buf.set(opusFrame);

		let samplesDecoded = this.wasm.opus_frame_decode(
			this._decoder,
			this._input.ptr,
			opusFrame.length,
			this._output.ptr,
			this._outputChannelSize,
			0,
		);

		if (samplesDecoded < 0) {
			const error = `libopus ${samplesDecoded} ${OpusDecoder.errors.get(samplesDecoded) || 'Unknown Error'}`;

			logger.error(error);

			this.addError(errors, error, opusFrame.length, this._frameNumber, this._inputBytes, this._outputSamples);

			samplesDecoded = 0;
		}

		this._frameNumber++;
		this._inputBytes += opusFrame.length;
		this._outputSamples += samplesDecoded;

		const outputBuf = new Int16Array(this._output.buf.subarray(0, samplesDecoded * this._channels));

		return {
			errors,
			pcmData: outputBuf,
			channels: this._channels,
			samplesDecoded,
			sampleRate: this._sampleRate,
		} as OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
	}

	conceal(
		opusFrame: Uint8Array | undefined,
		samplesToConceal: number,
	): OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate> {
		const errors: DecodeError[] = [];

		if (this._decoder === undefined) {
			this.addError(errors, 'Decoder freed or not initialized', 0, 0, 0, 0);
			logger.error('Decoder freed or not initialized');
			return {
				errors,
				pcmData: new Int16Array(0),
				channels: this._channels,
				samplesDecoded: 0,
				sampleRate: this._sampleRate,
			} as OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
		}

		if (samplesToConceal > this._outputChannelSize) {
			samplesToConceal = this._outputChannelSize;
		}
		let samplesDecoded: number;
		let inLength: number;
		if (opusFrame !== undefined) {
			// FEC decode
			this._input.buf.set(opusFrame);
			inLength = opusFrame.length;
			samplesDecoded = this.wasm.opus_frame_decode(this._decoder, this._input.ptr, opusFrame.length, this._output.ptr, samplesToConceal, 1);
		} else {
			// PLC decode
			inLength = 0;
			samplesDecoded = this.wasm.opus_frame_decode(this._decoder, 0, 0, this._output.ptr, samplesToConceal, 0);
		}

		if (samplesDecoded < 0) {
			const error = `libopus ${samplesDecoded} ${OpusDecoder.errors.get(samplesDecoded) || 'Unknown Error'}`;

			logger.error(error);

			this.addError(errors, error, inLength, this._frameNumber, this._inputBytes, this._outputSamples);

			samplesDecoded = 0;
		}

		this._frameNumber++;
		this._inputBytes += inLength;
		this._outputSamples += samplesDecoded;

		const outputBuf = new Int16Array(this._output.buf.subarray(0, samplesDecoded * this._channels));

		return {
			errors,
			pcmData: outputBuf,
			channels: this._channels,
			samplesDecoded,
			sampleRate: this._sampleRate,
		} as OpusDecodedAudio<SampleRate extends undefined ? OpusDecoderDefaultSampleRate : SampleRate>;
	}
}
