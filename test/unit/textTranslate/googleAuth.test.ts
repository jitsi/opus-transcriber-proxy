/**
 * Tests for the service-account credential path of the Google translator: parsing, JWT signing,
 * and token caching. The JWT is signed with a real generated RSA key, so the WebCrypto path is
 * exercised rather than mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseServiceAccount, ServiceAccountTokenSource } from '../../../src/textTranslate/googleAuth';

/** A throwaway service account whose private key really can sign. */
async function testAccount(overrides: Record<string, unknown> = {}) {
	const pair = await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	);
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	let binary = '';
	for (const byte of pkcs8) binary += String.fromCharCode(byte);
	const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
	return {
		type: 'service_account',
		project_id: 'jitsi-test',
		client_email: 'translator@jitsi-test.iam.gserviceaccount.com',
		private_key: pem,
		token_uri: 'https://oauth2.googleapis.com/token',
		...overrides,
	};
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function respondToken(accessToken: string, expiresIn = 3600) {
	fetchMock.mockResolvedValue({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
	});
}

describe('parseServiceAccount', () => {
	it('parses a well-formed key', async () => {
		const account = await testAccount();
		expect(parseServiceAccount(JSON.stringify(account)).client_email).toBe(account.client_email);
	});

	it('rejects text that is not JSON', () => {
		expect(() => parseServiceAccount('not json')).toThrow(/not valid JSON/);
	});

	it('rejects JSON that is missing the fields it needs', () => {
		expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow(/client_email or private_key/);
	});
});

describe('ServiceAccountTokenSource', () => {
	it('exchanges a signed assertion for an access token', async () => {
		const account = await testAccount();
		respondToken('token-1');

		const source = new ServiceAccountTokenSource(parseServiceAccount(JSON.stringify(account)), 5000);
		await expect(source.getToken()).resolves.toBe('token-1');

		expect(fetchMock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
		const body = new URLSearchParams(fetchMock.mock.calls[0][1].body.toString());
		expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

		// A real three-part JWT whose claims name the account and the cloud-platform scope.
		const [header, claims, signature] = body.get('assertion')!.split('.');
		expect(signature.length).toBeGreaterThan(0);
		expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
		const parsedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString());
		expect(parsedClaims.iss).toBe(account.client_email);
		expect(parsedClaims.scope).toBe('https://www.googleapis.com/auth/cloud-platform');
		expect(parsedClaims.exp - parsedClaims.iat).toBe(3600);
	});

	it('reuses a live token instead of minting one per translation', async () => {
		respondToken('token-1');
		const source = new ServiceAccountTokenSource(parseServiceAccount(JSON.stringify(await testAccount())), 5000);

		await source.getToken(1000);
		await source.getToken(2000);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('refreshes before the token actually expires', async () => {
		respondToken('token-1', 3600);
		const source = new ServiceAccountTokenSource(parseServiceAccount(JSON.stringify(await testAccount())), 5000);
		await source.getToken(0);

		respondToken('token-2');
		// Inside the 60s margin: still valid to the server, but too close to hand to a new request.
		await expect(source.getToken(3_600_000 - 30_000)).resolves.toBe('token-2');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('mints one token for concurrent callers', async () => {
		respondToken('token-1');
		const source = new ServiceAccountTokenSource(parseServiceAccount(JSON.stringify(await testAccount())), 5000);

		const [a, b] = await Promise.all([source.getToken(), source.getToken()]);

		expect([a, b]).toEqual(['token-1', 'token-1']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('reports a rejected assertion', async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 400,
			text: async () => '{"error":"invalid_grant"}',
		});
		const source = new ServiceAccountTokenSource(parseServiceAccount(JSON.stringify(await testAccount())), 5000);

		await expect(source.getToken()).rejects.toThrow(/token request failed: HTTP 400.*invalid_grant/);
	});

	it('retries after a failure rather than caching it', async () => {
		fetchMock.mockRejectedValueOnce(new Error('network down'));
		const source = new ServiceAccountTokenSource(parseServiceAccount(JSON.stringify(await testAccount())), 5000);
		await expect(source.getToken()).rejects.toThrow(/network down/);

		respondToken('token-1');
		await expect(source.getToken()).resolves.toBe('token-1');
	});
});
