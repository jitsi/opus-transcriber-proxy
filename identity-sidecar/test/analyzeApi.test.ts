import { describe, it, expect } from 'vitest';
import { buildApp, type Deps } from '../src/app.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { SessionRegistry } from '../src/pipeline/SessionRegistry.js';
import { DEFAULT_GUARD } from '../src/diarizer.js';
import type { AnalyzePipeline, AnalyzeResult } from '../src/pipeline/AnalyzePipeline.js';

const cannedResult: AnalyzeResult = {
  speakerCount: 2,
  multiple: true,
  turns: [
    { start: 0, end: 1, sessionSpeakerId: 0, handle: 'Purple Otter', identity: 'alice', score: 0.9 },
    { start: 1, end: 2, sessionSpeakerId: 1, handle: 'Amber Falcon', identity: null, score: 0.2 },
  ],
};
const fakePipeline = { analyze: async () => cannedResult } as unknown as AnalyzePipeline;

function app() {
  const registry = new SessionRegistry(() => 0, 1000, 0.5);
  const deps: Deps = {
    embedder: { dim: 0, embed: async () => new Float32Array() },
    diarizer: { analyze: async () => [] },
    store: new MemoryStore(),
    threshold: 0.5,
    guard: DEFAULT_GUARD,
    bearerToken: 't',
    pipeline: fakePipeline,
    registry,
  };
  return buildApp(deps);
}

const auth = { authorization: 'Bearer t' };
const octet = { 'content-type': 'application/octet-stream' };

describe('analyze api', () => {
  it('requires auth', async () => {
    const res = await app().inject({ method: 'POST', url: '/analyze', headers: octet, payload: Buffer.alloc(4) });
    expect(res.statusCode).toBe(401);
  });

  it('400 on missing session/stream/tenant headers', async () => {
    const res = await app().inject({ method: 'POST', url: '/analyze', headers: { ...auth, ...octet }, payload: Buffer.alloc(4) });
    expect(res.statusCode).toBe(400);
  });

  it('returns the pipeline result', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/analyze',
      headers: { ...auth, ...octet, 'x-tenant': 't1', 'x-session': 's', 'x-stream': 'st' },
      payload: Buffer.alloc(320),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().speakerCount).toBe(2);
    expect(res.json().turns[0].identity).toBe('alice');
  });

  it('session-end returns 200', async () => {
    const res = await app().inject({ method: 'POST', url: '/session-end', headers: auth, payload: { sessionId: 's', streamId: 'st' } });
    expect(res.statusCode).toBe(200);
  });
});
