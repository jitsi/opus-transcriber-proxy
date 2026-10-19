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
