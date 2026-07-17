import { describe, it, expect } from 'vitest';
import { buildApp, type Deps } from '../src/app.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { DEFAULT_GUARD, type Diarizer } from '../src/diarizer.js';
import type { Embedder } from '../src/embedder.js';

// Deterministic fake: first PCM sample (as int16 tag) selects an axis.
const fakeEmbedder: Embedder = {
  dim: 3,
  async embed(audio: Float32Array): Promise<Float32Array> {
    const tag = Math.round(audio[0] * 32768);
    const v = tag === 1 ? [1, 0, 0] : tag === 2 ? [0, 1, 0] : [0, 0, 1];
    return Float32Array.from(v);
  },
};
// Fake diarizer: two 5s speakers (both clear the guard).
const fakeDiarizer: Diarizer = {
  async analyze() {
    return [
      { start: 0, end: 5, speaker: 0 },
      { start: 5, end: 10, speaker: 1 },
    ];
  },
};

const pcmTagged = (tag: number): Buffer => {
  const b = Buffer.alloc(320);
  b.writeInt16LE(tag, 0);
  return b;
};
const auth = { authorization: 'Bearer t' };
const octet = { 'content-type': 'application/octet-stream' };

function app() {
  const deps: Deps = {
    embedder: fakeEmbedder,
    diarizer: fakeDiarizer,
    store: new MemoryStore(),
    threshold: 0.5,
    guard: DEFAULT_GUARD,
    bearerToken: 't',
  };
  return buildApp(deps);
}

describe('api', () => {
  it('rejects missing/incorrect bearer token', async () => {
    const res = await app().inject({ method: 'POST', url: '/delete', payload: { identity: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('enroll then identify returns the enrolled identity', async () => {
    const a = app();
    await a.inject({ method: 'POST', url: '/enroll', headers: { ...auth, ...octet, 'x-identity': 'alice', 'x-tenant': 't1' }, payload: pcmTagged(1) });
    const res = await a.inject({ method: 'POST', url: '/identify', headers: { ...auth, ...octet, 'x-tenant': 't1' }, payload: pcmTagged(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json().identity).toBe('alice');
  });

  it('identify returns null for an unenrolled voice', async () => {
    const a = app();
    await a.inject({ method: 'POST', url: '/enroll', headers: { ...auth, ...octet, 'x-identity': 'alice', 'x-tenant': 't1' }, payload: pcmTagged(1) });
    const res = await a.inject({ method: 'POST', url: '/identify', headers: { ...auth, ...octet, 'x-tenant': 't1' }, payload: pcmTagged(3) });
    expect(res.json().identity).toBeNull();
  });

  it('does not match across tenants', async () => {
    const a = app();
    await a.inject({ method: 'POST', url: '/enroll', headers: { ...auth, ...octet, 'x-identity': 'alice', 'x-tenant': 't1' }, payload: pcmTagged(1) });
    const res = await a.inject({ method: 'POST', url: '/identify', headers: { ...auth, ...octet, 'x-tenant': 't2' }, payload: pcmTagged(1) });
    expect(res.json().identity).toBeNull();
  });

  it('deletes an enrolled identity', async () => {
    const a = app();
    await a.inject({ method: 'POST', url: '/enroll', headers: { ...auth, ...octet, 'x-identity': 'alice', 'x-tenant': 't1' }, payload: pcmTagged(1) });
    await a.inject({ method: 'POST', url: '/delete', headers: auth, payload: { identity: 'alice' } });
    const res = await a.inject({ method: 'POST', url: '/identify', headers: { ...auth, ...octet, 'x-tenant': 't1' }, payload: pcmTagged(1) });
    expect(res.json().identity).toBeNull();
  });

  it('detect reports speaker count from the diarizer', async () => {
    const res = await app().inject({ method: 'POST', url: '/detect', headers: { ...auth, ...octet }, payload: pcmTagged(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json().speakerCount).toBe(2);
    expect(res.json().multiple).toBe(true);
  });
});
