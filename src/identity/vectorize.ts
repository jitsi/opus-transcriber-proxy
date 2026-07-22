// Cloudflare Vectorize v2 REST store for speaker fingerprints (CAM++ 192-dim, cosine).
// Ported from the identity-sidecar so the embedding/match runs in-process in the transcriber
// container (no sidecar hop). Uses global fetch (Node 22).

export interface Fingerprint {
	identity: string;
	vector: Float32Array;
	name?: string;
}

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

/** Vectorize caps topK at 50 when returning values. */
export class VectorizeStore {
	private base: string;
	private fetch: typeof fetch;
	private dimensions: number;
	constructor(private o: VectorizeOpts) {
		this.base = `https://api.cloudflare.com/client/v4/accounts/${o.accountId}/vectorize/v2/indexes/${o.indexName}`;
		this.fetch = o.fetchImpl ?? fetch.bind(globalThis);
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
		return (json as any).result;
	}

	/** The v2 upsert endpoint takes NDJSON (one vector object per line); application/json 400s. */
	private async upsertNdjson(rows: unknown[]): Promise<void> {
		const res = await this.fetch(`${this.base}/upsert`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.o.apiToken}`, 'Content-Type': 'application/x-ndjson' },
			body: rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
		});
		if (!res.ok) throw new Error(`vectorize upsert failed: ${res.status}`);
	}

	/**
	 * Vector storage key. Fingerprints are scoped per tenant so the same person (same identity, e.g.
	 * an email) enrolled under two tenants keeps two independent vectors — otherwise one tenant's
	 * enroll merges into and rewrites the other's (`get_by_ids`/`delete` don't filter by tenant, only
	 * `query` does). The bare identity is preserved in metadata and returned from `query`. JIT-16065.
	 */
	private key(tenant: string, identity: string): string {
		return `${tenant}:${identity}`;
	}

	async upsert(tenant: string, identity: string, vector: Float32Array, name?: string): Promise<void> {
		const id = this.key(tenant, identity);
		const existing = await this.call('get_by_ids', { ids: [id], returnValues: true, returnMetadata: 'all' });
		const prev = existing?.[0];
		let merged = vector;
		let n = 1;
		let prevName: string | undefined;
		if (prev?.values) {
			const pv = Float32Array.from(prev.values as number[]);
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
				id,
				values,
				metadata: { identity, tenant, sampleCount: n, name: name ?? prevName, updatedAt: new Date().toISOString() },
			},
		]);
	}

	async query(tenant: string, probe?: Float32Array): Promise<Fingerprint[]> {
		const topK = 50;
		const vector = probe && probe.length ? Array.from(probe) : new Array(this.dimensions).fill(0);
		const result = await this.call('query', { vector, topK, returnValues: true, returnMetadata: 'all', filter: { tenant } });
		const matches = result?.matches ?? [];
		// Return the bare identity (from metadata), not the tenant-scoped row id.
		return matches.map((m: any) => ({
			identity: m.metadata?.identity ?? m.id,
			vector: Float32Array.from(m.values),
			name: m.metadata?.name,
		}));
	}

	async delete(tenant: string, identity: string): Promise<void> {
		await this.call('delete_by_ids', { ids: [this.key(tenant, identity)] });
	}
}
