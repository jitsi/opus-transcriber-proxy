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

import type { MixStats } from './SourceTrack';

/**
 * The mixer's counts as the `event` label values of `otp_agent_mix_events_total`. Everything an operator would
 * alert on is here: what was lost (`pending_dropped`, `decode_error`, `failed_frame`, `skipped_tick`,
 * `skipped_ms`, `out_of_order`), what was repaired (`concealment`, `late_packet`, `resync`), and the totals to
 * hold them against (`packet`, `frame`).
 */
export function mixEventCounts(stats: Readonly<MixStats>): Record<string, number> {
	return {
		packet: stats.packets,
		frame: stats.framesSent,
		limited_frame: stats.framesLimited,
		capped_frame: stats.framesCapped,
		failed_frame: stats.framesFailed,
		skipped_tick: stats.ticksSkipped,
		late_packet: stats.latePackets,
		out_of_order: stats.outOfOrderPackets,
		pending_dropped: stats.pendingDropped,
		decode_error: stats.decodeErrors,
		decoder_failure: stats.decoderFailures,
		concealment: stats.concealments,
		conceal_failure: stats.concealFailures,
		// A late packet and a queue past `maxBufferMs` both move a talk: the anchors that are not the start of one.
		resync: stats.anchorsLate + stats.anchorsDeep,
		skipped_ms: Math.round(stats.skippedMs),
	};
}
