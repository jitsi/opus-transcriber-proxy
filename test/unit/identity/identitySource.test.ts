import { describe, it, expect, vi } from 'vitest';
import { KvRestIdentitySource } from '../../../src/identity/IdentitySource';

const opts = (fetchImpl: any) => ({ accountId: 'acc', namespaceId: 'ns', apiToken: 'tok', fetchImpl });

describe('KvRestIdentitySource', () => {
  it('anchors identity on EMAIL (stable across meetings) when present', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ customerId: 'cust1', data: { id: 'u-1', name: 'Alice', email: 'a@x.com' } }),
    }));
    const src = new KvRestIdentitySource(opts(f));
    const r = await src.resolve('sess', 'p-a0');
    // email wins over the per-meeting id so the same person matches across sessions
    expect(r).toEqual({ identity: 'a@x.com', name: 'Alice', email: 'a@x.com', tenant: 'cust1' });
    expect(String(f.mock.calls[0][0])).toContain('/values/sess-p-a0');
  });

  it('falls back to id then participantId when email is absent', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ customerId: 'cust1', data: { id: 'u-1', name: 'Alice' } }),
    }));
    const r = await new KvRestIdentitySource(opts(f)).resolve('sess', 'p-a0');
    expect(r?.identity).toBe('u-1');
  });

  it('caches by key (one fetch for repeated resolves)', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ customerId: 'c', data: { id: 'u' } }) }));
    const src = new KvRestIdentitySource(opts(f));
    await src.resolve('s', 'p');
    await src.resolve('s', 'p');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('does NOT permanently cache a 404 miss — re-queries after the negative TTL (self-heals when KV lands)', async () => {
    let clock = 1000;
    const f = vi
      .fn()
      // first lookup: record not written yet
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // once KV catches up: the record exists
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ customerId: 'c', data: { email: 'z@x.com', name: 'Zoe' } }) });
    const src = new KvRestIdentitySource({ ...opts(f), negativeTtlMs: 5000, now: () => clock });

    expect(await src.resolve('s', 'p')).toBeNull(); // miss #1 → KV GET
    expect(await src.resolve('s', 'p')).toBeNull(); // within negative TTL → NO new GET
    expect(f).toHaveBeenCalledTimes(1);

    clock += 6000; // negative TTL elapsed
    const r = await src.resolve('s', 'p'); // re-queries → now resolves
    expect(r?.identity).toBe('z@x.com');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('caches a hit permanently (never re-queries once resolved)', async () => {
    let clock = 0;
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ customerId: 'c', data: { email: 'a@x.com' } }) }));
    const src = new KvRestIdentitySource({ ...opts(f), negativeTtlMs: 1, now: () => clock });
    await src.resolve('s', 'p');
    clock += 10000;
    await src.resolve('s', 'p');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('defaults tenant to "default" when customerId is null', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ customerId: null, data: { id: 'u2', name: 'Bob' } }) }));
    const r = await new KvRestIdentitySource(opts(f)).resolve('s', 'p2');
    expect(r?.tenant).toBe('default');
    expect(r?.identity).toBe('u2');
  });
});
