// Shared types and the common interface for the low-level Opus encoder, implemented by both the
// native (libopus N-API addon) and WASM (Emscripten) backends. The OpusEncoder facade picks one at
// runtime (see OpusEncoder.ts).

export type OpusEncoderSampleRate = 8000 | 12000 | 16000 | 24000 | 48000;

export interface OpusEncoderConfig {
	sampleRate: OpusEncoderSampleRate;
	channels: 1 | 2;
	application?: 'voip' | 'audio' | 'restricted_lowdelay';
	bitrate?: number;
	complexity?: number; // 0-10
}

/** The surface both backends implement and the facade delegates to. */
export interface IOpusEncoder {
	readonly ready: Promise<void>;
	encodeFrame(pcmData: Uint8Array): Uint8Array[];
	getFrameSize(): number;
	getFrameSizeBytes(): number;
	free(): void;
}
