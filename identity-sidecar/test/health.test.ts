import { describe, it, expect } from 'vitest';
import { buildApp, type Deps } from '../src/app.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { DEFAULT_GUARD } from '../src/diarizer.js';

const stubDeps: Deps = {
  embedder: { dim: 0, embed: async () => new Float32Array() },
  diarizer: { analyze: async () => [] },
  store: new MemoryStore(),
  threshold: 0.5,
  guard: DEFAULT_GUARD,
  bearerToken: 't',
};

describe('health', () => {
  it('returns ok', async () => {
    const res = await buildApp(stubDeps).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
