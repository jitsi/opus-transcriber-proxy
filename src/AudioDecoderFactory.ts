import type { AudioFormat } from './backends/TranscriptionBackend';
import type { AudioDecoder } from './AudioDecoder';
import { OpusAudioDecoder } from './OpusDecoder/OpusAudioDecoder';
import { type OpusDecoderSampleRate } from './OpusDecoder/OpusDecoder';
import { PassThroughDecoder } from './PassThroughDecoder';

/**
 * Create an audio decoder appropriate for converting from inputFormat to outputFormat.
 * Returns a PassThroughDecoder when the output is raw Opus or Ogg (no decoding needed),
 * or an OpusAudioDecoder when the output is PCM (L16).
 */
export function createAudioDecoder(inputFormat: AudioFormat, outputFormat: AudioFormat): AudioDecoder {
	if (outputFormat.encoding === 'opus' || outputFormat.encoding === 'ogg') {
		return new PassThroughDecoder();
	}
	if (inputFormat.encoding !== 'opus') {
		throw new Error(`Unsupported input encoding '${inputFormat.encoding}': only 'opus' is supported for PCM output`);
	}
	const sampleRate = (outputFormat.sampleRate ?? 24000) as OpusDecoderSampleRate;
	return new OpusAudioDecoder(sampleRate);
}
