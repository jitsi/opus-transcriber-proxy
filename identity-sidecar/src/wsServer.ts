import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { pcm16ToFloat32 } from './embedder.js';
import type { Deps } from './app.js';

/**
 * Persistent-WS endpoint (/ws) mirroring the HTTP API. Lets a client multiplex
 * many analyze/enroll/delete/session-end requests over ONE connection — the CF
 * outbound-connection cap makes a per-request HTTP model unviable at scale.
 *
 * Wire protocol (JSON per message, request/response correlated by `id`):
 *   -> {type:'analyze', id, sessionId, streamId, tenant, pcm(base64)}  <- {type:'result', id, result}
 *   -> {type:'enroll',  id, identity, tenant, pcm(base64)}             <- {type:'ack', id}
 *   -> {type:'identify',id, tenant, pcm(base64)}                       <- {type:'result', id, result:{identity,score}}
 *   -> {type:'delete',  id, identity}                                  <- {type:'ack', id}
 *   -> {type:'session-end', id, sessionId, streamId}                   <- {type:'ack', id}
 * Errors: <- {type:'error', id, error}. Auth: Authorization: Bearer <token> on the upgrade.
 */
export function attachWsServer(server: Server, deps: Deps, bearerToken: string): WebSocketServer {
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });

  wss.on('connection', (ws: WebSocket, req) => {
    // Path + auth check. Token accepted via ?token= (portable across runtimes that
    // can't set headers on a WS upgrade) or an Authorization: Bearer header.
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    const authed = token === bearerToken || req.headers.authorization === `Bearer ${bearerToken}`;
    if (url.pathname !== '/ws' || !authed) {
      ws.close(1008, 'unauthorized');
      return;
    }
    ws.on('message', async (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const { type, id } = msg;
      const send = (obj: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id, ...obj }));
      try {
        switch (type) {
          case 'analyze': {
            const pcm = pcm16ToFloat32(Buffer.from(msg.pcm, 'base64'));
            const result = await deps.pipeline!.analyze(msg.sessionId, msg.streamId, msg.tenant, pcm);
            return send({ type: 'result', result });
          }
          case 'enroll': {
            const vec = await deps.embedder.embed(pcm16ToFloat32(Buffer.from(msg.pcm, 'base64')));
            await deps.store.upsert(msg.tenant, msg.identity, vec, msg.name);
            return send({ type: 'ack' });
          }
          case 'identify': {
            const vec = await deps.embedder.embed(pcm16ToFloat32(Buffer.from(msg.pcm, 'base64')));
            const { decideMatch } = await import('./matcher.js');
            const candidates = await deps.store.query(msg.tenant);
            const m = decideMatch(vec, candidates, deps.threshold);
            return send({ type: 'result', result: m });
          }
          case 'delete': {
            await deps.store.delete(msg.identity);
            return send({ type: 'ack' });
          }
          case 'session-end': {
            deps.registry?.end(msg.sessionId, msg.streamId);
            return send({ type: 'ack' });
          }
          default:
            return send({ type: 'error', error: `unknown type ${type}` });
        }
      } catch (err) {
        return send({ type: 'error', error: (err as Error).message });
      }
    });
  });

  return wss;
}
