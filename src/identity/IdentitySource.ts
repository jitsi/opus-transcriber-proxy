import logger from '../logger';
import { config } from '../config';

export interface ResolvedIdentity {
  identity: string; // stable cross-meeting id (fingerprint key)
  name?: string;
  email?: string;
  tenant: string;
}

export interface IdentitySource {
  resolve(sessionId: string, participantId: string): Promise<ResolvedIdentity | null>;
}

export interface KvRestOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolves a participant's stable identity + tenant from the WEBHOOK_EVENTS KV
 * (the same {sessionId}-{participantId} PARTICIPANT_JOINED record the dispatcher
 * uses), via the Cloudflare KV REST API — the container has no KV binding.
 * Results are cached per key (participant metadata is immutable for a session).
 * Any failure resolves to null (→ default tenant, no auto-enroll).
 */
export class KvRestIdentitySource implements IdentitySource {
  private cache = new Map<string, ResolvedIdentity | null>();
  private fetch: typeof fetch;
  constructor(private o: KvRestOptions) {
    this.fetch = o.fetchImpl ?? fetch.bind(globalThis);
  }

  async resolve(sessionId: string, participantId: string): Promise<ResolvedIdentity | null> {
    const key = `${sessionId}-${participantId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let result: ResolvedIdentity | null = null;
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${this.o.accountId}/storage/kv/namespaces/${this.o.namespaceId}/values/${encodeURIComponent(key)}`;
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.o.apiToken}` } });
      if (res.ok) {
        const ev: any = await res.json();
        const d = ev?.data ?? {};
        const identity = d.id || d.participantId || participantId;
        result = { identity, name: d.name, email: d.email, tenant: ev?.customerId || 'default' };
      } else if (res.status !== 404) {
        logger.debug(`[identity] KV resolve ${key} -> ${res.status}`);
      }
    } catch (err) {
      logger.debug(`[identity] KV resolve ${key} failed: ${(err as Error).message}`);
    }
    this.cache.set(key, result);
    return result;
  }
}

/** Build the identity source from config, or null when KV creds are unset. */
export function createIdentitySource(): IdentitySource | null {
  const { kvAccountId, kvNamespaceId, kvApiToken } = config.identity ?? ({} as any);
  if (!kvAccountId || !kvNamespaceId || !kvApiToken) return null;
  return new KvRestIdentitySource({ accountId: kvAccountId, namespaceId: kvNamespaceId, apiToken: kvApiToken });
}
