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
	/** How long (ms) a miss is remembered before we re-query KV. Default 5000. Hits cache forever. */
	negativeTtlMs?: number;
	/** Injectable clock (ms) for tests. */
	now?: () => number;
	/** Max cached keys per map before oldest-first eviction (bounds a long-lived pool container). Default 5000. */
	maxEntries?: number;
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
	// Hits are cached forever (participant metadata is immutable for a session). Misses are cached
	// only until `retryAt` — a not-yet-written KV record (the ingest pipeline is async) must be
	// retryable, or a slightly-early first lookup would disable identity for the whole session.
	private hits = new Map<string, ResolvedIdentity>();
	private retryAt = new Map<string, number>();
	private fetch: typeof fetch;
	private negativeTtlMs: number;
	private now: () => number;
	private maxEntries: number;
	constructor(private o: KvRestOptions) {
		this.fetch = o.fetchImpl ?? fetch.bind(globalThis);
		this.negativeTtlMs = o.negativeTtlMs ?? 5000;
		this.now = o.now ?? Date.now;
		this.maxEntries = o.maxEntries ?? 5000;
	}

	/** Insert with an oldest-first size cap so a long-lived (pool-mode) container can't grow the map
	 *  without bound; an evicted still-active key simply re-queries KV on its next lookup. */
	private capSet<V>(m: Map<string, V>, key: string, value: V): void {
		m.set(key, value);
		if (m.size > this.maxEntries) {
			// Map iteration is insertion-ordered (ES2015+), so keys().next() is the oldest entry — FIFO
			// eviction. (A re-set of an existing key keeps its original position, which is fine here.)
			const oldest = m.keys().next().value;
			if (oldest !== undefined) m.delete(oldest);
		}
	}

	async resolve(sessionId: string, participantId: string): Promise<ResolvedIdentity | null> {
		const key = `${sessionId}-${participantId}`;
		const hit = this.hits.get(key);
		if (hit) return hit;
		const retryAt = this.retryAt.get(key);
		if (retryAt !== undefined && this.now() < retryAt) return null; // still within the negative TTL
		let result: ResolvedIdentity | null = null;
		try {
			const url = `https://api.cloudflare.com/client/v4/accounts/${this.o.accountId}/storage/kv/namespaces/${this.o.namespaceId}/values/${encodeURIComponent(key)}`;
			const res = await this.fetch(url, { headers: { Authorization: `Bearer ${this.o.apiToken}` } });
			if (res.ok) {
				const ev: any = await res.json();
				const d = ev?.data ?? {};
				// Anchor on email — it's the one stable id across meetings (participant ids are
				// regenerated per meeting). Fall back to the per-meeting id only when no email. Pick the
				// first NON-EMPTY STRING: KV values are untyped, and a non-string (number/object) would
				// otherwise coerce into the Vectorize row id (e.g. "[object Object]").
				const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
				const identity = str(d.email) ?? str(d.id) ?? str(d.participantId) ?? participantId;
				const email = str(d.email);
				result = { identity, name: str(d.name), email, tenant: str(ev?.customerId) ?? 'default' };
			} else if (res.status !== 404) {
				logger.debug(`[identity] KV resolve ${key} -> ${res.status}`);
			}
		} catch (err) {
			logger.debug(`[identity] KV resolve ${key} failed: ${(err as Error).message}`);
		}
		if (result) this.capSet(this.hits, key, result);
		else this.capSet(this.retryAt, key, this.now() + this.negativeTtlMs);
		return result;
	}
}

/** Build the identity source from config, or null when KV creds are unset. */
export function createIdentitySource(): IdentitySource | null {
	const { kvAccountId, kvNamespaceId, kvApiToken, kvNegativeTtlMs } = config.identity ?? ({} as any);
	if (!kvAccountId || !kvNamespaceId || !kvApiToken) return null;
	return new KvRestIdentitySource({
		accountId: kvAccountId,
		namespaceId: kvNamespaceId,
		apiToken: kvApiToken,
		negativeTtlMs: kvNegativeTtlMs,
	});
}
