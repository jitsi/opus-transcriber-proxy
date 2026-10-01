import { describe, it, expect, vi } from 'vitest';
import { AgentStatusReporter } from '../../src/agent/AgentStatusReporter';

function reporter(statuses: Array<number | Error>) {
	const bodies: string[] = [];
	const send = vi.fn(async (body: string) => {
		bodies.push(body);
		const next = statuses.shift();
		if (next instanceof Error) {
			throw next;
		}
		return next ?? 200;
	});
	const logger = { info: vi.fn(), warn: vi.fn() };
	const r = new AgentStatusReporter({ url: 'http://prosody:5280/voice-agent/status', token: 't', logger, send, retryDelayMs: 0 });
	return { r, send, bodies, logger };
}

describe('AgentStatusReporter', () => {
	it('posts the state with conference, agentId and reason', async () => {
		const { r, send, bodies } = reporter([200]);
		await r.report('room@muc', 'agent-1', 'failed', 'endpoint refused: HTTP 401');
		expect(send).toHaveBeenCalledTimes(1);
		expect(JSON.parse(bodies[0])).toEqual({ conference: 'room@muc', agentId: 'agent-1', state: 'failed', reason: 'endpoint refused: HTTP 401' });
	});

	it('retries once on a transport error or 5xx, then gives up', async () => {
		const { r, send, logger } = reporter([new Error('ECONNREFUSED'), 503]);
		await r.report('room@muc', 'agent-1', 'active');
		expect(send).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	it('treats 404 as the agent being gone and does not retry', async () => {
		const { r, send, logger } = reporter([404]);
		await r.report('room@muc', 'agent-1', 'ended');
		expect(send).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledTimes(1);
	});

	it('does nothing when no url is configured', async () => {
		const send = vi.fn(async () => 200);
		const r = new AgentStatusReporter({ url: '', logger: { info: vi.fn(), warn: vi.fn() }, send });
		expect(r.enabled).toBe(false);
		await r.report('room@muc', 'agent-1', 'active');
		expect(send).not.toHaveBeenCalled();
	});
});
