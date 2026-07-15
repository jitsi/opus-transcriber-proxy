import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerInfo } from '../../src/serverInfo';

describe('buildServerInfo', () => {
	const cfEnvKeys = ['CLOUDFLARE_DURABLE_OBJECT_ID', 'CONTAINER_INSTANCE_NAME', 'CLOUDFLARE_LOCATION', 'CLOUDFLARE_COUNTRY_A2'];
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const k of cfEnvKeys) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of cfEnvKeys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('builds a node-runtime info message with the static fields', () => {
		const info = buildServerInfo({ sessionId: 'sess-1', provider: 'deepgram' });
		expect(info.event).toBe('info');
		expect(info.application).toBe('opus-transcriber-proxy');
		expect(typeof info.gitHash).toBe('string');
		expect(info.runtime).toBe('node');
		expect(info.provider).toBe('deepgram');
		expect(Array.isArray(info.providersAvailable)).toBe(true);
		expect(info.sessionId).toBe('sess-1');
		// No Cloudflare env => no instanceId / location.
		expect(info.instanceId).toBeUndefined();
		expect(info.location).toBeUndefined();
		expect(info.config).toMatchObject({
			forceCommitTimeout: expect.any(Number),
			sessionResumeEnabled: expect.any(Boolean),
			useDispatcher: expect.any(Boolean),
			// Usage-reporting status is surfaced as a boolean flag (URL configured or not), never the URL.
			usageReporting: expect.any(Boolean),
		});
	});

	it('detects the cloudflare container runtime and includes instance/location', () => {
		process.env.CLOUDFLARE_DURABLE_OBJECT_ID = 'do-abc';
		process.env.CLOUDFLARE_LOCATION = 'Vienna';
		process.env.CLOUDFLARE_COUNTRY_A2 = 'AT';

		const info = buildServerInfo({ sessionId: 'sess-2' });
		expect(info.runtime).toBe('cloudflare-container');
		expect(info.instanceId).toBe('do-abc');
		expect(info.location).toEqual({ city: 'Vienna', country: 'AT' });
	});

	it('prefers CONTAINER_INSTANCE_NAME for the instance id', () => {
		process.env.CLOUDFLARE_DURABLE_OBJECT_ID = 'do-abc';
		process.env.CONTAINER_INSTANCE_NAME = 'transcriber-3';
		const info = buildServerInfo({});
		expect(info.instanceId).toBe('transcriber-3');
	});

	it('omits sessionId when not provided', () => {
		const info = buildServerInfo({});
		expect('sessionId' in info).toBe(false);
	});
});
