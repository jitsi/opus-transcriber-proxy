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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerInfo } from '../../src/serverInfo';

describe('buildServerInfo', () => {
	const cfEnvKeys = ['CLOUDFLARE_DURABLE_OBJECT_ID', 'CONTAINER_INSTANCE_NAME', 'CLOUDFLARE_LOCATION', 'CLOUDFLARE_COUNTRY_A2', 'SOURCE_IMAGE_TAG'];
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

	it('surfaces sourceImageTag when SOURCE_IMAGE_TAG is set', () => {
		process.env.SOURCE_IMAGE_TAG = 'v1.2.3';
		const info = buildServerInfo({});
		expect(info.sourceImageTag).toBe('v1.2.3');
	});

	it('omits sourceImageTag when SOURCE_IMAGE_TAG is unset', () => {
		const info = buildServerInfo({});
		expect('sourceImageTag' in info).toBe(false);
	});
});
