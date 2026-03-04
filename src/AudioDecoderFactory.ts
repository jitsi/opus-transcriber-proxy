import type { AudioFormat } from './AudioFormat';
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
		if (inputFormat.encoding !== outputFormat.encoding) {
			throw new Error(
				`Cannot pass through '${inputFormat.encoding}' input as '${outputFormat.encoding}' output: encodings must match for pass-through`,
			);
		}
		return new PassThroughDecoder();
	}
	if (inputFormat.encoding === 'l16') {
		const inputSampleRate = inputFormat.sampleRate ?? 24000;
		const outputSampleRate = outputFormat.sampleRate ?? 24000;
		return new L16Decoder(inputSampleRate, outputSampleRate);
	}
	if (inputFormat.encoding === 'ogg') {
		throw new Error(`ogg-opus input cannot be decoded to PCM: no Ogg container demuxer is available. Use a backend that accepts raw Ogg (e.g. Deepgram with DEEPGRAM_ENCODING=opus), or send raw opus frames instead.`);
	}
	if (inputFormat.encoding !== 'opus') {
		throw new Error(`Unsupported input encoding '${inputFormat.encoding}': only 'opus' or 'l16' is supported for PCM output`);
	}
	const sampleRate = (outputFormat.sampleRate ?? 24000) as OpusDecoderSampleRate;
	return new OpusAudioDecoder(sampleRate);
}
