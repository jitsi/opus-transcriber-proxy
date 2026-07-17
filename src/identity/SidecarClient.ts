import logger from '../logger';

export interface AnalyzeTurn {
  start: number;
  end: number;
  sessionSpeakerId: number;
  handle: string;
  identity: string | null;
  name?: string;
  score: number;
}
export interface AnalyzeResult {
  speakerCount: number;
  multiple: boolean;
  turns: AnalyzeTurn[];
}

/** Transport-agnostic sidecar client surface (HTTP or WS implementations). */
export interface ISidecarClient {
  analyze(sessionId: string, streamId: string, tenant: string, pcm: Buffer): Promise<AnalyzeResult | null>;
  enroll(identity: string, tenant: string, pcm: Buffer, name?: string): Promise<boolean>;
  sessionEnd(sessionId: string, streamId: string): Promise<void>;
}

export interface SidecarClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxInFlight?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fire-and-forget HTTP client for the identity sidecar. Off the hot path:
 * a bounded in-flight counter drops requests under overload, a timeout bounds
 * each call, and nothing ever throws to the caller (returns null instead), so
 * transcription is never blocked or broken by sidecar trouble.
 */
export class SidecarClient implements ISidecarClient {
  private inFlight = 0;
  private fetch: typeof fetch;
  private timeoutMs: number;
  private maxInFlight: number;

  constructor(private o: SidecarClientOptions) {
    // Bind global fetch — undici throws "Illegal invocation" if fetch is called
    // as a method (this.fetch(...)). Injected mocks are used as-is.
    this.fetch = o.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = o.timeoutMs ?? 2000;
    this.maxInFlight = o.maxInFlight ?? 8;
  }

  private async call(path: string, headers: Record<string, string>, body: Uint8Array | string): Promise<any | null> {
    if (this.inFlight >= this.maxInFlight) {
      logger.debug(`[identity] sidecar overloaded (${this.inFlight}), dropping ${path}`);
      return null;
    }
    this.inFlight++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.o.baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.token}`, ...headers },
        body: body as BodyInit,
        signal: ac.signal,
      });
      if (!res.ok) {
        logger.debug(`[identity] sidecar ${path} -> ${res.status}`);
        return null;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (err) {
      logger.debug(`[identity] sidecar ${path} failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
      this.inFlight--;
    }
  }

  async analyze(sessionId: string, streamId: string, tenant: string, pcm: Buffer): Promise<AnalyzeResult | null> {
    return this.call(
      '/analyze',
      { 'content-type': 'application/octet-stream', 'x-tenant': tenant, 'x-session': sessionId, 'x-stream': streamId },
      pcm,
    );
  }

  async enroll(identity: string, tenant: string, pcm: Buffer, name?: string): Promise<boolean> {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-identity': identity,
      'x-tenant': tenant,
    };
    if (name) headers['x-name'] = name;
    const r = await this.call('/enroll', headers, pcm);
    return r !== null;
  }

  async sessionEnd(sessionId: string, streamId: string): Promise<void> {
    await this.call('/session-end', { 'content-type': 'application/json' }, JSON.stringify({ sessionId, streamId }));
  }
}
