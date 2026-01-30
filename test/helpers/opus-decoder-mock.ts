/**
 * OpusDecoder mock for testing
 * Mocks the WASM-based OpusDecoder without loading the actual WASM module
 */

import type {
	OpusDecoderSampleRate,
	OpusDecodedAudio,
	DecodeError,
} from '../../src/OpusDecoder/OpusDecoder';
import { TEST_PCM_DATA } from './test-data';

export interface MockOpusDecoderOptions<SampleRate extends OpusDecoderSampleRate = 24000> {
	sampleRate?: SampleRate;
	channels?: number;
	autoResolveReady?: boolean;
	decodeResult?: OpusDecodedAudio;
	decodeError?: DecodeError;
	concealResult?: OpusDecodedAudio;
	concealError?: DecodeError;
}

export class MockOpusDecoder<SampleRate extends OpusDecoderSampleRate = 24000> {
	private _ready: Promise<void>;
	private _sampleRate: SampleRate;
	private _channels: number;
	private _isFreed: boolean = false;
	private _decodeCallCount: number = 0;
	private _concealCallCount: number = 0;
	private _resetCallCount: number = 0;
	private _decodeResult?: OpusDecodedAudio;
	private _decodeError?: DecodeError;
	private _concealResult?: OpusDecodedAudio;
	private _concealError?: DecodeError;
	private _resolveReady?: () => void;
	private _rejectReady?: (error: Error) => void;

	constructor(options: MockOpusDecoderOptions<SampleRate> = {}) {
		this._sampleRate = (options.sampleRate || 24000) as SampleRate;
		this._channels = options.channels || 1;
		this._decodeResult = options.decodeResult;
		this._decodeError = options.decodeError;
		this._concealResult = options.concealResult;
		this._concealError = options.concealError;

		// Create a ready promise that can be resolved manually
		this._ready = new Promise((resolve, reject) => {
			this._resolveReady = resolve;
			this._rejectReady = reject;

			// Auto-resolve if requested
			if (options.autoResolveReady !== false) {
				setImmediate(() => resolve());
			}
		});
	}

	get ready(): Promise<void> {
		return this._ready;
	}

	/**
	 * Mock decodeFrame
	 */
	decodeFrame(opusFrame: Uint8Array): OpusDecodedAudio {
		if (this._isFreed) {
			const error: DecodeError = {
				message: 'Decoder freed or not initialized',
				frameLength: 0,
				frameNumber: 0,
				inputBytes: 0,
				outputSamples: 0,
			};
			return {
				errors: [error],
				pcmData: new Int16Array(0),
				channels: this._channels,
				samplesDecoded: 0,
				sampleRate: this._sampleRate,
			};
		}

		this._decodeCallCount++;

		// If specific result/error is set, use it
		if (this._decodeError) {
			return {
				errors: [this._decodeError],
				pcmData: new Int16Array(0),
				channels: this._channels,
				samplesDecoded: 0,
				sampleRate: this._sampleRate,
			};
		}

		if (this._decodeResult) {
			return this._decodeResult;
		}

		// Default: return valid decoded audio (480 samples = 20ms at 24kHz)
		const samplesDecoded = 480;
		const pcmData = TEST_PCM_DATA.silence_1sec.slice(0, samplesDecoded);

		return {
			errors: [],
			pcmData,
			channels: this._channels,
			samplesDecoded,
			sampleRate: this._sampleRate,
		};
	}

	/**
	 * Mock conceal (loss concealment)
	 */
	conceal(opusFrame: Uint8Array | undefined, samplesToConceal: number): OpusDecodedAudio {
		if (this._isFreed) {
			const error: DecodeError = {
				message: 'Decoder freed or not initialized',
				frameLength: 0,
				frameNumber: 0,
				inputBytes: 0,
				outputSamples: 0,
			};
			return {
				errors: [error],
				pcmData: new Int16Array(0),
				channels: this._channels,
				samplesDecoded: 0,
				sampleRate: this._sampleRate,
			};
		}

		this._concealCallCount++;

		// If specific result/error is set, use it
		if (this._concealError) {
			return {
				errors: [this._concealError],
				pcmData: new Int16Array(0),
				channels: this._channels,
				samplesDecoded: 0,
				sampleRate: this._sampleRate,
			};
		}

		if (this._concealResult) {
			return this._concealResult;
		}

		// Default: return concealed audio
		const samplesDecoded = Math.min(samplesToConceal, 5760); // Max 120ms at 48kHz
		const pcmData = TEST_PCM_DATA.silence_1sec.slice(0, samplesDecoded);

		return {
			errors: [],
			pcmData,
			channels: this._channels,
			samplesDecoded,
			sampleRate: this._sampleRate,
		};
	}

	/**
	 * Mock reset
	 */
	reset(): void {
		if (this._isFreed) {
			throw new Error('Decoder freed or not initialized');
		}
		this._resetCallCount++;
	}

	/**
	 * Mock free
	 */
	free(): void {
		this._isFreed = true;
		this._decodeCallCount = 0;
		this._concealCallCount = 0;
		this._resetCallCount = 0;
	}

	// Test helper methods

	/**
	 * Manually resolve the ready promise
	 */
	resolveReady(): void {
		if (this._resolveReady) {
			this._resolveReady();
		}
	}

	/**
	 * Manually reject the ready promise
	 */
	rejectReady(error: Error): void {
		if (this._rejectReady) {
			this._rejectReady(error);
		}
	}

	/**
	 * Set decode result for subsequent calls
	 */
	setDecodeResult(result: OpusDecodedAudio): void {
		this._decodeResult = result;
		this._decodeError = undefined;
	}

	/**
	 * Set decode error for subsequent calls
	 */
	setDecodeError(error: DecodeError): void {
		this._decodeError = error;
		this._decodeResult = undefined;
	}

	/**
	 * Set conceal result for subsequent calls
	 */
	setConcealResult(result: OpusDecodedAudio): void {
		this._concealResult = result;
		this._concealError = undefined;
	}

	/**
	 * Set conceal error for subsequent calls
	 */
	setConcealError(error: DecodeError): void {
		this._concealError = error;
		this._concealResult = undefined;
	}

	/**
	 * Get decode call count
	 */
	getDecodeCallCount(): number {
		return this._decodeCallCount;
	}

	/**
	 * Get conceal call count
	 */
	getConcealCallCount(): number {
		return this._concealCallCount;
	}

	/**
	 * Get reset call count
	 */
	getResetCallCount(): number {
		return this._resetCallCount;
	}

	/**
	 * Check if decoder is freed
	 */
	isFreed(): boolean {
		return this._isFreed;
	}

	/**
	 * Clear all call counts
	 */
	clearCallCounts(): void {
		this._decodeCallCount = 0;
		this._concealCallCount = 0;
		this._resetCallCount = 0;
	}
}

/**
 * Factory function to create a MockOpusDecoder
 */
export function createMockOpusDecoder<SampleRate extends OpusDecoderSampleRate = 24000>(
	options: MockOpusDecoderOptions<SampleRate> = {},
): MockOpusDecoder<SampleRate> {
	return new MockOpusDecoder<SampleRate>(options);
}
