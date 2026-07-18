import { FingerprintStore, Fingerprint } from './FingerprintStore.js';

const SAMPLE_WEIGHT_CAP = 50;

export interface VectorizeOpts {
  accountId: string;
  indexName: string;
  apiToken: string;
  /** Index dimensionality (CAM++ = 192). Used only for the fallback neutral query vector. */
  dimensions?: number;
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
  private dimensions: number;
  constructor(private o: VectorizeOpts) {
    this.base = `https://api.cloudflare.com/client/v4/accounts/${o.accountId}/vectorize/v2/indexes/${o.indexName}`;
    this.fetch = o.fetchImpl ?? fetch;
    this.dimensions = o.dimensions ?? 192;
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

  /** The v2 upsert/insert endpoints take NDJSON (one vector object per line), NOT a JSON object —
   *  sending application/json 400s. Everything else (query/get_by_ids/delete_by_ids) is JSON. */
  private async upsertNdjson(rows: unknown[]): Promise<void> {
    const res = await this.fetch(`${this.base}/upsert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.o.apiToken}`, 'Content-Type': 'application/x-ndjson' },
      body: rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    });
    if (!res.ok) throw new Error(`vectorize upsert failed: ${res.status}`);
  }

  async upsert(tenant: string, identity: string, vector: Float32Array, name?: string): Promise<void> {
    // v2 get_by_ids returns an array of {id, values, metadata}, but only includes `values`/`metadata`
    // when explicitly requested — without them the rolling centroid can never read its prior state.
    const existing = await this.call('get_by_ids', { ids: [identity], returnValues: true, returnMetadata: 'all' });
    const prev = existing?.[0];
    let merged = vector;
    let n = 1;
    let prevName: string | undefined;
    if (prev?.values) {
      const pv = Float32Array.from(prev.values);
      const prevN = Number(prev.metadata?.sampleCount ?? 1);
      const w = Math.min(prevN, SAMPLE_WEIGHT_CAP);
      merged = new Float32Array(vector.length);
      for (let i = 0; i < vector.length; i++) merged[i] = (pv[i] * w + vector[i]) / (w + 1);
      n = prevN + 1;
      prevName = prev.metadata?.name;
    }
    const values = Array.from(normalize(merged));
    await this.upsertNdjson([
      {
        id: identity,
        values,
        metadata: { identity, tenant, sampleCount: n, name: name ?? prevName, updatedAt: new Date().toISOString() },
      },
    ]);
  }

  async query(tenant: string, probe?: Float32Array): Promise<Fingerprint[]> {
    const topK = 50; // Vectorize hard cap when returnValues=true
    // Vectorize is an ANN index — there is no "list all". Query with the probe embedding so the
    // nearest fingerprints come back (with values), then decideMatch re-scores locally. A neutral
    // zero vector returns nothing, so callers always pass the probe; the fallback exists only so a
    // probe-less call degrades to empty rather than a dimension error.
    const vector = probe && probe.length ? Array.from(probe) : new Array(this.dimensions).fill(0);
    const result = await this.call('query', {
      vector,
      topK,
      returnValues: true,
      returnMetadata: 'all',
      filter: { tenant },
    });
    const matches = result?.matches ?? [];
    if (matches.length === topK) console.warn(`vectorize query hit topK=${topK} for tenant ${tenant}; may be truncated`);
    return matches.map((m: any) => ({ identity: m.id, vector: Float32Array.from(m.values), name: m.metadata?.name }));
  }

  async delete(identity: string): Promise<void> {
    await this.call('delete_by_ids', { ids: [identity] });
  }
}
