// Runtime-neutral base64, so the translation core doesn't depend on Node's Buffer (unavailable in a
// Worker without nodejs_compat). Uses atob/btoa, which exist in both Node and workerd.

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000; // stay well under the String.fromCharCode argument-count limit
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}
