/**
 * Tests for the /agent SSRF guard: private-range classification, host allowlist matching, and the
 * combined resolve-and-check for IP literals. (Hostname DNS resolution is exercised via IP literals;
 * the lookup path is a thin wrapper over node:dns.)
 */

import { describe, it, expect } from 'vitest';
import { assertPublicEndpointHost, hostAllowed, isPrivateAddress } from '../../src/agent/endpointGuard';

describe('endpointGuard.isPrivateAddress', () => {
    it('flags IPv4 private, loopback, link-local and metadata addresses', () => {
        for (const ip of [ '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '127.0.0.1',
            '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1' ]) {
            expect(isPrivateAddress(ip)).toBe(true);
        }
    });

    it('allows IPv4 public addresses', () => {
        for (const ip of [ '8.8.8.8', '1.1.1.1', '203.0.113.10', '172.32.0.1', '192.169.0.1' ]) {
            expect(isPrivateAddress(ip)).toBe(false);
        }
    });

    it('flags IPv6 loopback, unique-local, link-local and site-local', () => {
        for (const ip of [ '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1' ]) {
            expect(isPrivateAddress(ip)).toBe(true);
        }
    });

    it('classifies IPv4-mapped IPv6 by the embedded address', () => {
        expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
        expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    });

    it('allows IPv6 public addresses', () => {
        expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
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
});
