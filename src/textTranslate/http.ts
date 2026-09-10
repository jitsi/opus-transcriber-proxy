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
