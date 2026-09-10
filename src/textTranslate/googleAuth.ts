/**
 * Service-account authentication for the Google Cloud Translation provider.
 *
 * Cloud Translation v2 takes either an API key or an OAuth2 bearer token. A deployment that already
 * has a service account (the same `GOOGLE_CREDENTIALS_JSON` used elsewhere) can therefore use it
 * here instead of minting a separate API key, which is one less credential to manage — and an API
 * key cannot be scoped to one API the way a service account can.
 *
 * The flow is the standard JWT bearer grant: sign a short-lived assertion with the account's private
 * key, exchange it for an access token, cache the token until it nearly expires.
 *
 * Signing uses WebCrypto rather than `node:crypto`, so this file stays free of Node-only imports
 * like the rest of `textTranslate/`.
 */

export interface GoogleServiceAccount {
	client_email: string;
	private_key: string;
	token_uri?: string;
	project_id?: string;
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Cloud Translation accepts this scope; it is the one the JSON-key flow documents. */
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Refresh this long before the token actually expires, so an in-flight request cannot use a dead one. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Parse the service-account JSON from configuration.
 *
 * Throws with a message that names the missing field but never contains the key material, because
 * this runs at translator-creation time and the message is logged.
 */
export function parseServiceAccount(json: string): GoogleServiceAccount {
	let parsed: any;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		throw new Error(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed?.client_email !== 'string' || typeof parsed?.private_key !== 'string') {
		throw new Error('missing client_email or private_key');
	}
	return parsed as GoogleServiceAccount;
}

/** Caches one service account's access token and refreshes it when it is close to expiry. */
export class ServiceAccountTokenSource {
	private readonly account: GoogleServiceAccount;
	private readonly timeoutMs: number;
	private token?: string;
	private expiresAt = 0;
	/** In-flight refresh, shared so concurrent translations mint one token, not one each. */
	private pending?: Promise<string>;

	constructor(account: GoogleServiceAccount, timeoutMs: number) {
		this.account = account;
		this.timeoutMs = timeoutMs;
	}

	async getToken(now: number = Date.now()): Promise<string> {
		if (this.token && now < this.expiresAt - EXPIRY_MARGIN_MS) {
			return this.token;
		}
		if (!this.pending) {
			this.pending = this.fetchToken(now).finally(() => {
				this.pending = undefined;
			});
		}
		return this.pending;
	}

	private async fetchToken(now: number): Promise<string> {
		const assertion = await signJwt(this.account, now);
		const response = await fetch(this.account.token_uri || DEFAULT_TOKEN_URI, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion,
			}),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		const body = await response.text();
		if (!response.ok) {
			throw new Error(`token request failed: HTTP ${response.status}: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
		}
		let parsed: any;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error('token response was not JSON');
		}
		if (typeof parsed?.access_token !== 'string') {
			throw new Error('token response carried no access_token');
		}
		const token: string = parsed.access_token;
		this.token = token;
		this.expiresAt = now + (Number(parsed.expires_in) || 3600) * 1000;
		return token;
	}
}

/** Sign the JWT bearer assertion (RS256) for `account`. */
async function signJwt(account: GoogleServiceAccount, now: number): Promise<string> {
	const issuedAt = Math.floor(now / 1000);
	const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
	const claims = base64Url(
		new TextEncoder().encode(
			JSON.stringify({
				iss: account.client_email,
				scope: SCOPE,
				aud: account.token_uri || DEFAULT_TOKEN_URI,
				iat: issuedAt,
				exp: issuedAt + 3600,
			}),
		),
	);
	const input = new TextEncoder().encode(`${header}.${claims}`);
	const key = await crypto.subtle.importKey(
		'pkcs8',
		pemToPkcs8(account.private_key),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, input);
	return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

/** The DER bytes of a PEM-encoded PKCS#8 private key. */
function pemToPkcs8(pem: string): ArrayBuffer {
	// The JSON carries the key with literal "\n" escapes already expanded by JSON.parse.
	const body = pem
		.replace(/-----BEGIN [^-]+-----/, '')
		.replace(/-----END [^-]+-----/, '')
		.replace(/\s+/g, '');
	const binary = atob(body);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
