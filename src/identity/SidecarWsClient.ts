import logger from '../logger';
import type { ISidecarClient, AnalyzeResult } from './SidecarClient';

/** Minimal WHATWG-WebSocket surface (Node's global WebSocket, or a test double). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(type: string, cb: (ev: any) => void): void;
}
export type WsFactory = (url: string) => WsLike;

export interface SidecarWsClientOptions {
  url: string; // http(s):// or ws(s):// base — normalized to ws(s)://host/ws?token=
  token: string;
  timeoutMs?: number;
  maxInFlight?: number;
  wsFactory?: WsFactory;
}

/**
 * Persistent, multiplexed WS client for the identity sidecar. One connection
 * carries all analyze/enroll/session-end requests (correlated by `id`), so the
 * container makes a single outbound connection regardless of request volume —
 * required under Cloudflare's outbound-connection cap. Off the hot path:
 * bounded in-flight, per-request timeout, never throws (returns null/false).
 */
export class SidecarWsClient implements ISidecarClient {
  private ws: WsLike | null = null;
  private connecting: Promise<WsLike | null> | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private readonly wsUrl: string;
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly factory: WsFactory;

  constructor(o: SidecarWsClientOptions) {
    this.timeoutMs = o.timeoutMs ?? 30000;
    this.maxInFlight = o.maxInFlight ?? 8;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.factory = o.wsFactory ?? ((url: string) => new (globalThis as any).WebSocket(url) as WsLike);
    const u = new URL(o.url);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    u.pathname = '/ws';
    u.searchParams.set('token', o.token);
    this.wsUrl = u.toString();
  }

  private connect(): Promise<WsLike | null> {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<WsLike | null>((resolve) => {
      let settled = false;
      let ws: WsLike;
      try {
        ws = this.factory(this.wsUrl);
      } catch (err) {
        logger.debug(`[identity] sidecar WS connect failed: ${(err as Error).message}`);
        this.connecting = null;
        return resolve(null);
      }
      ws.addEventListener('open', () => {
        this.ws = ws;
        settled = true;
        this.connecting = null;
        resolve(ws);
      });
      ws.addEventListener('message', (ev: any) => this.handleMessage(typeof ev === 'string' ? ev : ev?.data));
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        if (!settled) {
          settled = true;
          this.connecting = null;
          resolve(null);
        }
        this.failAllPending();
      });
      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          this.connecting = null;
          resolve(null);
        }
      });
    });
    return this.connecting;
  }

  private handleMessage(data: unknown): void {
    let m: any;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    const p = this.pending.get(m?.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id);
    p.resolve(m);
  }

  private failAllPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }

  private async request(payload: object): Promise<any | null> {
    if (this.pending.size >= this.maxInFlight) {
      logger.debug('[identity] sidecar WS overloaded, dropping request');
      return null;
    }
    const ws = await this.connect();
    if (!ws) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        ws.send(JSON.stringify({ id, ...payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  async analyze(sessionId: string, streamId: string, tenant: string, pcm: Buffer): Promise<AnalyzeResult | null> {
    const m = await this.request({ type: 'analyze', sessionId, streamId, tenant, pcm: pcm.toString('base64') });
    return m && m.type === 'result' ? (m.result ?? null) : null;
  }

  async enroll(identity: string, tenant: string, pcm: Buffer): Promise<boolean> {
    const m = await this.request({ type: 'enroll', identity, tenant, pcm: pcm.toString('base64') });
    return !!(m && m.type === 'ack');
  }

  async sessionEnd(sessionId: string, streamId: string): Promise<void> {
    await this.request({ type: 'session-end', sessionId, streamId });
  }
}
