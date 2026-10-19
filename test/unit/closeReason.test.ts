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

	it('keeps a dial failure with non-ASCII text within the limit', () => {
		const reason = dialFailureReason(`connect ECONNREFUSED ${'ü'.repeat(120)}`);
		expect(bytes(reason)).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
		expect(reason.startsWith('endpoint unreachable: connect ECONNREFUSED')).toBe(true);
	});
});
