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

import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

/**
 * SSRF protection for the customer endpoint the /agent proxy dials out to. The endpoint URL comes from the
 * provisioning API (ultimately the customer), so it must be prevented from targeting internal/link-local/loopback
 * addresses (cloud metadata, internal services, etc.) while still allowing arbitrary PUBLIC customer hosts, the
 * whole point of the feature.
 *
 * This is the pre-dial check, which fails fast with a clear reason. The address actually connected to is checked
 * again by the request-filtering agent on the outbound socket (server.ts), which closes the DNS-rebinding gap: a
 * name that resolves public here and private at connect time.
 */

/**
 * Whether an IP address literal is in a non-public range. Classified by ipaddr.js, which unwraps IPv4-mapped IPv6
 * and knows the private, loopback, link-local, CGNAT, multicast and reserved blocks of both families, plus the
 * IPv4 embeddings (NAT64, 6to4, Teredo), all of which are treated as non-public.
 *
 * @param {string} ip - The IP address to classify.
 * @returns {boolean}
 */
export function isPrivateAddress(ip: string): boolean {
	let address: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		address = ipaddr.process(ip);
	} catch {
		// Not a valid IP literal: unsafe (callers resolve hostnames before calling this).
		return true;
	}
	return address.range() !== 'unicast';
}

export function hostAllowed(host: string, allowedHosts: string[]): boolean {
	if (allowedHosts.length === 0) {
		return true;
	}

	return allowedHosts.some(entry => {
		const bare = entry.startsWith('.') ? entry.slice(1) : entry;

		return host === bare || host.endsWith(`.${bare}`);
	});
}

export async function assertPublicEndpointHost(
		host: string,
		allowedHosts: string[],
		allowPrivate = false): Promise<string | null> {
	const lower = host.toLowerCase();

	if (!hostAllowed(lower, allowedHosts)) {
		return 'Agent endpoint host is not in the configured allowlist';
	}

	if (allowPrivate) {
		return null;
	}

	if (ipaddr.isValid(lower)) {
		return isPrivateAddress(lower) ? 'Agent endpoint resolves to a non-public address' : null;
	}

	let addresses: Array<{ address: string; }>;

	try {
		addresses = await lookup(host, { all: true });
	} catch {
		return 'Agent endpoint host could not be resolved';
	}

	if (addresses.length === 0 || addresses.some(a => isPrivateAddress(a.address))) {
		return 'Agent endpoint resolves to a non-public address';
	}

	return null;
}
