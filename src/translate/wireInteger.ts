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

// Worker-safe, because TranslatorConnection needs it. OutgoingConnection and AgentProxy read the bridge's
// numeric fields through the same copy.

/**
 * An integer from a bridge `media` message. The bridge writes `media.chunk` and `media.timestamp` as decimal
 * strings (`"chunk":"31456"`, the VoxImplant-derived format of jicoco-mediajson), and other clients send JSON
 * numbers, so both forms are read. Anything else (absent, a fraction, an empty or non-decimal string, a value
 * past the safe integer range) is `undefined`.
 */
export function wireInteger(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) ? value : undefined;
	}
	if (typeof value === 'string' && /^-?\d+$/.test(value)) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}
