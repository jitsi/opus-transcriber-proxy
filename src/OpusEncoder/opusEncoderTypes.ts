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
	/**
	 * Enable Opus DTX (discontinuous transmission). With DTX on, libopus's own VAD flags
	 * near-silence / comfort-noise frames as "in DTX" ([EncodedFrame.inDtx]), which callers use to
	 * tell real voice from silence. Requires VBR (the codec default). Off by default.
	 */
	dtx?: boolean;
}

/**
 * One encoded Opus frame plus whether libopus treated it as a DTX (discontinuous-transmission)
 * frame. When [OpusEncoderConfig.dtx] is disabled, [inDtx] is always false.
 */
export interface EncodedFrame {
	data: Uint8Array;
	inDtx: boolean;
	/**
	 * The RFC 6464 audio level of the PCM frame that was encoded (0 = full scale .. 127 = silence, in -dBov), for
	 * the ssrc-audio-level RTP header extension. Computed by both backends from the input PCM (see audioLevel.ts);
	 * libopus itself exposes no signal-level output.
	 */
	audioLevel: number;
}

/** The surface both backends implement and the facade delegates to. */
export interface IOpusEncoder {
	readonly ready: Promise<void>;
	encodeFrame(pcmData: Uint8Array): EncodedFrame[];
	getFrameSize(): number;
	getFrameSizeBytes(): number;
	free(): void;
}
