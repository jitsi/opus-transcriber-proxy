import sherpa from 'sherpa-onnx-node';

export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized -> dot == cosine
}

export interface Embedder {
  embed(audio: Float32Array): Promise<Float32Array>;
  readonly dim: number;
}

export function createEmbedder(modelPath: string): Embedder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extractor = new (sherpa as any).SpeakerEmbeddingExtractor({
    model: modelPath,
    numThreads: 1,
    debug: false,
  });
  return {
    get dim(): number {
      return extractor.dim;
    },
    async embed(audio: Float32Array): Promise<Float32Array> {
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: audio });
      const v = extractor.compute(stream);
      return l2normalize(Float32Array.from(v));
    },
  };
}
