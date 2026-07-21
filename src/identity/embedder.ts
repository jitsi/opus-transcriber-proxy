import { l2normalize } from './vecmath';

// CAM++ (3D-Speaker) speaker-embedding extractor via sherpa-onnx-node (native addon).
// Imported ONLY lazily (dynamic import from LocalIdentityClient) so the native library is never
// loaded when the identity feature is off, and never enters the Worker bundle (container-only).

export interface Embedder {
	embed(audio: Float32Array): Promise<Float32Array>;
	readonly dim: number;
}

export async function createEmbedder(modelPath: string): Promise<Embedder> {
	const sherpa = (await import('sherpa-onnx-node')).default as any;
	const extractor = new sherpa.SpeakerEmbeddingExtractor({
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
