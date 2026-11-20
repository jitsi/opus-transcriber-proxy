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
import { MAX_CLOSE_REASON_BYTES, closeReason } from '../../src/agent/closeReason';
import { dialFailureReason } from '../../src/agentproxy';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('closeReason', () => {
	it('leaves a short reason alone', () => {
		expect(closeReason('endpoint refused: HTTP 401')).toBe('endpoint refused: HTTP 401');
	});

	it('cuts by UTF-8 bytes, never inside a character', () => {
		const reason = closeReason('é'.repeat(100)); // 200 bytes
		expect(bytes(reason)).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
		expect(reason).toBe('é'.repeat(61)); // 122 bytes: a 62nd would need 124
		expect(closeReason('a'.repeat(200))).toHaveLength(MAX_CLOSE_REASON_BYTES);
	});

	it('gives an unreachable endpoint one reason, with nothing of the error in it', () => {
		for (const message of [
			'connect ECONNREFUSED 10.0.0.5:6379',
			'getaddrinfo ENOTFOUND bot.internal.example',
			'Opening handshake has timed out',
			`connect ECONNREFUSED ${'ü'.repeat(120)}`,
			'endpoint closed before the handshake completed',
		]) {
			expect(dialFailureReason(message), message).toBe('endpoint unreachable');
		}
	});

	it('keeps the HTTP status of a refused dial, within the limit', () => {
		expect(dialFailureReason('Unexpected server response: 401')).toBe('endpoint refused: HTTP 401');
		expect(bytes(dialFailureReason(`Unexpected server response: ${'9'.repeat(200)}`))).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
	});
});
