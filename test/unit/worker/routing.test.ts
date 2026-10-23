/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
 * Unit tests for worker/routing.ts: which container instance a request is routed to under each
 * ROUTING_MODE.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../../worker/env';
import { selectContainerInstance } from '../../../worker/routing';

const request = (sessionId?: string) =>
	new Request(`https://example.test/transcribe${sessionId ? `?sessionId=${sessionId}` : ''}`);

const env = (overrides: Record<string, unknown> = {}): Env => overrides as unknown as Env;

describe('selectContainerInstance', () => {
	it('session mode: one instance per sessionId, "default" without one', async () => {
		expect(await selectContainerInstance(request('abc'), env({ ROUTING_MODE: 'session' }))).toBe('abc');
		expect(await selectContainerInstance(request(), env({ ROUTING_MODE: 'session' }))).toBe('default');
	});

	it('defaults to session mode when ROUTING_MODE is unset', async () => {
		expect(await selectContainerInstance(request('abc'), env())).toBe('abc');
	});

	it('shared mode: a single fixed instance', async () => {
		expect(await selectContainerInstance(request('abc'), env({ ROUTING_MODE: 'shared' }))).toBe('shared');
	});

	it('pool mode: the same sessionId always lands on the same slot, within the pool size', async () => {
		const e = env({ ROUTING_MODE: 'pool', CONTAINER_POOL_SIZE: '3' });
		const first = await selectContainerInstance(request('conference-1'), e);
		expect(first).toMatch(/^pool-[0-2]$/);
		expect(await selectContainerInstance(request('conference-1'), e)).toBe(first);
	});

	it('pool mode: a request without a sessionId still gets a slot in range', async () => {
		const e = env({ ROUTING_MODE: 'pool', CONTAINER_POOL_SIZE: '2' });
		for (let i = 0; i < 10; i++) {
			expect(await selectContainerInstance(request(), e)).toMatch(/^pool-[01]$/);
		}
	});

	it('autoscale mode: asks the coordinator for an assignment', async () => {
		const fetch = vi.fn(async () => Response.json({ containerId: 'c-7' }));
		const e = env({
			ROUTING_MODE: 'autoscale',
			CONTAINER_COORDINATOR: { idFromName: vi.fn(() => 'global-id'), get: vi.fn(() => ({ fetch })) },
		});
		expect(await selectContainerInstance(request('abc'), e)).toBe('c-7');
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(url)).toBe('http://coordinator/assign');
		expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'abc' });
	});

	it('autoscale mode: refuses a request without a sessionId', async () => {
		await expect(selectContainerInstance(request(), env({ ROUTING_MODE: 'autoscale' }))).rejects.toThrow(/sessionId required/);
	});
});
