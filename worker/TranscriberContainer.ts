import { Container } from '@cloudflare/containers';
import type { Env } from './env';
import { buildContainerEnvVars, instanceNameEnv } from './containerEnv';

/**
 * The platform error messages the SDK's `containerFetch` classifies a failed start by, copied from
 * @cloudflare/containers 0.3.7 (`dist/lib/container.js`, `NO_CONTAINER_INSTANCE_ERROR` and
 * `RATE_LIMITED_ERROR`; matched lower-cased by substring). The SDK does not export them, so
 * re-check these two lines against the SDK source when bumping it.
 */
const SDK_NO_CONTAINER_INSTANCE_ERROR = 'there is no container instance that can be provided to this durable object';
const SDK_RATE_LIMITED_ERROR = 'you are requesting too many containers per second';

/**
 * Turn a `startAndWaitForPorts()` failure into the response the SDK's `containerFetch` gives it:
 * no instance available is a capacity condition (503), too many starts per second is rate
 * limiting (429), anything else is a server error (500).
 */
export function containerStartFailureResponse(e: unknown): Response {
	const message = e instanceof Error ? e.message : String(e);
	const lower = message.toLowerCase();
	if (lower.includes(SDK_NO_CONTAINER_INSTANCE_ERROR)) {
		return new Response('There is no Container instance available at this time.', { status: 503 });
	}
	if (lower.includes(SDK_RATE_LIMITED_ERROR)) {
		return new Response(message, { status: 429 });
	}
	return new Response(`Failed to start container: ${message}`, { status: 500 });
}

/**
 * TranscriberContainer wraps the Node.js transcription server
 * and forwards WebSocket requests to it.
 */
export class TranscriberContainer extends Container<Env> {
	// Port that the Node.js server listens on
	defaultPort = 8080;

	// How long to keep container running after last activity
	// After this period: Container goes to sleep (CPU/memory released)
	// Note: Cloudflare automatically manages sleep/wake - you cannot "destroy" containers
	// Shorter = More aggressive resource cleanup, but more wake-ups
	// Longer = Fewer cold starts, but uses more resources when idle
	// For pool-based routing: Keep this longer (containers serve many sessions)
	// For session-based routing: Keep this shorter (containers are session-specific)
	// NOTE: must stay > the renewal interval in sessionProxy.ts (180s), with margin for a missed
	// renewal — otherwise a live call's container sleeps mid-session. After audio stops,
	// the container reclaims ~sleepAfter after the last renewal.
	sleepAfter = this.env.SLEEP_AFTER || '7m';

	// Environment for the container. The instance name is the name this Durable Object was
	// looked up by (`getContainer(binding, name)` → `idFromName`), which is the session or pool
	// slot id the Worker uses everywhere else. The Worker's explicit start passes the same env
	// again with the name it routed by, so a start from a request never depends on `ctx.id.name`;
	// this default covers the SDK's start-on-fetch and the passthrough override's safety net.
	envVars: Record<string, string> = {
		...buildContainerEnvVars(this.env),
		...instanceNameEnv(this.ctx.id),
	};

	override onStart() {
		console.log('Transcriber container started');
	}

	override onStop() {
		console.log('Transcriber container stopped');
	}

	override onError(error: unknown) {
		// Properly serialize error for Cloudflare Workers logging
		if (error instanceof Error) {
			console.error('Transcriber container error:', error.message, error.stack);
		} else if (typeof error === 'string') {
			console.error('Transcriber container error:', error);
		} else {
			// For other types (Date, objects, etc.), stringify them
			console.error('Transcriber container error:', JSON.stringify(error));
		}
	}

	/**
	 * Hand WebSocket upgrades straight to the container instead of letting the SDK proxy them.
	 *
	 * Since @cloudflare/containers 0.2.1, `Container.fetch()` (via `containerFetch`) no longer
	 * returns the container's WebSocket to the caller: it accepts it inside this Durable
	 * Object, creates a second WebSocketPair, and relays every message between the two in JS,
	 * calling `renewActivityTimeout()` per message. For this workload that would run a JS
	 * handler in this DO's isolate for every 20 ms audio frame of every participant (a
	 * 20-participant meeting is ~1000 messages/s on one single-threaded object), add a hop of
	 * latency, and remap a 1006 abnormal close from the container to a clean 1000, hiding a
	 * container crash from the bridge and from our logs; the incoming frames would also be
	 * billed as DO requests, a minor cost at 20 messages per billable request. The pre-0.2.1
	 * behaviour (what this deployment ran on, at 0.0.31, before this upgrade) was a plain
	 * passthrough: the response from the container's TCP port is returned as-is and workerd
	 * pipes the socket with no per-message code here. This override restores that for upgrades
	 * only; plain HTTP (the /status probe in `onActivityExpired`, anything else) still goes
	 * through the SDK.
	 *
	 * Consequence: the SDK's activity timer does not see WebSocket traffic, exactly as before,
	 * so keeping a live call's container awake stays our job (the renewal loop in
	 * `handleWebSocketWithDispatcher` and the `/status` probe in `onActivityExpired` below).
	 *
	 * The Worker always calls `startAndWaitForPorts()` before `fetch()`, so the start here is
	 * only a safety net for a container that stopped in between. It is gated the way
	 * `containerFetch` gates its own start, on the container not running or the SDK's persisted
	 * state not being healthy (`getState()` is a cached storage read), so an upgrade that lands
	 * while a restart is between `start()` and the port coming up joins that start instead of
	 * failing against a port that is not listening yet. Calling `startAndWaitForPorts()`
	 * unconditionally would instead cost a port probe, a storage write and an `onStart` per
	 * upgrade.
	 *
	 * Failures are returned as responses, not thrown, with the status `containerFetch` would
	 * give them (503 when no container instance is available, 429 when rate limited, 500
	 * otherwise), so the Worker's `status !== 101` handling and its log lines are unchanged.
	 *
	 * The body below mirrors `containerFetch` in @cloudflare/containers 0.3.7 (URL rewrite,
	 * port lookup, error texts). None of that is covered by the SDK's types, so re-read
	 * `containerFetch` when bumping the SDK.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return super.fetch(request);
		}
		const port = this.defaultPort;
		const container = this.ctx.container;
		if (!container) {
			return new Response('Durable Object has no container binding', { status: 500 });
		}
		if (!container.running || (await this.getState()).status !== 'healthy') {
			// Every other start is logged by the Worker; this one would otherwise be invisible, and a
			// container that dies between the Worker's start and the upgrade is exactly what to notice.
			console.warn(`Container ${this.ctx.id.name ?? this.ctx.id} not ready at upgrade (running=${container.running}); starting it before connecting`);
			try {
				await this.startAndWaitForPorts({ ports: port, cancellationOptions: { abort: request.signal } });
			} catch (e) {
				return containerStartFailureResponse(e);
			}
		}
		this.renewActivityTimeout();
		try {
			// The container's port speaks plain HTTP (the SDK rewrites the scheme the same way).
			return await container.getTcpPort(port).fetch(request.url.replace(/^https:/, 'http:'), request);
		} catch (e) {
			if (!(e instanceof Error)) {
				throw e;
			}
			if (e.message.includes('Network connection lost.')) {
				return new Response('Container suddenly disconnected, try again', { status: 500 });
			}
			console.error(`Error proxying WebSocket upgrade to container ${this.ctx.id}:`, e);
			return new Response(`Error proxying request to container: ${e.message}`, { status: 500 });
		}
	}

	/**
	 * Called when the activity timer (`sleepAfter`) elapses. The default stops the
	 * container. WebSocket audio frames bypass the SDK's activity tracking (see the `fetch`
	 * override above), so the timer never sees an in-progress call and would sleep it
	 * mid-session — on EVERY routing path, including the direct `container.fetch` path used by
	 * `useDispatcher=false` (VCC) connections, which has no Worker-side renewal loop.
	 *
	 * So before sleeping, ask the container whether any sessions are still live; if so,
	 * keep it alive. This is path-agnostic (it's the DO's own lifecycle hook) and costs
	 * one DO->container request per `sleepAfter` (~7m) — no Worker subrequests.
	 *
	 * Note: `containerFetch` renews the activity timer itself (it proxies a request), so
	 * the probe keeps the container alive in the active branch. In the idle branch we
	 * call the default `onActivityExpired()`, which stops the container explicitly
	 * regardless of the renewed timer.
	 */
	override async onActivityExpired(): Promise<void> {
		try {
			const res = await this.containerFetch('http://container/status', this.defaultPort);
			if (res.ok) {
				const { active = 0, detached = 0 } = (await res.json()) as { active?: number; detached?: number };
				if (active + detached > 0) {
					console.log(`Activity timeout but ${active} active + ${detached} detached session(s) — keeping container alive`);
					// Renew explicitly rather than relying on containerFetch's renew-on-proxy
					// side effect: if a future @cloudflare/containers version stops renewing on
					// probe requests, the keep-alive would silently break. This makes the intent
					// unambiguous (idempotent — just pushes sleepAfterMs out again).
					this.renewActivityTimeout();
					return; // skip the default stop
				}
			} else {
				// Non-2xx from /status: can't trust session state, so allow the default stop —
				// but log it, otherwise a recurring 4xx/5xx that sleeps live calls is invisible.
				console.error(`onActivityExpired: /status returned ${res.status}, allowing container to sleep`);
				// Drain the body. Since SDK 0.2.1 `containerFetch` counts a request as in flight
				// until its body is consumed, and `isActivityExpired()` is permanently false while
				// anything is in flight — an unread error body here would keep this DO's next
				// container alive until the isolate is evicted.
				await res.text().catch(() => undefined);
			}
		} catch (error) {
			// Can't determine session state — fall through to the default stop. If the
			// container is too unhealthy to answer /status it isn't usefully serving a call.
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`onActivityExpired: /status probe failed, allowing container to sleep: ${msg}`);
		}
		await super.onActivityExpired();
	}
}
