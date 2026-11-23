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

const MESSAGE_MAX_LENGTH = 200;
const FIELD_MAX_LENGTH = 64;

function shortField(value: unknown): string | undefined {
	if (typeof value === 'number') {
		return String(value);
	}
	if (typeof value !== 'string' || value.length === 0) {
		return undefined;
	}
	return value.replace(/\s+/g, ' ').trim().slice(0, FIELD_MAX_LENGTH);
}

/**
 * Describes an error frame of a provider for a log line: its `type`, `code` and `message` fields, and
 * nothing else. The frame itself is never logged, because a provider can put other fields in it, and
 * those can hold the text of a conversation. The message is cut to a short length.
 *
 * The fields are read from the frame, or from its `error` member when it has one (both shapes exist:
 * `{type:'error', message}` and `{type:'error', error:{type, code, message}}`).
 */
export function describeErrorFrame(frame: unknown): string {
	const outer = frame !== null && typeof frame === 'object' ? (frame as Record<string, any>) : {};
	const inner = outer.error !== null && typeof outer.error === 'object' ? (outer.error as Record<string, any>) : {};
	const parts: string[] = [];
	const type = shortField(inner.type) ?? shortField(outer.type);
	const code = shortField(inner.code) ?? shortField(outer.code) ?? shortField(outer.err_code);
	const rawMessage = inner.message ?? outer.message ?? (typeof outer.error === 'string' ? outer.error : undefined) ?? outer.err_msg;
	if (type) {
		parts.push(`type=${type}`);
	}
	if (code) {
		parts.push(`code=${code}`);
	}
	if (typeof rawMessage === 'string' && rawMessage.length > 0) {
		const message = rawMessage.replace(/\s+/g, ' ').trim();
		parts.push(`message=${JSON.stringify(message.length > MESSAGE_MAX_LENGTH ? `${message.slice(0, MESSAGE_MAX_LENGTH)}…` : message)}`);
	}
	return parts.length > 0 ? parts.join(' ') : 'no type, code or message';
}

/** Parses a raw frame and describes it with {@link describeErrorFrame}. A frame that is not JSON gets its length only. */
export function describeRawErrorFrame(raw: unknown): string {
	if (typeof raw !== 'string') {
		return describeErrorFrame(raw);
	}
	try {
		return describeErrorFrame(JSON.parse(raw));
	} catch {
		return `unparsable frame of ${raw.length} characters`;
	}
}
