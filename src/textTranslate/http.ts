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
		// The body carries the provider's error detail. Collapse the whitespace (these bodies are
		// pretty-printed JSON, and this ends up on one log line) and truncate it, because a provider
		// can echo the whole request back.
		const body = await response.text().catch(() => '');
		const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
		throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
	}

	try {
		return await response.json();
	} catch (error) {
		throw new Error(`could not parse response as JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}
