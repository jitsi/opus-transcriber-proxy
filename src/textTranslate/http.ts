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

/**
 * The one HTTP call every text translator makes: POST JSON, get JSON back, bounded by a timeout.
 *
 * Every translation provider is a plain request/response HTTPS API — none of them offers a
 * streaming or WebSocket path that would help here, because a translation is only useful once it is
 * complete (the client renders a `translation-result` as final text).
 */
export async function postJson(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<any> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		// A timeout surfaces as an AbortError; name it so the log says which it was.
		const message = error instanceof Error ? error.message : String(error);
		const isAbort = error instanceof Error && error.name === 'TimeoutError';
		throw new Error(isAbort ? `request timed out after ${timeoutMs}ms` : `request failed: ${message}`);
	}

	if (!response.ok) {
		// The body can echo the request, and the request holds the text of the conversation. So the
		// error carries the status and a short provider error code only, never a slice of the body.
		const body = await response.text().catch(() => '');
		const code = providerErrorCode(body);
		throw new Error(`HTTP ${response.status}${code ? ` (${code})` : ''}`);
	}

	try {
		return await response.json();
	} catch (error) {
		// The text of a parse error can quote the response, so it is not part of the message.
		throw new Error(`could not parse response as JSON${error instanceof Error ? ` (${error.name})` : ''}`);
	}
}

const ERROR_CODE_MAX_LENGTH = 64;
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Pulls a short machine-readable code (`error.code`, `error.type` or `error.status`) out of the
 * JSON body of a provider error. Returns undefined when the body has none, or when the value is
 * not a plain identifier, so free text from the body can never reach a log line.
 */
export function providerErrorCode(body: string): string | undefined {
	let parsed: any;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	const error = parsed?.error;
	for (const candidate of [error?.code, error?.type, error?.status]) {
		const value = typeof candidate === 'number' ? String(candidate) : candidate;
		if (typeof value === 'string' && value.length > 0 && value.length <= ERROR_CODE_MAX_LENGTH && ERROR_CODE_RE.test(value)) {
			return value;
		}
	}
	return undefined;
}
