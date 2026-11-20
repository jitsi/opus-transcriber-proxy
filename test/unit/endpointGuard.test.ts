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
 * Tests for the /agent SSRF guard: private-range classification, host allowlist and denylist matching, the
 * port list, and the combined resolve-and-check for IP literals. (Hostname DNS resolution is exercised via
 * IP literals; the lookup is mocked, so a test can tell whether a host name was resolved at all.)
 */

import { describe, it, expect, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { assertPublicEndpointHost, endpointPortError, hostAllowed, hostDenied, isPrivateAddress } from '../../src/agent/endpointGuard';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

describe('endpointGuard.isPrivateAddress', () => {
	it('flags IPv4 private, loopback, link-local and metadata addresses', () => {
		for (const ip of [ '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '127.0.0.1',
			'169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1' ]) {
			expect(isPrivateAddress(ip)).toBe(true);
		}
	});

	it('allows IPv4 public addresses', () => {
		// 203.0.113.0/24 (documentation) is reserved, hence non-public, like the other IANA special-purpose blocks.
		for (const ip of [ '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1' ]) {
			expect(isPrivateAddress(ip)).toBe(false);
		}
	});

	it('flags IPv6 loopback, unique-local, link-local and site-local', () => {
		for (const ip of [ '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1' ]) {
			expect(isPrivateAddress(ip)).toBe(true);
		}
	});

	it('classifies IPv4-mapped IPv6 in hex and expanded spellings by the embedded address', () => {
		for (const ip of [ '::ffff:a00:1', '::FFFF:7f00:1', '0:0:0:0:0:ffff:c0a8:101', '::ffff:a9fe:a9fe' ]) {
			expect(isPrivateAddress(ip)).toBe(true);
		}
		for (const ip of [ '::ffff:808:808', '0:0:0:0:0:ffff:5db8:d822' ]) {
			expect(isPrivateAddress(ip)).toBe(false);
		}
	});

	it('classifies IPv4-mapped IPv6 by the embedded address', () => {
		expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
		expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
	});

	it('allows IPv6 public addresses', () => {
		expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
	});

	it('flags IPv4 embedded in IPv6 (NAT64, 6to4, Teredo) and the reserved IPv4 blocks', () => {
		expect(isPrivateAddress('64:ff9b::7f00:1')).toBe(true); // NAT64 of 127.0.0.1
		expect(isPrivateAddress('64:ff9b::808:808')).toBe(true); // NAT64 of 8.8.8.8: not a plain public host either
		expect(isPrivateAddress('2002:7f00:1::1')).toBe(true); // 6to4
		expect(isPrivateAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(true); // Teredo
		expect(isPrivateAddress('192.0.0.1')).toBe(true);
		expect(isPrivateAddress('198.18.0.1')).toBe(true);
		expect(isPrivateAddress('192.0.2.1')).toBe(true); // documentation
	});

	it('treats non-IP input as unsafe', () => {
		expect(isPrivateAddress('not-an-ip')).toBe(true);
	});
});

describe('endpointGuard.hostAllowed', () => {
	it('allows any host when the allowlist is empty', () => {
		expect(hostAllowed('anything.example.com', [])).toBe(true);
	});

	it('matches an exact host and its subdomains, with a dot boundary', () => {
		const list = [ 'example.com' ];

		expect(hostAllowed('example.com', list)).toBe(true);
		expect(hostAllowed('agents.example.com', list)).toBe(true);
		expect(hostAllowed('evilexample.com', list)).toBe(false);
		expect(hostAllowed('example.com.attacker.net', list)).toBe(false);
	});

	it('treats a leading dot on an entry as equivalent', () => {
		expect(hostAllowed('agents.example.com', [ '.example.com' ])).toBe(true);
		expect(hostAllowed('example.com', [ '.example.com' ])).toBe(true);
	});
});

describe('endpointGuard.hostDenied', () => {
	it('denies nothing when the list is empty', () => {
		expect(hostDenied('anything.example.com', [])).toBe(false);
	});

	it('matches an exact host and its subdomains, with a dot boundary, as the allowlist does', () => {
		for (const list of [ [ 'example.com' ], [ '.example.com' ] ]) {
			expect(hostDenied('example.com', list)).toBe(true);
			expect(hostDenied('meet.example.com', list)).toBe(true);
			expect(hostDenied('evilexample.com', list)).toBe(false);
			expect(hostDenied('example.com.attacker.net', list)).toBe(false);
		}
	});

	it('matches a host written with a trailing dot, which names the same host', () => {
		expect(hostDenied('meet.example.com.', [ 'example.com' ])).toBe(true);
		expect(hostDenied('example.com..', [ 'example.com' ])).toBe(true);
	});
});

describe('endpointGuard.endpointPortError', () => {
	const error = (url: string, ports: number[]) => endpointPortError(new URL(url), ports);

	it('allows every port when the list is empty', () => {
		expect(error('wss://bot.example.com/ws', [])).toBeNull();
		expect(error('wss://bot.example.com:8443/ws', [])).toBeNull();
		expect(error('wss://bot.example.com:1/ws', [])).toBeNull();
	});

	it('counts a URL without a port as 443', () => {
		expect(error('wss://bot.example.com/ws', [ 443 ])).toBeNull();
		expect(error('wss://bot.example.com:443/ws', [ 443 ])).toBeNull();
		expect(error('wss://bot.example.com/ws', [ 8443 ])).toBe('Agent endpoint port 443 is not in the configured port list');
	});

	it('allows a listed port', () => {
		expect(error('wss://bot.example.com:8443/ws', [ 443, 8443 ])).toBeNull();
	});

	it('refuses a port that is not listed, naming it', () => {
		expect(error('wss://bot.example.com:6379/ws', [ 443, 8443 ])).toBe('Agent endpoint port 6379 is not in the configured port list');
		expect(error('wss://bot.example.com:4430/ws', [ 443 ])).toMatch(/port 4430 /);
	});

	it('counts a ws:// URL without a port as 80, the port it connects to', () => {
		expect(error('ws://bot.example.com/ws', [ 443 ])).toMatch(/port 80 /);
		expect(error('ws://bot.example.com/ws', [ 80 ])).toBeNull();
	});
});

describe('endpointGuard.assertPublicEndpointHost', () => {
	it('rejects an IP-literal endpoint in a private range', async () => {
		expect(await assertPublicEndpointHost('169.254.169.254', [])).toMatch(/non-public/);
	});

	it('accepts an IP-literal endpoint in a public range', async () => {
		expect(await assertPublicEndpointHost('8.8.8.8', [])).toBeNull();
	});

	it('rejects a host outside the configured allowlist before resolving', async () => {
		expect(await assertPublicEndpointHost('8.8.8.8', [ 'agents.example.com' ])).toMatch(/allowlist/);
	});

	it('blocks a private IP by default but allows it when allowPrivate is set (dev opt-in)', async () => {
		expect(await assertPublicEndpointHost('127.0.0.1', [])).toMatch(/non-public/);
		expect(await assertPublicEndpointHost('127.0.0.1', [], true)).toBeNull();
	});

	it('still enforces the allowlist even when allowPrivate is set', async () => {
		expect(await assertPublicEndpointHost('10.0.0.5', [ 'agents.example.com' ], true)).toMatch(/allowlist/);
	});

	it('resolves a host name that no list refuses', async () => {
		vi.mocked(lookup).mockResolvedValue([ { address: '93.184.216.34', family: 4 } ] as never);

		expect(await assertPublicEndpointHost('agents.example.com', [ 'example.com' ], false, [ 'internal.example.net' ])).toBeNull();
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it('refuses a denied host although the allowlist accepts it, without resolving it', async () => {
		expect(await assertPublicEndpointHost('meet.example.com', [ 'example.com' ], false, [ 'meet.example.com' ])).toMatch(/denylist/);
		expect(await assertPublicEndpointHost('Meet.Example.COM.', [], false, [ '.example.com' ])).toMatch(/denylist/);
		expect(lookup).not.toHaveBeenCalled();
	});

	it('refuses a denied host even when allowPrivate is set', async () => {
		expect(await assertPublicEndpointHost('meet.example.com', [], true, [ 'example.com' ])).toMatch(/denylist/);
	});

	it('denies no host when the denylist is empty or left out', async () => {
		expect(await assertPublicEndpointHost('8.8.8.8', [], false, [])).toBeNull();
		expect(await assertPublicEndpointHost('8.8.8.8', [])).toBeNull();
	});
});
