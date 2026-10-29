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

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { ProvisioningClient, ProvisioningResponse, conferenceRoute } from '../../src/agent/ProvisioningClient';

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

describe('conferenceRoute', () => {
	it('reads tenant and room from a MUC JID, lower-cased, the room decoded as jitsi-meet spells its own', () => {
		expect(conferenceRoute('[Acme]Room1@conference.stage.8x8.vc')).toEqual({ tenant: 'acme', room: 'room1' });
		expect(conferenceRoute(' standup@conference.meet.jitsi ')).toEqual({ room: 'standup' });
		expect(conferenceRoute('team%20sync@conference.meet.jitsi')).toEqual({ room: 'team sync' });
		expect(conferenceRoute('caf%c3%a9@conference.meet.jitsi')).toEqual({ room: 'caf\u00e9' });
		expect(conferenceRoute('a%2fb@conference.meet.jitsi')).toEqual({ room: 'a/b' });
		expect(conferenceRoute('100%@conference.meet.jitsi')).toEqual({ room: '100%' });
	});

	it('reads the public form too', () => {
		expect(conferenceRoute('Acme/Room1')).toEqual({ tenant: 'acme', room: 'room1' });
		expect(conferenceRoute('/standup/')).toEqual({ room: 'standup' });
		expect(conferenceRoute('acme/Team Sync')).toEqual({ tenant: 'acme', room: 'team sync' });
	});

	it('refuses what is not one tenant and one room', () => {
		expect(() => conferenceRoute('[acme]@conference.x')).toThrow(/does not name one room/);
		expect(() => conferenceRoute('a/b/c')).toThrow(/does not name one room/);
		expect(() => conferenceRoute('[]room@conference.x')).toThrow(/does not name a tenant/);
		expect(() => conferenceRoute('../voice-agent')).toThrow(/does not name a tenant/);
		expect(() => conferenceRoute('')).toThrow(/does not name one room/);
	});
});

describe('ProvisioningClient with haproxy routing', () => {
	function routed(replies: Reply[], url = 'https://signal-api-meet-stage-8x8.jitsi.net/voice-agent') {
		const calls: Array<{ method: string; path: string }> = [];
		const request = vi.fn(async (method: 'GET' | 'POST', path: string) => {
			calls.push({ method, path });
			return replies.shift() ?? { status: 200, body: '' };
		});
		const c = new ProvisioningClient({ url, routing: 'haproxy', token: 't', logger: { info: vi.fn(), warn: vi.fn() }, request, retryDelayMs: 0 });
		return { c, calls };
	}

	it('puts the tenant before the base path and the room in the query, for dial and status', async () => {
		const { c, calls } = routed([{ status: 200, body: JSON.stringify({ endpoint: { url: 'wss://bot.example/ws' } }) }, { status: 200, body: '' }]);
		await c.dialConfig('[acme]room1@conference.stage.8x8.vc', 'agent-1');
		await c.report('[acme]room1@conference.stage.8x8.vc', 'agent-1', 'active');
		expect(calls[0].path).toBe('/acme/voice-agent/dial?conference=%5Bacme%5Droom1%40conference.stage.8x8.vc&agentId=agent-1&room=room1');
		expect(calls[1].path).toBe('/acme/voice-agent/status?room=room1');
	});

	it('has no tenant prefix for a plain room and keeps a deeper base path', async () => {
		const { c, calls } = routed([{ status: 200, body: '' }], 'https://gateway.example/v1/voice-agent');
		await c.report('standup@conference.meet.jitsi', 'agent-1', 'ended');
		expect(calls[0].path).toBe('/v1/voice-agent/status?room=standup');
	});

	it('spells the room as jitsi-meet spells its own ?room=: decoded, lower-cased, form-encoded', async () => {
		const ok = { status: 200, body: '' };
		const { c, calls } = routed([ok, ok, ok, ok, ok, ok, ok]);
		await c.report('[acme]room(1)@conference.stage.8x8.vc', 'agent-1', 'ended');
		await c.report('team%20sync@conference.meet.jitsi', 'agent-1', 'ended');
		await c.report('Team Sync', 'agent-1', 'ended');
		await c.report('caf%c3%a9@conference.meet.jitsi', 'agent-1', 'ended');
		await c.report('a%2bb@conference.meet.jitsi', 'agent-1', 'ended');
		await c.report('%ef%ac%81le@conference.meet.jitsi', 'agent-1', 'ended');
		await c.report('100%@conference.meet.jitsi', 'agent-1', 'ended');
		expect(calls.map((call) => call.path)).toEqual([
			'/acme/voice-agent/status?room=room%281%29',
			'/voice-agent/status?room=team+sync',
			'/voice-agent/status?room=team+sync',
			'/voice-agent/status?room=caf%C3%A9',
			'/voice-agent/status?room=a%2Bb',
			'/voice-agent/status?room=file',
			'/voice-agent/status?room=100%25',
		]);
	});

	it('does not read the conference under direct routing', async () => {
		const calls: string[] = [];
		const request = vi.fn(async (_method: string, path: string) => {
			calls.push(path);
			return { status: 200, body: '' };
		});
		const c = new ProvisioningClient({ url: 'https://prosody.example/voice-agent', logger: { info: vi.fn(), warn: vi.fn() }, request, retryDelayMs: 0 });
		await c.report('a/b/c', 'agent-1', 'ended');
		expect(calls).toEqual(['status']);
	});

	it('warns once per report that a breakout room cannot be placed, retries included', async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const replies: ProvisioningResponse[] = [{ status: 503, body: '' }, { status: 503, body: '' }, { status: 200, body: '' }];
		const request = vi.fn(async () => replies.shift() ?? { status: 200, body: '' });
		const c = new ProvisioningClient({ url: 'https://signal-api.example/voice-agent', routing: 'haproxy', logger, request, retryDelayMs: 0 });
		await c.report('6f1c-breakout@breakout.stage.8x8.vc', 'agent-1', 'ended');
		expect(request).toHaveBeenCalledTimes(3);
		expect(logger.warn.mock.calls.filter((call) => /cannot place breakout room/.test(String(call[0])))).toHaveLength(1);
	});

	it('keeps a hostile tenant inside one path segment', async () => {
		const { c, calls } = routed([{ status: 200, body: '' }]);
		await c.report('[a/../b?x#y]room@conference.x', 'agent-1', 'ended');
		expect(calls[0].path).toBe('/a%2F..%2Fb%3Fx%23y/voice-agent/status?room=room');
	});

	it('gives up at once, without a request, on a conference it cannot route', async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const onReportGivenUp = vi.fn();
		const request = vi.fn(async () => ({ status: 200, body: '' }));
		const c = new ProvisioningClient({ url: 'https://signal-api.example/voice-agent', routing: 'haproxy', logger, request, retryDelayMs: 0, onReportGivenUp });
		await c.report('[acme]@conference.x', 'agent-1', 'active');
		expect(request).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/cannot be routed/));
		expect(onReportGivenUp).toHaveBeenCalledWith('active');
		expect(await c.fetchDialConfig('a/b/c', 'agent-1')).toEqual({ status: 'unroutable', reason: expect.stringMatching(/does not name one room/) });
		expect(request).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Dial config fetch for agent agent-1 cannot be routed/));
	});

	it('tells a 404 for the room from one for the agent: a misrouted dial is retryable, a misrouted report gives up with the path logged', async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const onReportGivenUp = vi.fn();
		const roomNotFound = { status: 404, body: JSON.stringify({ error: 'Room not found' }) };
		const agentNotFound = { status: 404, body: JSON.stringify({ error: 'Agent not found' }) };
		const replies = [roomNotFound, roomNotFound, agentNotFound];
		const request = vi.fn(async () => replies.shift() ?? { status: 200, body: '' });
		const c = new ProvisioningClient({ url: 'https://signal-api.example/voice-agent', routing: 'haproxy', logger, request, retryDelayMs: 0, onReportGivenUp });
		expect(await c.fetchDialConfig('[acme]room1@conference.x', 'agent-1')).toEqual({ status: 'unavailable', reason: expect.stringMatching(/does not know the room/) });
		await c.report('[acme]room1@conference.x', 'agent-1', 'active');
		expect(request).toHaveBeenCalledTimes(2);
		expect(onReportGivenUp).toHaveBeenCalledWith('active');
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^agent agent-1 in \[acme\]room1@conference\.x \(active\): \/acme\/voice-agent\/status\?room=room1 answered 404/));
		await c.report('[acme]room1@conference.x', 'agent-1', 'ended');
		expect(onReportGivenUp).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/agent no longer exists/));
	});

	it('leaves a 404 without a readable body as the agent being gone under haproxy routing', async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const request = vi.fn(async () => ({ status: 404, body: 'not found' }));
		const c = new ProvisioningClient({ url: 'https://signal-api.example/voice-agent', routing: 'haproxy', logger, request, retryDelayMs: 0 });
		expect(await c.fetchDialConfig('room1@conference.x', 'agent-1')).toEqual({ status: 'gone' });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('leaves a 404 as the agent being gone under direct routing, whatever the body says', async () => {
		const logger = { info: vi.fn(), warn: vi.fn() };
		const request = vi.fn(async () => ({ status: 404, body: JSON.stringify({ error: 'Room not found' }) }));
		const c = new ProvisioningClient({ url: 'https://prosody.example/voice-agent', logger, request, retryDelayMs: 0 });
		expect(await c.fetchDialConfig('room1@conference.x', 'agent-1')).toEqual({ status: 'gone' });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('resolves the routed path on the API origin and keeps the Host override, over a real socket', async () => {
		const seen: Array<{ url?: string; host?: string }> = [];
		const server = http.createServer((req, res) => {
			seen.push({ url: req.url, host: req.headers.host });
			res.statusCode = 200;
			res.end('');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			const logger = { info: vi.fn(), warn: vi.fn() };
			const viaHaproxy = new ProvisioningClient({ url: `http://127.0.0.1:${port}/voice-agent/`, routing: 'haproxy', host: 'signal-api.example', token: 't', logger, retryDelayMs: 0 });
			await viaHaproxy.report('[acme]room1@conference.x', 'agent-1', 'active');
			const direct = new ProvisioningClient({ url: `http://127.0.0.1:${port}/v1/voice-agent/`, token: 't', logger, retryDelayMs: 0 });
			await direct.report('room1@conference.x', 'agent-1', 'active');
			expect(seen).toEqual([
				{ url: '/acme/voice-agent/status?room=room1', host: 'signal-api.example' },
				{ url: '/v1/voice-agent/status', host: `127.0.0.1:${port}` },
			]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

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
