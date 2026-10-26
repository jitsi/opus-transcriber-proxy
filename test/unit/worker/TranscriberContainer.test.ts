/*
 * Copyright @ 2025 - present 8x8, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Unit tests for worker/TranscriberContainer.ts, the container Durable Object: the WebSocket
 * passthrough `fetch()` override, the instance-name env, and the `/status` probe that decides
 * whether an idle-looking container is really idle.
 *
 * `@cloudflare/containers` is replaced by a minimal base class so the subclass's behaviour can
 * be observed without workerd. The base's methods live on its prototype (not as instance
 * fields), otherwise they would shadow the subclass's overrides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@cloudflare/containers', () => {
	class Container {
		ctx: any;
		env: any;
		defaultPort?: number;
		sleepAfter: string | number = '10m';
		envVars: Record<string, string> = {};
		constructor(ctx: any, env: any) {
			this.ctx = ctx;
			this.env = env;
		}
		async fetch(_request: Request): Promise<Response> {
			return new Response('base-fetch');
		}
		async startAndWaitForPorts(_options?: unknown): Promise<void> {}
		async getState(): Promise<{ status: string }> {
			return { status: 'healthy' };
		}
		renewActivityTimeout(): void {}
		async containerFetch(..._args: unknown[]): Promise<Response> {
			return new Response('{}');
		}
		async onActivityExpired(): Promise<void> {}
	}
	return { Container };
});

import { Container } from '@cloudflare/containers';
import { TranscriberContainer } from '../../../worker/TranscriberContainer';

function fixture(opts: { running?: boolean; name?: string; sleepAfter?: string } = {}) {
	// workerd would answer an upgrade with a 101 carrying a socket; Node's Response cannot carry
	// status 101, so the fake answers with a marker body instead.
	const tcpFetch = vi.fn(async (_url: string, _req: Request) => new Response('upgraded-by-container'));
	const getTcpPort = vi.fn(() => ({ fetch: tcpFetch }));
	const ctx = {
		id: { name: opts.name ?? 'session-1', toString: () => 'do-id' },
		container: { running: opts.running ?? true, getTcpPort },
	};
	const env = { OPENAI_API_KEY: 'sk', ...(opts.sleepAfter ? { SLEEP_AFTER: opts.sleepAfter } : {}) };
	const dobj = new TranscriberContainer(ctx as any, env as any);
	return { dobj, ctx, tcpFetch, getTcpPort };
}

const upgrade = (url = 'https://opus.example/transcribe?sessionId=s1') =>
	new Request(url, { headers: { Upgrade: 'websocket' } });

let baseFetch: ReturnType<typeof vi.spyOn>;
let baseStart: ReturnType<typeof vi.spyOn>;
let baseRenew: ReturnType<typeof vi.spyOn>;
let baseExpired: ReturnType<typeof vi.spyOn>;
let baseContainerFetch: ReturnType<typeof vi.spyOn>;
let baseGetState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	baseGetState = vi.spyOn(Container.prototype, 'getState');
	baseFetch = vi.spyOn(Container.prototype, 'fetch');
	baseStart = vi.spyOn(Container.prototype, 'startAndWaitForPorts');
	baseRenew = vi.spyOn(Container.prototype, 'renewActivityTimeout');
	baseExpired = vi.spyOn(Container.prototype, 'onActivityExpired');
	baseContainerFetch = vi.spyOn(Container.prototype, 'containerFetch');
});

describe('TranscriberContainer configuration', () => {
	it('listens on 8080 and sleeps after 7m unless SLEEP_AFTER overrides it', () => {
		expect(fixture().dobj.defaultPort).toBe(8080);
		expect(fixture().dobj.sleepAfter).toBe('7m');
		expect(fixture({ sleepAfter: '20m' }).dobj.sleepAfter).toBe('20m');
	});

	it('gives the container its instance name alongside the forwarded env', () => {
		const { dobj } = fixture({ name: 'pool-3' });
		expect(dobj.envVars.CONTAINER_INSTANCE_NAME).toBe('pool-3');
		expect(dobj.envVars.OPENAI_API_KEY).toBe('sk');
	});
});

describe('TranscriberContainer.fetch', () => {
	it('leaves plain HTTP to the SDK', async () => {
		const { dobj, tcpFetch } = fixture();
		const res = await dobj.fetch(new Request('https://opus.example/status'));
		expect(await res.text()).toBe('base-fetch');
		expect(baseFetch).toHaveBeenCalledTimes(1);
		expect(tcpFetch).not.toHaveBeenCalled();
	});

	it('passes a WebSocket upgrade straight to the container port over plain http', async () => {
		const { dobj, tcpFetch, getTcpPort } = fixture();
		const upstream = new Response('upgraded-by-container');
		tcpFetch.mockResolvedValueOnce(upstream);
		const req = upgrade();
		const res = await dobj.fetch(req);
		// The container port's own Response object comes back untouched: re-wrapping it would drop
		// the `webSocket` that workerd attaches to a 101.
		expect(res).toBe(upstream);
		expect(baseFetch).not.toHaveBeenCalled();
		expect(getTcpPort).toHaveBeenCalledWith(8080);
		expect(tcpFetch).toHaveBeenCalledTimes(1);
		const [url, passed] = tcpFetch.mock.calls[0];
		expect(url).toBe('http://opus.example/transcribe?sessionId=s1');
		expect(passed).toBe(req);
		expect(baseRenew).toHaveBeenCalledTimes(1);
		expect(baseStart).not.toHaveBeenCalled();
	});

	it('matches the Upgrade header case-insensitively', async () => {
		const { dobj, tcpFetch } = fixture();
		await dobj.fetch(new Request('https://opus.example/transcribe', { headers: { Upgrade: 'WebSocket' } }));
		expect(tcpFetch).toHaveBeenCalledTimes(1);
		expect(baseFetch).not.toHaveBeenCalled();
	});

	it('rewrites only the scheme, not a later "https:" in the URL', async () => {
		const { dobj, tcpFetch } = fixture();
		await dobj.fetch(upgrade('https://opus.example/transcribe?openaiCustomUrl=https://x.example/v1'));
		expect(tcpFetch.mock.calls[0][0]).toBe('http://opus.example/transcribe?openaiCustomUrl=https://x.example/v1');
	});

	it('starts a stopped container before connecting, aborting with the request', async () => {
		const { dobj, tcpFetch } = fixture({ running: false });
		const order: string[] = [];
		baseStart.mockImplementation(async () => {
			order.push('start');
		});
		tcpFetch.mockImplementation(async () => {
			order.push('connect');
			return new Response('upgraded-by-container');
		});
		const req = upgrade();
		await dobj.fetch(req);
		expect(order).toEqual(['start', 'connect']);
		expect(baseStart).toHaveBeenCalledWith({ ports: 8080, cancellationOptions: { abort: req.signal } });
	});

	it('also starts when the container is running but the SDK has not marked it healthy yet', async () => {
		const { dobj, tcpFetch } = fixture({ running: true });
		baseGetState.mockResolvedValue({ status: 'starting' });
		await dobj.fetch(upgrade());
		expect(baseStart).toHaveBeenCalledTimes(1);
		expect(tcpFetch).toHaveBeenCalledTimes(1);
	});

	it('answers 500 rather than throwing when the safety-net start fails', async () => {
		const { dobj, tcpFetch } = fixture({ running: false });
		baseStart.mockRejectedValue(new Error('no instance'));
		const res = await dobj.fetch(upgrade());
		expect(res.status).toBe(500);
		expect(await res.text()).toBe('Failed to start container: no instance');
		expect(res.headers.get('X-Container-Failure')).toBe('start_failed');
		expect(tcpFetch).not.toHaveBeenCalled();
	});

	it('maps a no-instance start failure to 503 and a rate-limit to 429 (message substrings and texts track SDK 0.3.7)', async () => {
		const noInstance = fixture({ running: false });
		baseStart.mockRejectedValueOnce(new Error('There is no container instance that can be provided to this durable object'));
		expect((await noInstance.dobj.fetch(upgrade())).status).toBe(503);
		const rateLimited = fixture({ running: false });
		baseStart.mockRejectedValueOnce(new Error('You are requesting too many containers per second'));
		const res = await rateLimited.dobj.fetch(upgrade());
		expect(res.status).toBe(429);
		expect(await res.text()).toBe('You are requesting too many containers per second');
		expect(res.headers.get('X-Container-Failure')).toBe('start_failed');
	});

	it('answers 500 rather than throwing when the Durable Object has no container binding', async () => {
		const { dobj, ctx } = fixture();
		(ctx as any).container = undefined;
		const res = await dobj.fetch(upgrade());
		expect(res.status).toBe(500);
		expect(res.headers.get('X-Container-Failure')).toBe('disconnected');
	});

	it('maps the container-restart error to the same 500 the SDK produces (text tracks SDK 0.3.7)', async () => {
		const { dobj, tcpFetch } = fixture();
		tcpFetch.mockRejectedValue(new Error('Network connection lost.'));
		const res = await dobj.fetch(upgrade());
		expect(res.status).toBe(500);
		expect(await res.text()).toBe('Container suddenly disconnected, try again');
		expect(res.headers.get('X-Container-Failure')).toBe('disconnected');
	});

	it('maps any other connect error to a 500 carrying the message (text tracks SDK 0.3.7)', async () => {
		const { dobj, tcpFetch } = fixture();
		tcpFetch.mockRejectedValue(new Error('connection refused'));
		const res = await dobj.fetch(upgrade());
		expect(res.status).toBe(500);
		expect(await res.text()).toBe('Error proxying request to container: connection refused');
		expect(res.headers.get('X-Container-Failure')).toBe('disconnected');
	});

	it('rethrows a non-Error rejection untouched', async () => {
		const { dobj, tcpFetch } = fixture();
		tcpFetch.mockRejectedValue('weird');
		await expect(dobj.fetch(upgrade())).rejects.toBe('weird');
	});
});

describe('TranscriberContainer.onActivityExpired', () => {
	const status = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

	it('keeps the container alive while sessions are active or detached', async () => {
		const { dobj } = fixture();
		baseContainerFetch.mockResolvedValue(status({ active: 0, detached: 1 }));
		await dobj.onActivityExpired();
		expect(baseContainerFetch).toHaveBeenCalledWith('http://container/status', 8080);
		expect(baseRenew).toHaveBeenCalledTimes(1);
		expect(baseExpired).not.toHaveBeenCalled();
	});

	it('lets the container sleep when no sessions remain', async () => {
		const { dobj } = fixture();
		baseContainerFetch.mockResolvedValue(status({ active: 0, detached: 0 }));
		await dobj.onActivityExpired();
		expect(baseRenew).not.toHaveBeenCalled();
		expect(baseExpired).toHaveBeenCalledTimes(1);
	});

	it('treats a /status with no counts as idle', async () => {
		const { dobj } = fixture();
		baseContainerFetch.mockResolvedValue(status({}));
		await dobj.onActivityExpired();
		expect(baseExpired).toHaveBeenCalledTimes(1);
	});

	it('drains a non-2xx body (the SDK counts an unread body as in flight) and lets the container sleep', async () => {
		const { dobj } = fixture();
		const res = status({ error: 'nope' }, { status: 503 });
		baseContainerFetch.mockResolvedValue(res);
		await dobj.onActivityExpired();
		expect(res.bodyUsed).toBe(true);
		expect(baseRenew).not.toHaveBeenCalled();
		expect(baseExpired).toHaveBeenCalledTimes(1);
	});

	it('lets the container sleep when the probe itself fails', async () => {
		const { dobj } = fixture();
		baseContainerFetch.mockRejectedValue(new Error('container unreachable'));
		await dobj.onActivityExpired();
		expect(baseExpired).toHaveBeenCalledTimes(1);
	});
});
