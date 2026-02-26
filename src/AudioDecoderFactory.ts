import type { AudioFormat } from './backends/TranscriptionBackend';
import type { AudioDecoder } from './AudioDecoder';
import { OpusAudioDecoder } from './OpusDecoder/OpusAudioDecoder';
import { type OpusDecoderSampleRate } from './OpusDecoder/OpusDecoder';
import { PassThroughDecoder } from './PassThroughDecoder';
import { L16Decoder } from './L16Decoder';

/**
 * Create an audio decoder appropriate for converting from inputFormat to outputFormat.
 * Returns a PassThroughDecoder when the output is raw Opus or Ogg (no decoding needed),
 * an L16Decoder when the input is already PCM (resampling if rates differ),
 * or an OpusAudioDecoder when the input is Opus and PCM output is needed.
 */
export function createAudioDecoder(inputFormat: AudioFormat, outputFormat: AudioFormat): AudioDecoder {
	if (outputFormat.encoding === 'opus' || outputFormat.encoding === 'ogg') {
		return new PassThroughDecoder();
	}
	if (inputFormat.encoding === 'L16') {
		const inputSampleRate = inputFormat.sampleRate ?? 24000;
		const outputSampleRate = outputFormat.sampleRate ?? 24000;
		return new L16Decoder(inputSampleRate, outputSampleRate);
	}
	if (inputFormat.encoding !== 'opus') {
		throw new Error(`Unsupported input encoding '${inputFormat.encoding}': only 'opus' or 'L16' is supported for PCM output`);
	}
	const sampleRate = (outputFormat.sampleRate ?? 24000) as OpusDecoderSampleRate;
	return new OpusAudioDecoder(sampleRate);
}
