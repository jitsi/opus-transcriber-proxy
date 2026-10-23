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

/** Audio encodings spoken on the customer leg, chosen per agent at invite time (`mediaFormat.encoding`). */
export type AgentEncoding = 'audio/l16' | 'audio/opus';

export const DEFAULT_AGENT_ENCODING: AgentEncoding = 'audio/l16';

export function isAgentEncoding(value: unknown): value is AgentEncoding {
	return value === 'audio/l16' || value === 'audio/opus';
}

// Frame duration in tenths of a millisecond per TOC config (RFC 6716 §3.1): SILK 10/20/40/60 ms,
// Hybrid 10/20 ms, CELT 2.5/5/10/20 ms.
// prettier-ignore
const FRAME_TENTHS_MS = [
	100, 200, 400, 600, 100, 200, 400, 600, 100, 200, 400, 600,
	100, 200, 100, 200,
	25, 50, 100, 200, 25, 50, 100, 200, 25, 50, 100, 200, 25, 50, 100, 200,
];

/**
 * The audio duration of one Opus packet in ms, from its TOC byte (and frame count byte for code 3), or undefined
 * when the packet is too short to say.
 */
export function opusPacketDurationMs(packet: Uint8Array): number | undefined {
	if (packet.length === 0) {
		return undefined;
	}
	const toc = packet[0];
	const code = toc & 0x03;
	let frames: number;
	if (code === 0) {
		frames = 1;
	} else if (code === 3) {
		if (packet.length < 2) {
			return undefined;
		}
		frames = packet[1] & 0x3f;
	} else {
		frames = 2;
	}
	return (FRAME_TENTHS_MS[toc >> 3] * frames) / 10;
}
