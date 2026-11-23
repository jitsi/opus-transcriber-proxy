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
const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]+$/;

/** A `type` or `code` value: a number, or a short plain identifier. Anything else is free text and is left out. */
function identifierField(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value);
	}
	if (typeof value !== 'string' || value.length === 0 || value.length > FIELD_MAX_LENGTH || !IDENTIFIER_RE.test(value)) {
		return undefined;
	}
	return value;
}

/**
 * Bounds the text of a provider error for a log line or an `onError` message: whitespace collapsed,
 * cut to a short length. Match on the raw string, and pass this one on.
 */
export function boundErrorText(value: unknown): string {
	const text = (typeof value === 'string' ? value : String(value ?? '')).replace(/\s+/g, ' ').trim();
	return text.length > MESSAGE_MAX_LENGTH ? `${text.slice(0, MESSAGE_MAX_LENGTH)}…` : text;
}

/**
 * Describes a failed `JSON.parse` for a log line: the name of the error and the length of the frame. The
 * message of a parse error can quote the start of the input, so it is never part of the description.
 */
export function describeParseFailure(error: unknown, raw?: unknown): string {
	const name = error instanceof Error ? error.name : 'Error';
	let length: number | undefined;
	if (typeof raw === 'string') {
		length = raw.length;
	} else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
		length = raw.byteLength;
	}
	return length === undefined ? name : `${name}, frame of ${length} characters`;
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
	const type = identifierField(inner.type) ?? identifierField(outer.type);
	const code = identifierField(inner.code) ?? identifierField(outer.code) ?? identifierField(outer.err_code);
	const candidates = [inner.message, outer.message, typeof outer.error === 'string' ? outer.error : undefined, outer.err_msg];
	const rawMessage = candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0);
	if (type) {
		parts.push(`type=${type}`);
	}
	if (code) {
		parts.push(`code=${code}`);
	}
	if (rawMessage !== undefined) {
		parts.push(`message=${JSON.stringify(boundErrorText(rawMessage))}`);
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
