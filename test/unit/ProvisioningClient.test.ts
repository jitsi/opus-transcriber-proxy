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

import { describe, it, expect, vi } from 'vitest';
import { ProvisioningClient, ProvisioningResponse } from '../../src/agent/ProvisioningClient';

type Reply = ProvisioningResponse | Error;

function client(replies: Reply[]) {
	const calls: Array<{ method: string; path: string; body?: string }> = [];
	const request = vi.fn(async (method: 'GET' | 'POST', path: string, body?: string) => {
		calls.push({ method, path, body });
		const next = replies.shift();
		if (next instanceof Error) {
			throw next;
		}
		return next ?? { status: 200, body: '' };
	});
	const logger = { info: vi.fn(), warn: vi.fn() };
	const onReportGivenUp = vi.fn();
	const c = new ProvisioningClient({ url: 'http://prosody:5280/voice-agent', token: 't', logger, request, retryDelayMs: 0, onReportGivenUp });
	return { c, request, calls, logger, onReportGivenUp };
}

describe('ProvisioningClient', () => {
	describe('report', () => {
		it('posts the state with conference, agentId and reason to the status route', async () => {
			const { c, calls } = client([{ status: 200, body: '' }]);
			await c.report('room@muc', 'agent-1', 'failed', 'endpoint refused: HTTP 401');
			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe('POST');
			expect(calls[0].path).toBe('status');
			expect(JSON.parse(calls[0].body!)).toEqual({ conference: 'room@muc', agentId: 'agent-1', state: 'failed', reason: 'endpoint refused: HTTP 401' });
		});

		it('retries a transport error or 5xx with backoff, and gives up after five attempts with the conference in the log', async () => {
			const { c, request, logger, onReportGivenUp } = client([new Error('ECONNREFUSED'), { status: 503, body: '' }, { status: 502, body: '' }, { status: 503, body: '' }, { status: 503, body: '' }]);
			await c.report('room@muc', 'agent-1', 'active');
			expect(request).toHaveBeenCalledTimes(5);
			expect(logger.warn.mock.calls.at(-1)?.[0]).toMatch(/agent-1 in room@muc \(active\) gave up after 5 attempts/);
			expect(onReportGivenUp).toHaveBeenCalledWith('active');
		});

		it('succeeds on a later attempt without giving up', async () => {
			const { c, request, onReportGivenUp } = client([{ status: 503, body: '' }, { status: 503, body: '' }, { status: 200, body: '' }]);
			await c.report('room@muc', 'agent-1', 'ended');
			expect(request).toHaveBeenCalledTimes(3);
			expect(onReportGivenUp).not.toHaveBeenCalled();
		});

		it('treats 404 as the agent being gone and does not retry', async () => {
			const { c, request, logger } = client([{ status: 404, body: '{}' }]);
			await c.report('room@muc', 'agent-1', 'ended');
			expect(request).toHaveBeenCalledTimes(1);
			expect(logger.info).toHaveBeenCalledTimes(1);
		});
	});

	describe('dialConfig', () => {
		it('fetches the endpoint and custom parameters by conference and agent id', async () => {
			const { c, calls } = client([{
				status: 200,
				body: JSON.stringify({ agentId: 'agent-1', endpoint: { url: 'wss://bot.example.com/ws', authorization: 'Bearer k' }, customParameters: { campaign: '42' } }),
			}]);
			const config = await c.dialConfig('room@muc', 'agent-1');
			expect(calls[0]).toEqual({ method: 'GET', path: 'dial?conference=room%40muc&agentId=agent-1', body: undefined });
			expect(config).toEqual({ endpoint: { url: 'wss://bot.example.com/ws', authorization: 'Bearer k' }, customParameters: { campaign: '42' } });
		});

		it('carries the customer-facing room name when the API returns one', async () => {
			const { c } = client([{ status: 200, body: JSON.stringify({ conference: 'acme/room1', endpoint: { url: 'wss://bot.example.com/ws' } }) }]);
			expect(await c.dialConfig('[acme]room1@muc', 'agent-1')).toEqual({ conference: 'acme/room1', endpoint: { url: 'wss://bot.example.com/ws' } });
		});

		it('carries the requested media encoding as given, for the caller to check', async () => {
			const { c } = client([
				{ status: 200, body: JSON.stringify({ endpoint: { url: 'wss://bot.example.com/ws' }, mediaFormat: { encoding: 'audio/pcmu' } }) },
				{ status: 200, body: JSON.stringify({ endpoint: { url: 'wss://bot.example.com/ws' }, mediaFormat: { encoding: 7 } }) },
			]);
			expect((await c.dialConfig('room@muc', 'agent-1'))?.mediaFormat).toEqual({ encoding: 'audio/pcmu' });
			expect((await c.dialConfig('room@muc', 'agent-1'))?.mediaFormat).toBeUndefined();
		});

		it('tells a gone agent from an unavailable API, counting an unusable answer as unavailable', async () => {
			const { c } = client([
				{ status: 404, body: '' },
				{ status: 503, body: '' },
				new Error('ETIMEDOUT'),
				{ status: 200, body: 'not json' },
				{ status: 200, body: JSON.stringify({ endpoint: {} }) },
				{ status: 200, body: JSON.stringify({ endpoint: { url: 'wss://bot.example.com/ws' } }) },
			]);
			expect(await c.fetchDialConfig('room@muc', 'agent-1')).toEqual({ status: 'gone' });
			expect(await c.fetchDialConfig('room@muc', 'agent-1')).toEqual({ status: 'unavailable', reason: 'provisioning API answered 503' });
			expect(await c.fetchDialConfig('room@muc', 'agent-1')).toEqual({ status: 'unavailable', reason: 'provisioning API unreachable: ETIMEDOUT' });
			expect(await c.fetchDialConfig('room@muc', 'agent-1')).toEqual({ status: 'unavailable', reason: 'provisioning API answered without JSON' });
			expect(await c.fetchDialConfig('room@muc', 'agent-1')).toEqual({ status: 'unavailable', reason: 'provisioning API answered without endpoint.url' });
			expect(await c.fetchDialConfig('room@muc', 'agent-1')).toEqual({ status: 'ok', config: { endpoint: { url: 'wss://bot.example.com/ws' } } });
		});

		it('carries the requested fan-in as given, dropping a non-string', async () => {
			const { c } = client([
				{ status: 200, body: JSON.stringify({ endpoint: { url: 'wss://bot.example.com/ws' }, fanIn: 'dominant' }) },
				{ status: 200, body: JSON.stringify({ endpoint: { url: 'wss://bot.example.com/ws' }, fanIn: 3 }) },
			]);
			expect((await c.dialConfig('room@muc', 'agent-1'))?.fanIn).toBe('dominant');
			expect((await c.dialConfig('room@muc', 'agent-1'))?.fanIn).toBeUndefined();
		});

		it('never passes on a room name that is an XMPP address', async () => {
			const { c } = client([{ status: 200, body: JSON.stringify({ conference: 'room1@conference.example.com', endpoint: { url: 'wss://bot.example.com/ws' } }) }]);
			expect((await c.dialConfig('room1@conference.example.com', 'agent-1'))?.conference).toBeUndefined();
		});

		it('omits an absent authorization and non-object custom parameters', async () => {
			const { c } = client([{ status: 200, body: JSON.stringify({ endpoint: { url: 'wss://bot.example.com/ws' }, customParameters: 'nope' }) }]);
			expect(await c.dialConfig('room@muc', 'agent-1')).toEqual({ endpoint: { url: 'wss://bot.example.com/ws' } });
		});

		it('returns undefined for a gone agent, a failed fetch, or a malformed body', async () => {
			const { c, logger } = client([{ status: 404, body: '' }, new Error('ECONNREFUSED'), { status: 500, body: '' }, { status: 200, body: 'not json' }, { status: 200, body: '{"endpoint":{}}' }]);
			for (let i = 0; i < 5; i++) {
				expect(await c.dialConfig('room@muc', 'agent-1')).toBeUndefined();
			}
			expect(logger.info).toHaveBeenCalledTimes(1);
			expect(logger.warn).toHaveBeenCalledTimes(4);
		});
	});

	it('does nothing when no url is configured', async () => {
		const request = vi.fn(async () => ({ status: 200, body: '' }));
		const c = new ProvisioningClient({ url: '', logger: { info: vi.fn(), warn: vi.fn() }, request });
		expect(c.enabled).toBe(false);
		await c.report('room@muc', 'agent-1', 'active');
		expect(await c.dialConfig('room@muc', 'agent-1')).toBeUndefined();
		expect(request).not.toHaveBeenCalled();
	});
});
