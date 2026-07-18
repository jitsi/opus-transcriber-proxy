import { FingerprintStore, Fingerprint } from './FingerprintStore.js';

interface Entry {
  tenant: string;
  vector: Float32Array;
  n: number;
  name?: string;
}

// Soft cap on the rolling-centroid sample weight: new audio always keeps >= 1/CAP
// weight, so the fingerprint keeps adapting to drift instead of freezing.
const SAMPLE_WEIGHT_CAP = 50;

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

/** In-memory store keeping a soft-capped rolling centroid per (tenant, identity). */
export class MemoryStore implements FingerprintStore {
  private byIdentity = new Map<string, Entry>();

  async upsert(tenant: string, identity: string, vector: Float32Array, name?: string): Promise<void> {
    const prev = this.byIdentity.get(identity);
    if (!prev) {
      this.byIdentity.set(identity, { tenant, vector: normalize(vector), n: 1, name });
      return;
    }
    const n = Math.min(prev.n, SAMPLE_WEIGHT_CAP);
    const merged = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) merged[i] = (prev.vector[i] * n + vector[i]) / (n + 1);
    this.byIdentity.set(identity, {
      tenant,
      vector: normalize(merged),
      n: prev.n + 1,
      name: name ?? prev.name,
    });
  }

  async query(tenant: string, _probe?: Float32Array): Promise<Fingerprint[]> {
    const out: Fingerprint[] = [];
    for (const [identity, e] of this.byIdentity) if (e.tenant === tenant) out.push({ identity, vector: e.vector, name: e.name });
    return out;
  }

  async delete(identity: string): Promise<void> {
    this.byIdentity.delete(identity);
  }
}
