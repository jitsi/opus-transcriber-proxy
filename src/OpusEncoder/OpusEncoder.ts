/**
 * OpusEncoder - Encodes PCM audio to Opus format using WASM
 */

// Provide Node.js globals for emscripten module
if (typeof globalThis.__filename === 'undefined') {
	globalThis.__filename = './opus-encoder.js';
}
if (typeof globalThis.__dirname === 'undefined') {
	globalThis.__dirname = '.';
}

import OpusEncoderModuleFactory from '../../dist/opus-encoder.js';
// @ts-ignore
import wasmBinary from '../../dist/opus-encoder.wasm';

type SampleRate = 8000 | 12000 | 16000 | 24000 | 48000;

export interface OpusEncoderConfig {
	sampleRate: SampleRate;
	channels: 1 | 2;
	application?: 'voip' | 'audio' | 'restricted_lowdelay';
	bitrate?: number;
	complexity?: number; // 0-10
}

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

export class OpusEncoder<SR extends SampleRate> {
	private module: OpusEncoderModule | null = null;
	private ctx: number = 0;
	private config: Required<OpusEncoderConfig>;
	private frameSize: number = 0;
	private pcmBuffer: Uint8Array | null = null;
	private outputBuffer: Uint8Array | null = null;
	private isReady: boolean = false;
	private inputBuffer: Uint8Array = new Uint8Array(0); // Buffer for accumulating partial frames

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
		try {
			// Initialize the WASM module
			this.module = (await OpusEncoderModuleFactory({
				instantiateWasm(info: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
					try {
						const instance = new WebAssembly.Instance(wasmBinary, info);
						receive(instance);
						return instance.exports;
					} catch (error) {
						console.error('Failed to instantiate WASM:', error);
						throw error;
					}
				},
			})) as OpusEncoderModule;

			const application = APPLICATION_TYPES[this.config.application];

			// Create the encoder context
			this.ctx = this.module._opus_frame_encoder_create(this.config.sampleRate, this.config.channels, application);

			if (this.ctx === 0) {
				throw new Error('Failed to create Opus encoder');
			}

			// Get frame size
			this.frameSize = this.module._opus_frame_encoder_get_frame_size(this.ctx);

			// Set bitrate
			this.module._opus_frame_encoder_set_bitrate(this.ctx, this.config.bitrate);

			// Set complexity
			this.module._opus_frame_encoder_set_complexity(this.ctx, this.config.complexity);

			// Allocate buffers
			const maxPcmBytes = this.frameSize * this.config.channels * 2; // 16-bit samples
			this.pcmBuffer = new Uint8Array(this.module.HEAPU8.buffer, this.module._malloc(maxPcmBytes), maxPcmBytes);

			// Max Opus frame is typically ~1500 bytes
			const maxOpusBytes = 4000;
			this.outputBuffer = new Uint8Array(this.module.HEAPU8.buffer, this.module._malloc(maxOpusBytes), maxOpusBytes);

			this.isReady = true;
		} catch (error) {
			throw new Error(`Failed to initialize Opus encoder: ${error}`);
		}
	}

	/**
	 * Encode PCM audio to Opus, handling variable-sized input
	 * @param pcmData - PCM16 audio data (Int16Array or base64 string)
	 * @returns Array of encoded Opus frames
	 */
	encodeFrame(pcmData: Int16Array | string): Uint8Array[] {
		if (!this.isReady || !this.module || !this.pcmBuffer || !this.outputBuffer) {
			throw new Error('Encoder not ready');
		}

		let pcmBytes: Uint8Array;

		if (typeof pcmData === 'string') {
			console.log(`[OpusEncoder] Decoding base64 string, length: ${pcmData.length}`);
			// Decode base64 to bytes
			pcmBytes = Uint8Array.fromBase64(pcmData);
			console.log(`[OpusEncoder] Decoded to ${pcmBytes.length} bytes`);
		} else {
			// Convert Int16Array to Uint8Array
			pcmBytes = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
			console.log(`[OpusEncoder] Using Int16Array, ${pcmBytes.length} bytes`);
		}

		// Append to input buffer
		const newBuffer = new Uint8Array(this.inputBuffer.length + pcmBytes.length);
		newBuffer.set(this.inputBuffer);
		newBuffer.set(pcmBytes, this.inputBuffer.length);
		this.inputBuffer = newBuffer;

		const frameSizeBytes = this.getFrameSizeBytes();
		console.log(`[OpusEncoder] Buffer now has ${this.inputBuffer.length} bytes, frame needs ${frameSizeBytes} bytes`);

		const encodedFrames: Uint8Array[] = [];

		// Encode all complete frames in the buffer
		while (this.inputBuffer.length >= frameSizeBytes) {
			// Extract one frame worth of data
			const frameData = this.inputBuffer.subarray(0, frameSizeBytes);

			// Copy to WASM memory
			this.pcmBuffer.set(frameData);

			// Encode
			const encodedBytes = this.module._opus_frame_encode(
				this.ctx,
				this.pcmBuffer.byteOffset,
				frameSizeBytes,
				this.outputBuffer.byteOffset,
				this.outputBuffer.length,
			);

			if (encodedBytes < 0) {
				const errorMessages: Record<number, string> = {
					'-1': 'OPUS_BAD_ARG: One or more invalid/out of range arguments',
					'-2': 'OPUS_BUFFER_TOO_SMALL: Not enough bytes allocated in the buffer',
					'-3': 'OPUS_INTERNAL_ERROR: An internal error was detected',
				};
				const errorMsg = errorMessages[encodedBytes.toString()] || `Unknown error code: ${encodedBytes}`;
				throw new Error(`Opus encoding failed: ${errorMsg}`);
			}

			console.log(`[OpusEncoder] Encoded frame: ${encodedBytes} bytes`);

			// Store the encoded frame
			encodedFrames.push(new Uint8Array(this.outputBuffer.subarray(0, encodedBytes)));

			// Remove the processed frame from the buffer
			this.inputBuffer = this.inputBuffer.subarray(frameSizeBytes);
		}

		console.log(`[OpusEncoder] Encoded ${encodedFrames.length} frames, ${this.inputBuffer.length} bytes remaining in buffer`);

		return encodedFrames;
	}

	/**
	 * Free WASM resources
	 */
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

	/**
	 * Get the frame size in samples per channel
	 */
	getFrameSize(): number {
		return this.frameSize;
	}

	/**
	 * Get the frame size in bytes for the configured channels
	 */
	getFrameSizeBytes(): number {
		return this.frameSize * this.config.channels * 2; // 16-bit samples
	}
}
