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
	const c = new ProvisioningClient({ url: 'http://prosody:5280/voice-agent', token: 't', logger, request, retryDelayMs: 0 });
	return { c, request, calls, logger };
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

		it('retries once on a transport error or 5xx, then gives up', async () => {
			const { c, request, logger } = client([new Error('ECONNREFUSED'), { status: 503, body: '' }]);
			await c.report('room@muc', 'agent-1', 'active');
			expect(request).toHaveBeenCalledTimes(2);
			expect(logger.warn).toHaveBeenCalledTimes(2);
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
