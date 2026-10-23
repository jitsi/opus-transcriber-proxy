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

/** The WebSocket close-reason limit (RFC 6455 §5.5): 123 bytes of UTF-8, not 123 characters. */
export const MAX_CLOSE_REASON_BYTES = 123;

const utf8 = new TextEncoder();

/** Fits `text` into a close reason: cut by UTF-8 bytes, never in the middle of a character. */
export function closeReason(text: string): string {
	let out = '';
	let bytes = 0;
	for (const ch of text) {
		const n = utf8.encode(ch).length;
		if (bytes + n > MAX_CLOSE_REASON_BYTES) {
			break;
		}
		out += ch;
		bytes += n;
	}
	return out;
}
