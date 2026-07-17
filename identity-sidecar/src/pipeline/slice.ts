/** Extract [startSec, endSec) of a mono PCM float buffer as a copy. */
export function slicePcm(audio: Float32Array, startSec: number, endSec: number, sampleRate = 16000): Float32Array {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(audio.length, Math.round(endSec * sampleRate));
  if (end <= start) return new Float32Array(0);
  return audio.slice(start, end);
}
