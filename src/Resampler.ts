/**
 * PCM16 resampler using linear interpolation.
 * Based on the resampler in cf-transcriber-worker/src/audio-utils.ts.
 *
 * Operates directly on Uint8Array (little-endian PCM16, mono) to avoid
 * the base64 encoding/decoding overhead of the original implementation.
 *
 * @param frame - Raw PCM16 bytes (little-endian, mono)
 * @param inputRate - Input sample rate in Hz
 * @param outputRate - Output sample rate in Hz
 * @returns Resampled PCM16 bytes (little-endian), or the original frame if rates match
 */
export function resamplePCM16(frame: Uint8Array, inputRate: number, outputRate: number): Uint8Array {
	if (inputRate === outputRate) {
		return frame;
	}

	const inView = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const inputSamples = frame.byteLength / 2;
	const outputSamples = Math.floor(inputSamples * outputRate / inputRate);

	const output = new Uint8Array(outputSamples * 2);
	const outView = new DataView(output.buffer);

	for (let i = 0; i < outputSamples; i++) {
		const srcIndex = (i * inputRate) / outputRate;
		const srcFloor = Math.floor(srcIndex);
		const srcCeil = Math.min(srcFloor + 1, inputSamples - 1);
		const t = srcIndex - srcFloor;

		const a = inView.getInt16(srcFloor * 2, true);
		const b = inView.getInt16(srcCeil * 2, true);
		outView.setInt16(i * 2, Math.round(a + (b - a) * t), true);
	}

	return output;
}
