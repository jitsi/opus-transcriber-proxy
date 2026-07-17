import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import { pcm16ToFloat32, type Embedder } from './embedder.js';
import { countSpeakers, type Diarizer, type SpeakerGuard, DEFAULT_GUARD } from './diarizer.js';
import { decideMatch } from './matcher.js';
import { FingerprintStore } from './store/FingerprintStore.js';
import type { AnalyzePipeline } from './pipeline/AnalyzePipeline.js';
import type { SessionRegistry } from './pipeline/SessionRegistry.js';

export interface Deps {
  embedder: Embedder;
  diarizer: Diarizer;
  store: FingerprintStore;
  threshold: number;
  guard: SpeakerGuard;
  bearerToken: string;
  pipeline?: AnalyzePipeline;
  registry?: SessionRegistry;
}

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const authed = (req: FastifyRequest): boolean => req.headers.authorization === `Bearer ${deps.bearerToken}`;

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/enroll', async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
    const identity = req.headers['x-identity'] as string | undefined;
    const tenant = req.headers['x-tenant'] as string | undefined;
    if (!identity || !tenant) return reply.code(400).send({ error: 'missing x-identity/x-tenant' });
    const vec = await deps.embedder.embed(pcm16ToFloat32(req.body as Buffer));
    await deps.store.upsert(tenant, identity, vec);
    return reply.code(202).send({});
  });

  app.post('/identify', async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
    const tenant = req.headers['x-tenant'] as string | undefined;
    if (!tenant) return reply.code(400).send({ error: 'missing x-tenant' });
    const vec = await deps.embedder.embed(pcm16ToFloat32(req.body as Buffer));
    const candidates = await deps.store.query(tenant);
    const { identity, score } = decideMatch(vec, candidates, deps.threshold);
    return reply.code(200).send({ identity, score, threshold: deps.threshold });
  });

  app.post('/detect', async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
    const segments = await deps.diarizer.analyze(pcm16ToFloat32(req.body as Buffer));
    const speakerCount = countSpeakers(segments, deps.guard);
    return reply.code(200).send({ speakerCount, multiple: speakerCount > 1, segments });
  });

  app.post('/analyze', async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!deps.pipeline) return reply.code(501).send({ error: 'pipeline not configured' });
    const tenant = req.headers['x-tenant'] as string | undefined;
    const sessionId = req.headers['x-session'] as string | undefined;
    const streamId = req.headers['x-stream'] as string | undefined;
    if (!tenant || !sessionId || !streamId) return reply.code(400).send({ error: 'missing x-tenant/x-session/x-stream' });
    const result = await deps.pipeline.analyze(sessionId, streamId, tenant, pcm16ToFloat32(req.body as Buffer));
    return reply.code(200).send(result);
  });

  app.post('/session-end', async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!deps.registry) return reply.code(501).send({ error: 'registry not configured' });
    const { sessionId, streamId } = (req.body ?? {}) as { sessionId?: string; streamId?: string };
    if (!sessionId || !streamId) return reply.code(400).send({ error: 'missing sessionId/streamId' });
    deps.registry.end(sessionId, streamId);
    return reply.code(200).send({});
  });

  app.post('/delete', async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
    const { identity } = (req.body ?? {}) as { identity?: string };
    if (!identity) return reply.code(400).send({ error: 'missing identity' });
    await deps.store.delete(identity);
    return reply.code(200).send({});
  });

  return app;
}

export { DEFAULT_GUARD };
