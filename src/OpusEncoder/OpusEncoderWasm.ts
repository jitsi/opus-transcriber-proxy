import logger from '../logger';
import type { IOpusEncoder, OpusEncoderConfig } from './opusEncoderTypes';

/**
 * The Emscripten module factory (`opus-encoder.cjs` glue) + compiled `WebAssembly.Module`, injected
 * via {@link provideEncoderWasm} — Node reads them from disk, a Worker imports them. Keeps this
 * shared encode logic free of `fs` so it can run in a Cloudflare Worker.
 */
export type EmscriptenModuleFactory = (opts: {
	instantiateWasm: (info: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => WebAssembly.Exports;
}) => Promise<any>;

let glueFactory: EmscriptenModuleFactory | undefined;
let wasm: WebAssembly.Module | undefined;

export function provideEncoderWasm(factory: EmscriptenModuleFactory, module: WebAssembly.Module): void {
	glueFactory = factory;
	wasm = module;
}

// Shared zero-length buffer for "no leftover input" — never written to, so sharing is safe.
const EMPTY_INPUT = new Uint8Array(0);

interface OpusEncoderModule {
	_opus_frame_encoder_create: (sampleRate: number, channels: number, application: number) => number;
	_opus_frame_encoder_get_frame_size: (ctx: number) => number;
	_opus_frame_encode: (ctx: number, pcmData: number, pcmLength: number, outputBuffer: number, outputBufferSize: number) => number;
	_opus_frame_encoder_destroy: (ctx: number) => void;
	_opus_frame_encoder_set_bitrate: (ctx: number, bitrate: number) => number;
	_opus_frame_encoder_set_complexity: (ctx: number, complexity: number) => number;
	_malloc: (size: number) => number;
	_free: (ptr: number) => void;
	HEAPU8: Uint8Array;
}

const APPLICATION_TYPES = {
	voip: 2048, // OPUS_APPLICATION_VOIP
	audio: 2049, // OPUS_APPLICATION_AUDIO
	restricted_lowdelay: 2051, // OPUS_APPLICATION_RESTRICTED_LOWDELAY
};

export class OpusEncoderWasm implements IOpusEncoder {
	private module: OpusEncoderModule | null = null;
	private ctx: number = 0;
	private config: Required<OpusEncoderConfig>;
	private frameSize: number = 0;
	private pcmBuffer: Uint8Array | null = null;
	private outputBuffer: Uint8Array | null = null;
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
		if (glueFactory === undefined || wasm === undefined) {
			throw new Error('Opus WASM encoder binding not provided (call provideEncoderWasm)');
		}
		const module = wasm;
		this.module = (await glueFactory({
			instantiateWasm(info: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
				const instance = new WebAssembly.Instance(module, info);
				receive(instance);
				return instance.exports;
			},
		})) as OpusEncoderModule;

		const application = APPLICATION_TYPES[this.config.application];

		this.ctx = this.module._opus_frame_encoder_create(this.config.sampleRate, this.config.channels, application);

		if (this.ctx === 0) {
			throw new Error('Failed to create Opus encoder');
		}

		this.frameSize = this.module._opus_frame_encoder_get_frame_size(this.ctx);

		// opus_encoder_ctl returns OPUS_OK (0) on success, negative on error. A failure here means the
		// encoder silently keeps the codec default, so log it rather than swallowing it.
		const bitrateRet = this.module._opus_frame_encoder_set_bitrate(this.ctx, this.config.bitrate);
		if (bitrateRet < 0) logger.warn(`OpusEncoder: set_bitrate(${this.config.bitrate}) failed (${bitrateRet})`);
		const complexityRet = this.module._opus_frame_encoder_set_complexity(this.ctx, this.config.complexity);
		if (complexityRet < 0) logger.warn(`OpusEncoder: set_complexity(${this.config.complexity}) failed (${complexityRet})`);

		const maxPcmBytes = this.frameSize * this.config.channels * 2; // 16-bit samples
		this.pcmBuffer = new Uint8Array(this.module.HEAPU8.buffer, this.module._malloc(maxPcmBytes), maxPcmBytes);

		const maxOpusBytes = 4000;
		this.outputBuffer = new Uint8Array(this.module.HEAPU8.buffer, this.module._malloc(maxOpusBytes), maxOpusBytes);

		this.isReady = true;
	}

	encodeFrame(pcmData: Uint8Array): Uint8Array[] {
		if (!this.isReady || !this.module || !this.pcmBuffer || !this.outputBuffer) {
			throw new Error('Encoder not ready');
		}

		// Combine any unconsumed remainder from the previous call with the new input. In the common case
		// (nothing left over) we encode straight out of pcmData with no concat allocation.
		let input: Uint8Array;
		if (this.inputBuffer.length === 0) {
			input = pcmData;
		} else {
			input = new Uint8Array(this.inputBuffer.length + pcmData.length);
			input.set(this.inputBuffer);
			input.set(pcmData, this.inputBuffer.length);
		}

		const frameSizeBytes = this.getFrameSizeBytes();
		const encodedFrames: Uint8Array[] = [];
		let offset = 0;

		while (input.length - offset >= frameSizeBytes) {
			// subarray is a view (no copy); the copy into the WASM heap is the .set below.
			this.pcmBuffer.set(input.subarray(offset, offset + frameSizeBytes));

			const encodedBytes = this.module._opus_frame_encode(
				this.ctx,
				this.pcmBuffer.byteOffset,
				frameSizeBytes,
				this.outputBuffer.byteOffset,
				this.outputBuffer.length,
			);

			if (encodedBytes < 0) {
				const errorMessages: Record<string, string> = {
					'-1': 'OPUS_BAD_ARG: One or more invalid/out of range arguments',
					'-2': 'OPUS_BUFFER_TOO_SMALL: Not enough bytes allocated in the buffer',
					'-3': 'OPUS_INTERNAL_ERROR: An internal error was detected',
				};
				const errorMsg = errorMessages[encodedBytes.toString()] || `Unknown error code: ${encodedBytes}`;
				throw new Error(`Opus encoding failed: ${errorMsg}`);
			}

			// Must copy: outputBuffer is the reused WASM-heap view, overwritten on the next iteration/call.
			encodedFrames.push(new Uint8Array(this.outputBuffer.subarray(0, encodedBytes)));

			offset += frameSizeBytes;
		}

		// Retain only the unconsumed tail, in its own backing store (decoupled from pcmData / the merged
		// buffer so neither is kept alive). Empty when fully consumed — the common case.
		this.inputBuffer = offset < input.length ? input.slice(offset) : EMPTY_INPUT;

		return encodedFrames;
	}

	free(): void {
		if (this.module && this.ctx) {
			if (this.pcmBuffer) {
				this.module._free(this.pcmBuffer.byteOffset);
			}
			if (this.outputBuffer) {
				this.module._free(this.outputBuffer.byteOffset);
			}
			this.module._opus_frame_encoder_destroy(this.ctx);
			this.ctx = 0;
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
