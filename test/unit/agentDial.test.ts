import { describe, it, expect } from 'vitest';
import { resolveDial, resolveDialConfig } from '../../src/agent/dial';

describe('agent dial resolution', () => {
	const ok = { endpoint: { url: 'wss://bot.example.com/ws', authorization: 'Bearer k' }, conference: 'acme/room', customParameters: { a: '1' } };

	it('resolves a usable dial config, carrying the agent-facing fields', () => {
		expect(resolveDial({ status: 'ok', config: { ...ok, mediaFormat: { encoding: 'audio/opus' }, fanIn: 'dominant' } }, true)).toEqual({
			kind: 'dial',
			dial: { url: 'wss://bot.example.com/ws', authorization: 'Bearer k', customParameters: { a: '1' }, publicConference: 'acme/room', encoding: 'audio/opus', fanIn: 'dominant' },
		});
	});

	it('is transient when the provisioning API is unavailable or answers garbage, so the bridge retries', () => {
		expect(resolveDial({ status: 'unavailable', reason: 'provisioning API answered 503' }, true)).toEqual({ kind: 'transient', reason: 'provisioning API answered 503' });
		expect(resolveDial({ status: 'unavailable', reason: 'provisioning API answered without JSON' }, true)).toMatchObject({ kind: 'transient' });
	});

	it('is permanent without a report when the agent no longer exists', () => {
		expect(resolveDial({ status: 'gone' }, true)).toEqual({ kind: 'permanent', reason: 'agent no longer exists', report: false });
	});

	it('is permanent with a report for an agent config the relay cannot act on', () => {
		expect(resolveDialConfig({ ...ok, mediaFormat: { encoding: 'audio/pcmu' } }, true)).toEqual({ kind: 'permanent', reason: 'unsupported media format audio/pcmu', report: true });
		expect(resolveDialConfig({ ...ok, fanIn: 'loudest' }, true)).toEqual({ kind: 'permanent', reason: 'unsupported fan-in loudest', report: true });
		expect(resolveDialConfig({ endpoint: { url: 'not a url' } }, true)).toMatchObject({ kind: 'permanent', reason: 'invalid agent endpoint URL', report: true });
		expect(resolveDialConfig({ endpoint: { url: 'ws://bot.example.com/ws' } }, true)).toMatchObject({ kind: 'permanent', report: true });
	});

	it('allows ws:// only when wss is not required', () => {
		expect(resolveDialConfig({ endpoint: { url: 'ws://127.0.0.1:9091/ws' } }, false)).toMatchObject({ kind: 'dial', dial: { url: 'ws://127.0.0.1:9091/ws' } });
	});
});
