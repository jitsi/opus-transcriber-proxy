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

	it('gives a dial config that names no fan-in the default: the mix, or per-source for Opus', () => {
		expect(resolveDialConfig(ok, true)).toMatchObject({ kind: 'dial', dial: { fanIn: 'mix' } });
		expect(resolveDialConfig({ ...ok, mediaFormat: { encoding: 'audio/l16' }, mix: { bufferMs: 80 } }, true)).toMatchObject({
			kind: 'dial',
			dial: { fanIn: 'mix', mix: { bufferMs: 80 } },
		});
		expect(resolveDialConfig({ ...ok, mediaFormat: { encoding: 'audio/opus' } }, true)).toMatchObject({ kind: 'dial', dial: { fanIn: 'per-source' } });
		expect(resolveDialConfig({ ...ok, fanIn: 'per-source' }, true)).toMatchObject({ kind: 'dial', dial: { fanIn: 'per-source' } });
	});

	it('reads the mix options of a dial config that names no fan-in as those of the mix, and not at all with Opus', () => {
		expect(resolveDialConfig({ ...ok, mix: 'loud' }, true)).toMatchObject({ kind: 'permanent', reason: 'invalid mix: must be an object' });
		const opus = resolveDialConfig({ ...ok, mediaFormat: { encoding: 'audio/opus' }, mix: 'loud' }, true);
		expect(opus).toMatchObject({ kind: 'dial', dial: { fanIn: 'per-source' } });
		expect(opus.kind === 'dial' && opus.dial.mix).toBeUndefined();
	});

	it('is transient when the provisioning API is unavailable or answers garbage, so the bridge retries', () => {
		expect(resolveDial({ status: 'unavailable', reason: 'provisioning API answered 503' }, true)).toEqual({ kind: 'transient', reason: 'provisioning API answered 503' });
		expect(resolveDial({ status: 'unavailable', reason: 'provisioning API answered without JSON' }, true)).toMatchObject({ kind: 'transient' });
	});

	it('is permanent without a report when the agent no longer exists', () => {
		expect(resolveDial({ status: 'gone' }, true)).toEqual({ kind: 'permanent', reason: 'agent no longer exists', report: false });
	});

	it('is permanent without a report when the conference cannot be routed: the report could not be either', () => {
		expect(resolveDial({ status: 'unroutable', reason: 'conference cannot be routed: x' }, true)).toEqual({ kind: 'permanent', reason: 'conference cannot be routed: x', report: false });
	});

	it('is permanent with a report for an agent config the relay cannot act on', () => {
		expect(resolveDialConfig({ ...ok, mediaFormat: { encoding: 'audio/pcmu' } }, true)).toEqual({ kind: 'permanent', reason: 'unsupported media format audio/pcmu', report: true });
		expect(resolveDialConfig({ ...ok, fanIn: 'loudest' }, true)).toEqual({ kind: 'permanent', reason: 'unsupported fan-in loudest', report: true });
		expect(resolveDialConfig({ endpoint: { url: 'not a url' } }, true)).toMatchObject({ kind: 'permanent', reason: 'invalid agent endpoint URL', report: true });
		expect(resolveDialConfig({ endpoint: { url: 'ws://bot.example.com/ws' } }, true)).toMatchObject({ kind: 'permanent', report: true });
	});

	describe('the mix fan-in', () => {
		it('carries the inline options the dial config sets, checked', () => {
			expect(resolveDialConfig({ ...ok, fanIn: 'mix', mix: { bufferMs: 80, continuous: true } }, true)).toMatchObject({
				kind: 'dial',
				dial: { fanIn: 'mix', mix: { bufferMs: 80, continuous: true } },
			});
		});

		it('carries no options when the dial config sets none, so every one falls to the deployment or the default', () => {
			const resolution = resolveDialConfig({ ...ok, fanIn: 'mix' }, true);
			expect(resolution).toMatchObject({ kind: 'dial', dial: { fanIn: 'mix' } });
			expect((resolution as any).dial).not.toHaveProperty('mix');
			expect((resolution as any).dial).not.toHaveProperty('unknownMixOptions');
		});

		it('is permanent with a report for an option it cannot use, naming it', () => {
			expect(resolveDialConfig({ ...ok, fanIn: 'mix', mix: { bufferMs: 9000 } }, true)).toEqual({
				kind: 'permanent',
				reason: expect.stringMatching(/^invalid mix\.bufferMs: /),
				report: true,
			});
			expect(resolveDialConfig({ ...ok, fanIn: 'mix', mix: 'loud' }, true)).toMatchObject({ kind: 'permanent', reason: 'invalid mix: must be an object' });
		});

		it('names the options it does not know and dials all the same', () => {
			expect(resolveDialConfig({ ...ok, fanIn: 'mix', mix: { bufferMs: 40, reverb: 1 } }, true)).toMatchObject({
				kind: 'dial',
				dial: { mix: { bufferMs: 40 }, unknownMixOptions: ['reverb'] },
			});
		});

		it('is permanent with Opus on the customer leg: a mix is decoded audio', () => {
			expect(resolveDialConfig({ ...ok, fanIn: 'mix', mediaFormat: { encoding: 'audio/opus' } }, true)).toEqual({
				kind: 'permanent',
				reason: 'the mix fan-in needs audio/l16, not audio/opus',
				report: true,
			});
		});

		it('does not read mix for another fan-in, not even a bad one', () => {
			const resolution = resolveDialConfig({ ...ok, fanIn: 'dominant', mix: { bufferMs: 9000 } }, true);
			expect(resolution).toMatchObject({ kind: 'dial', dial: { fanIn: 'dominant' } });
			expect((resolution as any).dial).not.toHaveProperty('mix');
		});
	});

	it('allows ws:// only when wss is not required', () => {
		expect(resolveDialConfig({ endpoint: { url: 'ws://127.0.0.1:9091/ws' } }, false)).toMatchObject({ kind: 'dial', dial: { url: 'ws://127.0.0.1:9091/ws' } });
	});
});
