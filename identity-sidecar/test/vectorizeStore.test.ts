import { describe, it, expect, vi } from 'vitest';
import { VectorizeStore } from '../src/store/VectorizeStore.js';

function mockFetch(handlers: Record<string, (body: any) => any>) {
  return vi.fn(async (url: string, init?: any) => {
    const key = Object.keys(handlers).find((k) => String(url).includes(k));
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const result = key ? handlers[key](body) : {};
    return { ok: true, status: 200, json: async () => ({ success: true, result }) } as any;
  });
}

const opts = (fetchImpl: any) => ({ accountId: 'acc', indexName: 'voices', apiToken: 'tok', fetchImpl });

describe('VectorizeStore', () => {
  it('deletes by id', async () => {
    const f = mockFetch({ delete_by_ids: () => ({ mutationId: 'm1' }) });
    await new VectorizeStore(opts(f)).delete('alice');
    const call = f.mock.calls.find((c) => String(c[0]).includes('delete_by_ids'))!;
    expect(JSON.parse((call[1] as any).body)).toEqual({ ids: ['alice'] });
  });

  it('queries with a tenant filter and topK 50, returning vectors', async () => {
    const f = mockFetch({
      query: () => ({ matches: [{ id: 'alice', values: [1, 0, 0], metadata: { tenant: 't1' } }] }),
    });
    const res = await new VectorizeStore(opts(f)).query('t1');
    expect(res).toEqual([{ identity: 'alice', vector: Float32Array.from([1, 0, 0]) }]);
    const call = f.mock.calls.find((c) => String(c[0]).includes('query'))!;
    const sent = JSON.parse((call[1] as any).body);
    expect(sent.filter).toEqual({ tenant: 't1' });
    expect(sent.topK).toBe(50);
  });

  it('upserts a first-time vector via upsert call', async () => {
    const f = mockFetch({ getByIds: () => ({ vectors: [] }), upsert: () => ({ mutationId: 'm2' }) });
    await new VectorizeStore(opts(f)).upsert('t1', 'bob', Float32Array.from([0, 1, 0]));
    const call = f.mock.calls.find((c) => String(c[0]).includes('upsert'))!;
    const sent = JSON.parse((call[1] as any).body);
    expect(sent.id).toBe('bob');
    expect(sent.metadata.tenant).toBe('t1');
  });
});
