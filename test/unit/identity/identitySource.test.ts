import { describe, it, expect, vi } from 'vitest';
import { KvRestIdentitySource } from '../../../src/identity/IdentitySource';

const opts = (fetchImpl: any) => ({ accountId: 'acc', namespaceId: 'ns', apiToken: 'tok', fetchImpl });

describe('KvRestIdentitySource', () => {
  it('maps a PARTICIPANT_JOINED KV record to a ResolvedIdentity', async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ customerId: 'cust1', data: { id: 'u-1', name: 'Alice', email: 'a@x.com' } }),
    }));
    const src = new KvRestIdentitySource(opts(f));
    const r = await src.resolve('sess', 'p-a0');
    expect(r).toEqual({ identity: 'u-1', name: 'Alice', email: 'a@x.com', tenant: 'cust1' });
    expect(String(f.mock.calls[0][0])).toContain('/values/sess-p-a0');
  });

  it('caches by key (one fetch for repeated resolves)', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ customerId: 'c', data: { id: 'u' } }) }));
    const src = new KvRestIdentitySource(opts(f));
    await src.resolve('s', 'p');
    await src.resolve('s', 'p');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns null on 404 (and caches the miss)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404 }));
    const src = new KvRestIdentitySource(opts(f));
    expect(await src.resolve('s', 'missing')).toBeNull();
    await src.resolve('s', 'missing');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('defaults tenant to "default" when customerId is null', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ customerId: null, data: { id: 'u2', name: 'Bob' } }) }));
    const r = await new KvRestIdentitySource(opts(f)).resolve('s', 'p2');
    expect(r?.tenant).toBe('default');
    expect(r?.identity).toBe('u2');
  });
});
