import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF protection for the customer endpoint the /agent proxy dials out to. The endpoint URL is
 * caller-supplied (from the bridge, ultimately from the provisioning API), so it must be prevented
 * from targeting internal/link-local/loopback addresses (cloud metadata, internal services, etc.)
 * while still allowing arbitrary PUBLIC customer hosts — the whole point of the feature.
 *
 * Residual risk: DNS rebinding. We resolve the host and reject if it maps to a private address, but a
 * name that resolves public here and private at connect time (TOCTOU) is not fully closed — the
 * complete fix is to connect to the pinned, vetted IP. Tracked as a GA-hardening item.
 */

/**
 * Whether an IP address literal is in a non-public range (IPv4 and IPv6, including IPv4-mapped IPv6):
 * loopback, unspecified, RFC1918 private, link-local (incl. 169.254.169.254 metadata), CGNAT,
 * unique-local, site-local, multicast/reserved.
 *
 * @param {string} ip - The IP address to classify.
 * @returns {boolean}
 */
export function isPrivateAddress(ip: string): boolean {
    const family = isIP(ip);

    if (family === 4) {
        return isPrivateV4(ip);
    }
    if (family === 6) {
        const lower = ip.toLowerCase();

        // Unique-local (fc00::/7 → fc/fd) and link-local + deprecated site-local (fe80::/9 → fe8..fef).
        const isUniqueLocal = lower.startsWith('fc') || lower.startsWith('fd');
        const isLinkOrSiteLocal = lower.startsWith('fe') && '89abcdef'.includes(lower[2]);

        if (lower === '::1' || lower === '::' || isUniqueLocal || isLinkOrSiteLocal) {
            return true;
        }

        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

        if (mapped) {
            return isPrivateV4(mapped[1]);
        }

        return false;
    }

    // Not a valid IP literal — treat as unsafe (callers resolve hostnames before calling this).
    return true;
}

/**
 * Whether an IPv4 literal is in a non-public range.
 *
 * @param {string} ip - The IPv4 address.
 * @returns {boolean}
 */
function isPrivateV4(ip: string): boolean {
    const parts = ip.split('.').map(Number);

    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
        return true;
    }
    const [ a, b ] = parts;

    return a === 10 || a === 127 || a === 0
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127)
        || a >= 224;
}

/**
 * Whether a host matches an allowlist entry. An entry matches its exact host and any subdomain of it;
 * a leading dot on the entry is ignored ("example.com" and ".example.com" behave identically). The
 * subdomain check requires a dot boundary, so "example.com" does NOT match "evilexample.com".
 *
 * @param {string} host - The lowercased host.
 * @param {Array<string>} allowedHosts - The allowlist entries (lowercased).
 * @returns {boolean}
 */
export function hostAllowed(host: string, allowedHosts: string[]): boolean {
    if (allowedHosts.length === 0) {
        return true;
    }

    return allowedHosts.some(entry => {
        const bare = entry.startsWith('.') ? entry.slice(1) : entry;

        return host === bare || host.endsWith(`.${bare}`);
    });
}

/**
 * Validates that a customer endpoint host is safe to dial: it must pass the optional allowlist and must not
 * resolve to a private/internal address. Returns null when safe, or an error message.
 *
 * @param {string} host - The endpoint host (from the parsed URL).
 * @param {Array<string>} allowedHosts - Optional allowlist; empty means allow any public host.
 * @param {boolean} allowPrivate - When true, the private/internal-address denylist is skipped. This is an
 * explicit operator opt-in (AGENT_ALLOW_PRIVATE_ENDPOINTS) for dev / same-host deployments where the agent
 * server is on localhost or an internal address; it must stay off in any deployment exposed to untrusted
 * callers, since it removes the SSRF protection. The allowlist (if set) still applies.
 * @returns {Promise<string | null>}
 */
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

    if (isIP(lower)) {
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
