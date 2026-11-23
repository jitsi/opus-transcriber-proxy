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
import { boundErrorText, describeErrorFrame, describeParseFailure, describeRawErrorFrame } from '../../src/errorFrame';

describe('describeErrorFrame', () => {
	it('reads type, code and message from the error member', () => {
		expect(
			describeErrorFrame({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Voice not found' } }),
		).toBe('type=invalid_request_error code=invalid_value message="Voice not found"');
	});

	it('reads a flat frame', () => {
		expect(describeErrorFrame({ type: 'error', message: 'ASR stream timed out' })).toBe('type=error message="ASR stream timed out"');
	});

	it('reads a numeric code and a string error', () => {
		expect(describeErrorFrame({ code: 3804, error: 'timeout' })).toBe('code=3804 message="timeout"');
	});

	it('leaves out every other field of the frame', () => {
		const text = describeErrorFrame({ type: 'error', message: 'failed', transcript: 'what she said', item: { text: 'more words' } });

		expect(text).toBe('type=error message="failed"');
		expect(text).not.toContain('what she said');
		expect(text).not.toContain('more words');
	});

	it('cuts a long message', () => {
		expect(describeErrorFrame({ message: 'x'.repeat(500) }).length).toBeLessThan(260);
	});

	it('says so when the frame has nothing to report', () => {
		expect(describeErrorFrame({ foo: 'bar' })).toBe('no type, code or message');
		expect(describeErrorFrame(null)).toBe('no type, code or message');
	});
});

describe('describeRawErrorFrame', () => {
	it('describes a JSON string', () => {
		expect(describeRawErrorFrame('{"type":"error","message":"nope","other":"words"}')).toBe('type=error message="nope"');
	});

	it('gives the length of a frame that is not JSON, not the frame', () => {
		const text = describeRawErrorFrame('she said it was fine');

		expect(text).toBe('unparsable frame of 20 characters');
	});
});

describe('describeErrorFrame fields', () => {
	it('leaves out a type or code that is free text', () => {
		expect(describeErrorFrame({ type: 'she said it was fine', code: 'what she said', message: 'failed' })).toBe('message="failed"');
	});

	it('falls back to the outer message when the inner one is not a string', () => {
		expect(describeErrorFrame({ type: 'error', message: 'outer', error: { message: { text: 'what she said' } } })).toBe(
			'type=error message="outer"',
		);
	});
});

describe('boundErrorText', () => {
	it('collapses whitespace and cuts the text', () => {
		expect(boundErrorText('a  b\n\tc')).toBe('a b c');
		expect(boundErrorText('x'.repeat(500)).length).toBe(201);
	});
});

describe('describeParseFailure', () => {
	it('names the error and gives the length, never the message', () => {
		const error = new SyntaxError('Unexpected token \'s\', "she said"... is not valid JSON');

		expect(describeParseFailure(error, 'she said it was fine')).toBe('SyntaxError, frame of 20 characters');
		expect(describeParseFailure(error)).toBe('SyntaxError');
	});
});
