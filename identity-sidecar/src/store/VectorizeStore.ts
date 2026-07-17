import { FingerprintStore } from './FingerprintStore.js';

export interface VectorizeOpts {
  accountId: string;
  indexName: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

/** Cloudflare Vectorize REST store. Vectorize caps topK at 50 when returning values. */
export class VectorizeStore implements FingerprintStore {
  private base: string;
  private fetch: typeof fetch;
  constructor(private o: VectorizeOpts) {
    this.base = `https://api.cloudflare.com/client/v4/accounts/${o.accountId}/vectorize/v2/indexes/${o.indexName}`;
    this.fetch = o.fetchImpl ?? fetch;
  }

  private async call(path: string, body: unknown): Promise<any> {
    const res = await this.fetch(`${this.base}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.o.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`vectorize ${path} failed: ${res.status}`);
    const json = await res.json();
    return json.result;
  }

  async upsert(tenant: string, identity: string, vector: Float32Array): Promise<void> {
    const existing = await this.call('getByIds', { ids: [identity] });
    const prev = existing?.vectors?.[0];
    let merged = vector;
    let n = 1;
    if (prev?.values) {
      const pv = Float32Array.from(prev.values);
      const pn = Number(prev.metadata?.sampleCount ?? 1);
      merged = new Float32Array(vector.length);
      for (let i = 0; i < vector.length; i++) merged[i] = (pv[i] * pn + vector[i]) / (pn + 1);
      n = pn + 1;
    }
    const values = Array.from(normalize(merged));
    await this.call('upsert', {
      id: identity,
      values,
      metadata: { identity, tenant, sampleCount: n, updatedAt: new Date().toISOString() },
    });
  }

  async query(tenant: string): Promise<{ identity: string; vector: Float32Array }[]> {
    const topK = 50; // Vectorize hard cap when returnValues=true
    const result = await this.call('query', {
      vector: new Array(1).fill(0), // neutral; length must match index dim in a live index
      topK,
      returnValues: true,
      returnMetadata: 'all',
      filter: { tenant },
    });
    const matches = result?.matches ?? [];
    if (matches.length === topK) console.warn(`vectorize query hit topK=${topK} for tenant ${tenant}; may be truncated`);
    return matches.map((m: any) => ({ identity: m.id, vector: Float32Array.from(m.values) }));
  }

  async delete(identity: string): Promise<void> {
    await this.call('delete_by_ids', { ids: [identity] });
  }
}
