// Pure vector helpers for speaker embeddings — no native deps (safe to import anywhere).

export function pcm16ToFloat32(pcm: Buffer): Float32Array {
	const n = Math.floor(pcm.length / 2);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
	return out;
}

export function l2normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
	const norm = Math.sqrt(sum) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
	return out;
}

/** Cosine similarity. Inputs are expected L2-normalized, so this is just the dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}
