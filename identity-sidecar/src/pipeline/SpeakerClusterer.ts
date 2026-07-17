function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

interface Cluster {
  id: number;
  vector: Float32Array; // normalized centroid
  n: number;
}

/**
 * Online agglomerative clustering: assign an embedding to the nearest
 * existing cluster if cosine >= threshold, else start a new cluster.
 * Cluster ids are stable and monotonically increasing per instance, so a
 * given speaker keeps its id across chunks within one session/stream.
 */
export class SpeakerClusterer {
  private clusters: Cluster[] = [];
  private next = 0;
  constructor(private threshold: number) {}

  assign(vector: Float32Array): number {
    const v = normalize(vector);
    let best: Cluster | null = null;
    let bestScore = -Infinity;
    for (const c of this.clusters) {
      const s = cosine(v, c.vector);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best && bestScore >= this.threshold) {
      const merged = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) merged[i] = (best.vector[i] * best.n + v[i]) / (best.n + 1);
      best.vector = normalize(merged);
      best.n += 1;
      return best.id;
    }
    const id = this.next++;
    this.clusters.push({ id, vector: v, n: 1 });
    return id;
  }

  getCentroid(id: number): Float32Array | undefined {
    return this.clusters.find((c) => c.id === id)?.vector;
  }

  clusterCount(): number {
    return this.clusters.length;
  }
}
