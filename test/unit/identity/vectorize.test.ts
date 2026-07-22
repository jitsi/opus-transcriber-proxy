import { describe, it, expect } from 'vitest';
import { VectorizeStore } from '../../../src/identity/vectorize';

// Capture the requests VectorizeStore makes so we can assert IDs are tenant-scoped.
function recordingFetch() {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    const path = String(url).split('/').pop() as string;
    const raw = init?.body ?? '';
    // upsert uses NDJSON, everything else JSON.
    const body = path === 'upsert' ? raw.trim().split('\n').map((l: string) => JSON.parse(l)) : JSON.parse(raw || '{}');
    calls.push({ path, body });
    // get_by_ids → no existing vector (fresh); query → one match; others → ok.
    const result =
      path === 'get_by_ids' ? [] : path === 'query' ? { matches: [{ id: 'tenantA:alice@x.com', values: [1, 0, 0], metadata: { identity: 'alice@x.com', name: 'Alice' } }] } : {};
    return { ok: true, status: 200, json: async () => ({ result }) } as any;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const store = (fetchImpl: typeof fetch) =>
  new VectorizeStore({ accountId: 'acc', indexName: 'idx', apiToken: 'tok', dimensions: 3, fetchImpl });

describe('VectorizeStore tenant scoping', () => {
  it('upsert keys the vector id as `${tenant}:${identity}` and keeps the bare identity in metadata', async () => {
    const { calls, fetchImpl } = recordingFetch();
    await store(fetchImpl).upsert('tenantA', 'alice@x.com', Float32Array.from([1, 0, 0]), 'Alice');

    const get = calls.find((c) => c.path === 'get_by_ids')!;
    expect(get.body.ids).toEqual(['tenantA:alice@x.com']); // scoped lookup, not the bare email

    const upsert = calls.find((c) => c.path === 'upsert')!;
    expect(upsert.body[0].id).toBe('tenantA:alice@x.com'); // scoped storage key
    expect(upsert.body[0].metadata.identity).toBe('alice@x.com'); // bare identity preserved
    expect(upsert.body[0].metadata.tenant).toBe('tenantA');
  });

  it('the same identity under two tenants writes two distinct vectors (no cross-tenant clobber)', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const s = store(fetchImpl);
    await s.upsert('tenantA', 'alice@x.com', Float32Array.from([1, 0, 0]));
    await s.upsert('tenantB', 'alice@x.com', Float32Array.from([0, 1, 0]));
    const ids = calls.filter((c) => c.path === 'upsert').map((c) => c.body[0].id);
    expect(ids).toEqual(['tenantA:alice@x.com', 'tenantB:alice@x.com']);
  });

  it('query filters by tenant and returns the bare identity (not the scoped row id)', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const res = await store(fetchImpl).query('tenantA', Float32Array.from([1, 0, 0]));
    const q = calls.find((c) => c.path === 'query')!;
    expect(q.body.filter).toEqual({ tenant: 'tenantA' });
    expect(res[0].identity).toBe('alice@x.com'); // bare identity from metadata, usable downstream
  });

  it('delete uses the tenant-scoped id', async () => {
    const { calls, fetchImpl } = recordingFetch();
    await store(fetchImpl).delete('tenantA', 'alice@x.com');
    const del = calls.find((c) => c.path === 'delete_by_ids')!;
    expect(del.body.ids).toEqual(['tenantA:alice@x.com']);
  });
});
