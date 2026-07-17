import { FingerprintStore } from './FingerprintStore.js';

interface Entry {
  tenant: string;
  vector: Float32Array;
  n: number;
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

/** In-memory store keeping a rolling centroid per (tenant, identity). */
export class MemoryStore implements FingerprintStore {
  private byIdentity = new Map<string, Entry>();

  async upsert(tenant: string, identity: string, vector: Float32Array): Promise<void> {
    const prev = this.byIdentity.get(identity);
    if (!prev) {
      this.byIdentity.set(identity, { tenant, vector: normalize(vector), n: 1 });
      return;
    }
    const merged = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) merged[i] = (prev.vector[i] * prev.n + vector[i]) / (prev.n + 1);
    this.byIdentity.set(identity, { tenant, vector: normalize(merged), n: prev.n + 1 });
  }

  async query(tenant: string): Promise<{ identity: string; vector: Float32Array }[]> {
    const out: { identity: string; vector: Float32Array }[] = [];
    for (const [identity, e] of this.byIdentity) if (e.tenant === tenant) out.push({ identity, vector: e.vector });
    return out;
  }

  async delete(identity: string): Promise<void> {
    this.byIdentity.delete(identity);
  }
}
