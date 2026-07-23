import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalIdentityClient } from '../../../src/identity/LocalIdentityClient';
import type { Embedder } from '../../../src/identity/embedder';

vi.mock('../../../src/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), isLevelEnabled: () => false },
}));

// Records the sample count handed to the embedder so we can assert the PCM cap. Never touches
// the native CAM++ addon (injected via embedderFactory).
function spyClient(maxEmbedSec: number, seen: { samples: number[] }) {
  const embedder: Embedder = {
    dim: 192,
    async embed(audio: Float32Array) {
      seen.samples.push(audio.length);
      return Float32Array.from([1, 0, 0]);
    },
  };
  return new LocalIdentityClient({
    embeddingModel: 'm',
    vectorize: { accountId: 'a', indexName: 'i', apiToken: 't' },
    matchThreshold: 0.5,
    maxEmbedSec,
    embedderFactory: async () => embedder,
  });
}

const pcmSeconds = (sec: number) => Buffer.alloc(sec * 16000 * 2); // s16le mono @16k

describe('LocalIdentityClient embed cap', () => {
  it('truncates a long slice to maxEmbedSec before the (synchronous native) embed', async () => {
    const seen = { samples: [] as number[] };
    await spyClient(4, seen).embed(pcmSeconds(30)); // 30s in → capped to 4s
    expect(seen.samples[0]).toBe(4 * 16000); // 64000 samples, not 480000
  });

  it('leaves a short slice untouched (no padding, no cap)', async () => {
    const seen = { samples: [] as number[] };
    await spyClient(4, seen).embed(pcmSeconds(2)); // 2s < 4s cap
    expect(seen.samples[0]).toBe(2 * 16000);
  });

  it('maxEmbedSec <= 0 disables the cap', async () => {
    const seen = { samples: [] as number[] };
    await spyClient(0, seen).embed(pcmSeconds(30));
    expect(seen.samples[0]).toBe(30 * 16000);
  });
});

// identify / enroll drive the Vectorize v2 REST store; global fetch is stubbed (no network, no
// native embedder) so the embed→query→decideMatch and embed→upsert pipelines are exercised end-to-end.
const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
function fakeFetch(o: { matches?: unknown[]; onUpsert?: (body: string) => void }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/query')) return jsonRes({ result: { matches: o.matches ?? [] } });
    if (u.endsWith('/get_by_ids')) return jsonRes({ result: [] });
    if (u.endsWith('/upsert')) {
      o.onUpsert?.(String(init?.body ?? ''));
      return jsonRes({ result: {} });
    }
    throw new Error(`unexpected vectorize call: ${u}`);
  }) as unknown as typeof fetch;
}
const client = (embedderFactory: () => Promise<Embedder | null>, over: Record<string, unknown> = {}) =>
  new LocalIdentityClient({
    embeddingModel: 'm',
    vectorize: { accountId: 'a', indexName: 'i', apiToken: 't' },
    matchThreshold: 0.5,
    embedderFactory: embedderFactory as () => Promise<Embedder>,
    ...over,
  });
const constEmbedder = (vector: number[]): Embedder => ({ dim: vector.length, async embed() { return Float32Array.from(vector); } });

describe('LocalIdentityClient identify/enroll', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('identify returns the matched identity when cosine >= threshold', async () => {
    vi.stubGlobal('fetch', fakeFetch({ matches: [{ id: 'default:alice', values: [1, 0, 0], metadata: { identity: 'alice', name: 'Alice' } }] }));
    const r = await client(async () => constEmbedder([1, 0, 0])).identify('default', pcmSeconds(1));
    expect(r?.identity).toBe('alice');
    expect(r?.name).toBe('Alice');
    expect(r?.score).toBeCloseTo(1, 5);
  });

  it('identify returns null identity when no candidate clears the threshold', async () => {
    vi.stubGlobal('fetch', fakeFetch({ matches: [{ id: 'default:bob', values: [0, 1, 0], metadata: { identity: 'bob' } }] }));
    const r = await client(async () => constEmbedder([1, 0, 0])).identify('default', pcmSeconds(1));
    expect(r?.identity).toBeNull();
  });

  it('degrades to null/false when the embedder fails to initialise', async () => {
    vi.stubGlobal('fetch', fakeFetch({}));
    const c = client(async () => { throw new Error('no native addon'); });
    expect(await c.identify('default', pcmSeconds(1))).toBeNull();
    expect(await c.enroll('alice', 'default', pcmSeconds(1))).toBe(false);
  });

  it('enroll upserts a tenant-scoped fingerprint and returns true', async () => {
    let body = '';
    vi.stubGlobal('fetch', fakeFetch({ onUpsert: (b) => (body = b) }));
    const ok = await client(async () => constEmbedder([1, 0, 0])).enroll('alice', 'default', pcmSeconds(1), 'Alice');
    expect(ok).toBe(true);
    expect(body).toContain('"identity":"alice"');
    expect(body).toContain('"tenant":"default"');
  });
});
