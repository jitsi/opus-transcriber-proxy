/*
 * Copyright @ 2025 - Present, 8x8 Inc
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
import { isAgentEncoding, opusPacketDurationMs } from '../../src/agent/mediaFormat';

describe('agent mediaFormat', () => {
	it('knows the two customer-leg encodings', () => {
		expect(isAgentEncoding('audio/l16')).toBe(true);
		expect(isAgentEncoding('audio/opus')).toBe(true);
		expect(isAgentEncoding('audio/pcmu')).toBe(false);
		expect(isAgentEncoding(undefined)).toBe(false);
	});

	describe('opusPacketDurationMs', () => {
		const toc = (config: number, code: number) => (config << 3) | code;

		it('reads one frame per TOC config (SILK, Hybrid, CELT)', () => {
			expect(opusPacketDurationMs(Uint8Array.of(toc(1, 0), 0))).toBe(20); // SILK NB 20 ms
			expect(opusPacketDurationMs(Uint8Array.of(toc(11, 0), 0))).toBe(60); // SILK WB 60 ms
			expect(opusPacketDurationMs(Uint8Array.of(toc(13, 0), 0))).toBe(20); // Hybrid SWB 20 ms
			expect(opusPacketDurationMs(Uint8Array.of(toc(16, 0), 0))).toBe(2.5); // CELT NB 2.5 ms
			expect(opusPacketDurationMs(Uint8Array.of(toc(31, 0), 0))).toBe(20); // CELT FB 20 ms
		});

		it('counts two frames for codes 1 and 2 and the frame count byte for code 3', () => {
			expect(opusPacketDurationMs(Uint8Array.of(toc(30, 1), 0))).toBe(20);
			expect(opusPacketDurationMs(Uint8Array.of(toc(30, 2), 0))).toBe(20);
			expect(opusPacketDurationMs(Uint8Array.of(toc(28, 3), 8, 0))).toBe(20);
			expect(opusPacketDurationMs(Uint8Array.of(toc(31, 3), 3, 0))).toBe(60);
		});

		it('cannot tell from an empty packet or a code 3 packet without its count byte', () => {
			expect(opusPacketDurationMs(new Uint8Array(0))).toBeUndefined();
			expect(opusPacketDurationMs(Uint8Array.of(toc(31, 3)))).toBeUndefined();
		});
	});
});
