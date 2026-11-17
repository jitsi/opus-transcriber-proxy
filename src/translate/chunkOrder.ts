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

// Worker-safe, because TranslatorConnection needs it. Every reader of the bridge's `chunk` uses these rules:
// the audio decoders of /transcribe, TranslatorConnection, and both /agent paths (the Opus relay and the mix).

/** A `chunk` this far below the last one is a stream whose numbering started again, not an old packet. */
export const CHUNK_RESTART_DISTANCE = 1000;
/** This many packets in a row that all look old are a numbering that started again too, not stragglers. */
export const OLD_PACKETS_FOR_RESTART = 10;

/**
 * What {@link ChunkOrder.next} says about a packet. `'old'`: it is at or below the last chunk, so it arrived late
 * or twice. Otherwise the packet is the next one to use: `lost` packets are missing before it, and `restarted`
 * says that the numbering started again with it (`lost` is then 0, because the old and the new numbers do not
 * compare).
 */
export type ChunkStep = 'old' | { lost: number; restarted: boolean };

/**
 * The order of one stream's packets by their `chunk`. The bridge's numbering starts again with a `start` event for
 * the stream, and the owner then calls {@link reset} (docs/claude/protocol.md says why the new numbers can be far
 * below the old ones). If that event is ever missed, a reader that only compared with the last chunk would take
 * every packet as old until the numbers caught up, which is 22 minutes of audio for each 65536 of distance. So a
 * numbering that starts again without the event is recognised here: by one chunk far below the last one, or by a
 * run of packets that all look old.
 */
export class ChunkOrder {
	private last: number | undefined;
	private consecutiveOld = 0;

	/** Classify the packet with this chunk, and take it as the last one unless it is old. */
	next(chunk: number): ChunkStep {
		const last = this.last;
		if (last === undefined) {
			this.last = chunk;
			return { lost: 0, restarted: false };
		}
		const delta = chunk - last;
		if (delta > 0) {
			this.consecutiveOld = 0;
			this.last = chunk;
			return { lost: delta - 1, restarted: false };
		}
		if (delta > -CHUNK_RESTART_DISTANCE && ++this.consecutiveOld <= OLD_PACKETS_FOR_RESTART) {
			return 'old';
		}
		this.consecutiveOld = 0;
		this.last = chunk;
		return { lost: 0, restarted: true };
	}

	/** Forget the last chunk: the next packet is the first of its stream. */
	reset(): void {
		this.last = undefined;
		this.consecutiveOld = 0;
	}
}
