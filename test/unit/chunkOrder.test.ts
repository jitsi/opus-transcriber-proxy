/*
 * Copyright @ 2026 - present 8x8, Inc.
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
import { ChunkOrder, CHUNK_RESTART_DISTANCE, OLD_PACKETS_FOR_RESTART } from '../../src/translate/chunkOrder';

describe('ChunkOrder', () => {
	it('takes the first packet and each next one, with the number of packets lost before it', () => {
		const order = new ChunkOrder();
		expect(order.next(31456)).toEqual({ lost: 0, restarted: false });
		expect(order.next(31457)).toEqual({ lost: 0, restarted: false });
		expect(order.next(31460)).toEqual({ lost: 2, restarted: false });
	});

	it('says old for a repeated or a late packet, and keeps the last chunk', () => {
		const order = new ChunkOrder();
		order.next(100);
		order.next(102);
		expect(order.next(102)).toBe('old');
		expect(order.next(101)).toBe('old');
		// 103 is still the next one.
		expect(order.next(103)).toEqual({ lost: 0, restarted: false });
	});

	it('takes a chunk far below the last one as a numbering that started again', () => {
		const order = new ChunkOrder();
		order.next(70000);
		expect(order.next(70000 - CHUNK_RESTART_DISTANCE + 1)).toBe('old');
		expect(order.next(70000 - CHUNK_RESTART_DISTANCE)).toEqual({ lost: 0, restarted: true });
		// The new numbering goes on from there.
		expect(order.next(70000 - CHUNK_RESTART_DISTANCE + 2)).toEqual({ lost: 1, restarted: false });
	});

	it('takes a run of old packets as a numbering that started again', () => {
		const order = new ChunkOrder();
		order.next(500);
		// The new numbering begins a little below the old one: each packet alone looks late.
		for (let i = 0; i < OLD_PACKETS_FOR_RESTART; i++) {
			expect(order.next(100 + i)).toBe('old');
		}
		expect(order.next(100 + OLD_PACKETS_FOR_RESTART)).toEqual({ lost: 0, restarted: true });
		expect(order.next(101 + OLD_PACKETS_FOR_RESTART)).toEqual({ lost: 0, restarted: false });
	});

	it('counts only old packets in a row', () => {
		const order = new ChunkOrder();
		order.next(500);
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < OLD_PACKETS_FOR_RESTART; i++) {
				expect(order.next(400)).toBe('old');
			}
			// A new packet between the late ones: they are stragglers, not a new numbering.
			expect(order.next(501 + round)).toEqual({ lost: 0, restarted: false });
		}
	});

	it('forgets the last chunk on reset', () => {
		const order = new ChunkOrder();
		order.next(70000);
		order.reset();
		expect(order.next(4464)).toEqual({ lost: 0, restarted: false });
		expect(order.next(4466)).toEqual({ lost: 1, restarted: false });
	});
});
