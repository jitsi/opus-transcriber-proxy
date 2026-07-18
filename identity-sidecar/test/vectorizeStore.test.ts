import { describe, it, expect, vi } from 'vitest';
import { VectorizeStore } from '../src/store/VectorizeStore.js';

// Exact-suffix match on the endpoint path so a call to `get_by_ids` can't be satisfied by a
// handler keyed on `getByIds` (the bug the old loose `includes` matcher hid).
function mockFetch(handlers: Record<string, (body: any) => any>) {
  return vi.fn(async (url: string, init?: any) => {
    const path = String(url).split('/').pop()!;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const handler = handlers[path];
    const result = handler ? handler(body) : {};
    return { ok: true, status: 200, json: async () => ({ success: true, result }) } as any;
  });
}

const opts = (fetchImpl: any) => ({ accountId: 'acc', indexName: 'voices', apiToken: 'tok', dimensions: 3, fetchImpl });

describe('VectorizeStore', () => {
  it('deletes by id', async () => {
    const f = mockFetch({ delete_by_ids: () => ({ mutationId: 'm1' }) });
    await new VectorizeStore(opts(f)).delete('alice');
    const call = f.mock.calls.find((c) => String(c[0]).endsWith('delete_by_ids'))!;
    expect(JSON.parse((call[1] as any).body)).toEqual({ ids: ['alice'] });
  });

  it('queries by the PROBE vector (ANN), with tenant filter and topK 50', async () => {
    const f = mockFetch({
      query: () => ({ matches: [{ id: 'alice', values: [1, 0, 0], metadata: { tenant: 't1', name: 'Alice' } }] }),
    });
    const res = await new VectorizeStore(opts(f)).query('t1', Float32Array.from([0.5, 0.25, 0]));
    expect(res).toEqual([{ identity: 'alice', vector: Float32Array.from([1, 0, 0]), name: 'Alice' }]);
    const sent = JSON.parse((f.mock.calls.find((c) => String(c[0]).endsWith('query'))![1] as any).body);
    expect(sent.vector).toEqual([0.5, 0.25, 0]); // the probe (float32-exact), NOT a neutral zero vector
    expect(sent.filter).toEqual({ tenant: 't1' });
    expect(sent.topK).toBe(50);
    expect(sent.returnValues).toBe(true);
  });

  it('reads the prior centroid via get_by_ids (snake_case) with returnValues', async () => {
    const getBody: any[] = [];
    const f = mockFetch({
      get_by_ids: (b) => { getBody.push(b); return []; }, // empty index → first enroll
      upsert: () => ({ mutationId: 'm2' }),
    });
    await new VectorizeStore(opts(f)).upsert('t1', 'bob', Float32Array.from([0, 1, 0]), 'Bob');
    expect(getBody[0]).toMatchObject({ ids: ['bob'], returnValues: true });
    const upCall = f.mock.calls.find((c) => String(c[0]).endsWith('upsert'))![1] as any;
    expect(upCall.headers['Content-Type']).toBe('application/x-ndjson'); // upsert is NDJSON, not JSON
    expect(upCall.body).toMatch(/\n$/); // one vector per line, trailing newline
    const up = JSON.parse(upCall.body);
    expect(up.id).toBe('bob');
    expect(up.metadata).toMatchObject({ tenant: 't1', name: 'Bob', sampleCount: 1 });
  });

  it('merges into the existing centroid when get_by_ids returns a prior vector', async () => {
    const f = mockFetch({
      // get_by_ids returns an ARRAY of {id, values, metadata} directly (not {vectors:[...]})
      get_by_ids: () => [{ id: 'bob', values: [1, 0, 0], metadata: { sampleCount: 1, name: 'Bob' } }],
      upsert: () => ({ mutationId: 'm3' }),
    });
    await new VectorizeStore(opts(f)).upsert('t1', 'bob', Float32Array.from([0, 1, 0]));
    const up = JSON.parse((f.mock.calls.find((c) => String(c[0]).endsWith('upsert'))![1] as any).body);
    expect(up.metadata.sampleCount).toBe(2);      // prior 1 + this 1
    expect(up.metadata.name).toBe('Bob');          // carried from the prior centroid
    // merged = normalize((prev*1 + new)/2) of ([1,0,0] and [0,1,0]) → equal x/y components
    expect(up.values[0]).toBeCloseTo(up.values[1], 5);
    expect(up.values[2]).toBeCloseTo(0, 5);
  });
});
