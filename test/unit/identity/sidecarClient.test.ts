import { describe, it, expect, vi } from 'vitest';
import { SidecarClient } from '../../../src/identity/SidecarClient';

const okJson = (obj: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) }) as any;

describe('SidecarClient', () => {
  it('analyze returns the parsed result', async () => {
    const result = { speakerCount: 2, multiple: true, turns: [] };
    const f = vi.fn(async () => okJson(result));
    const c = new SidecarClient({ baseUrl: 'http://x', token: 't', fetchImpl: f as any });
    expect(await c.analyze('s', 'st', 'ten', Buffer.alloc(4))).toEqual(result);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain('/analyze');
    expect((init as any).headers['x-session']).toBe('s');
  });

  it('returns null on a non-ok response (never throws)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }) as any);
    const c = new SidecarClient({ baseUrl: 'http://x', token: 't', fetchImpl: f as any });
    expect(await c.analyze('s', 'st', 'ten', Buffer.alloc(4))).toBeNull();
  });

  it('returns null on a thrown/aborted fetch', async () => {
    const f = vi.fn(async () => {
      throw new Error('aborted');
    });
    const c = new SidecarClient({ baseUrl: 'http://x', token: 't', fetchImpl: f as any });
    expect(await c.analyze('s', 'st', 'ten', Buffer.alloc(4))).toBeNull();
  });

  it('drops requests over the in-flight cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => {
      await gate;
      return okJson({ speakerCount: 1, multiple: false, turns: [] });
    });
    const c = new SidecarClient({ baseUrl: 'http://x', token: 't', maxInFlight: 1, fetchImpl: f as any });
    const p1 = c.analyze('s', 'st', 'ten', Buffer.alloc(4)); // occupies the slot
    const dropped = await c.analyze('s', 'st', 'ten', Buffer.alloc(4)); // over cap
    expect(dropped).toBeNull();
    release();
    await p1;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('enroll posts identity/tenant headers and reports success', async () => {
    const f = vi.fn(async () => okJson({}));
    const c = new SidecarClient({ baseUrl: 'http://x', token: 't', fetchImpl: f as any });
    expect(await c.enroll('alice', 'ten', Buffer.alloc(4))).toBe(true);
    const [, init] = f.mock.calls[0];
    expect((init as any).headers['x-identity']).toBe('alice');
  });
});
