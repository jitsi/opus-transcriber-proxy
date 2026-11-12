/*
 * Copyright @ 2026 - present 8x8, Inc.
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
 * Unit tests for the Worker entry point (worker/index.ts), for the path a WebSocket upgrade takes
 * to the container: the plain pass-through (`container.fetch`, no per-message code in the Worker)
 * or `handleWebSocketWithDispatcher` (the Worker terminates both sockets and runs a handler on
 * every frame in both directions, to find the final transcripts it forwards to the Dispatcher DO).
 *
 * Only `/transcribe` produces transcripts, so only `/transcribe` may take the dispatcher path.
 * `/agent` carries media and control events only: relaying it through the Worker spends CPU on
 * every frame for no benefit, and a long session reaches the Worker's CPU limit.
 *
 * The container SDK, the session proxy and the container stub are fakes. Node's Response cannot
 * carry status 101, so the fake container answers with a marker body instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@cloudflare/containers', () => {
	class Container {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	return { Container, getContainer: vi.fn(), ContainerProxy: class {} };
});

// index.ts re-exports the ContainerCoordinator Durable Object, which extends workerd's base class.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

// The /translate path imports the Emscripten .wasm modules, which vite cannot load; these tests
// never take that path.
vi.mock('../../../worker/handleTranslate', () => ({ handleTranslate: vi.fn() }));

vi.mock('../../../worker/sessionProxy', () => ({
	handleWebSocketWithDispatcher: vi.fn(async () => new Response('via-dispatcher-proxy')),
}));

import { getContainer } from '@cloudflare/containers';
import worker from '../../../worker/index';
import { handleWebSocketWithDispatcher } from '../../../worker/sessionProxy';

const containerFetch = vi.fn(async (_request: Request) => new Response('passed-through-to-container'));
const startAndWaitForPorts = vi.fn(async (_options?: unknown) => {});

/** A Worker env with the dispatcher on by default and its Durable Object bound. */
const env = (overrides: Record<string, unknown> = {}) =>
	({
		ROUTING_MODE: 'session',
		USE_DISPATCHER: 'true',
		DISPATCHER_DO: {},
		TRANSCRIBER: {},
		...overrides,
	}) as never;

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as never;

const upgrade = (path: string) => new Request(`https://opus.example${path}`, { headers: { Upgrade: 'websocket' } });

const AGENT = '/agent?sessionId=s1&conference=room%40conference.example&agentId=agent-1';
const TRANSCRIBE = '/transcribe?sessionId=s1&sendBack=true';

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getContainer).mockReturnValue({ startAndWaitForPorts, fetch: containerFetch } as never);
});

describe('worker fetch: dispatcher path selection', () => {
	it('passes an /agent upgrade through to the container when USE_DISPATCHER is on', async () => {
		const response = await worker.fetch(upgrade(AGENT), env(), ctx());

		expect(handleWebSocketWithDispatcher).not.toHaveBeenCalled();
		expect(containerFetch).toHaveBeenCalledTimes(1);
		expect(await response.text()).toBe('passed-through-to-container');
	});

	it('passes an /agent upgrade through even when the connect asks for the dispatcher', async () => {
		await worker.fetch(upgrade(`${AGENT}&useDispatcher=true`), env(), ctx());

		expect(handleWebSocketWithDispatcher).not.toHaveBeenCalled();
		expect(containerFetch).toHaveBeenCalledTimes(1);
	});

	it('passes a tenant-prefixed /agent upgrade through', async () => {
		await worker.fetch(upgrade('/tenant/agent?sessionId=s1&agentId=a'), env(), ctx());

		expect(handleWebSocketWithDispatcher).not.toHaveBeenCalled();
		expect(containerFetch).toHaveBeenCalledTimes(1);
	});

	it('passes an upgrade on any other path through, even with the dispatcher on', async () => {
		await worker.fetch(upgrade('/foo?sessionId=s1'), env(), ctx());

		expect(handleWebSocketWithDispatcher).not.toHaveBeenCalled();
		expect(containerFetch).toHaveBeenCalledTimes(1);
	});

	it('still sends a /transcribe upgrade through the dispatcher proxy when USE_DISPATCHER is on', async () => {
		const response = await worker.fetch(upgrade(TRANSCRIBE), env(), ctx());

		expect(handleWebSocketWithDispatcher).toHaveBeenCalledTimes(1);
		// (request, container, env, ctx, sessionId, ...): the session id from the URL is passed on.
		expect(vi.mocked(handleWebSocketWithDispatcher).mock.calls[0][4]).toBe('s1');
		expect(containerFetch).not.toHaveBeenCalled();
		expect(await response.text()).toBe('via-dispatcher-proxy');
	});

	it('sends a tenant-prefixed /transcribe upgrade through the dispatcher proxy', async () => {
		await worker.fetch(upgrade('/tenant/transcribe?sessionId=s1&sendBack=true'), env(), ctx());

		expect(handleWebSocketWithDispatcher).toHaveBeenCalledTimes(1);
		expect(containerFetch).not.toHaveBeenCalled();
	});

	it('sends a /transcribe upgrade through the dispatcher proxy when only the connect asks for it', async () => {
		await worker.fetch(upgrade(`${TRANSCRIBE}&useDispatcher=true`), env({ USE_DISPATCHER: 'false' }), ctx());

		expect(handleWebSocketWithDispatcher).toHaveBeenCalledTimes(1);
	});

	it('passes a /transcribe upgrade through when the connect turns the dispatcher off', async () => {
		await worker.fetch(upgrade(`${TRANSCRIBE}&useDispatcher=false`), env(), ctx());

		expect(handleWebSocketWithDispatcher).not.toHaveBeenCalled();
		expect(containerFetch).toHaveBeenCalledTimes(1);
	});

	it('passes a /transcribe upgrade through when the dispatcher Durable Object is not bound', async () => {
		await worker.fetch(upgrade(TRANSCRIBE), env({ DISPATCHER_DO: undefined }), ctx());

		expect(handleWebSocketWithDispatcher).not.toHaveBeenCalled();
		expect(containerFetch).toHaveBeenCalledTimes(1);
	});
});
