/**
 * Independent AT Protocol handle resolution.
 *
 * Verifies the handle→DID binding directly against the handle's domain,
 * without trusting any PDS or relay. This is critical for security when
 * using handle-based allowlists — a malicious PDS could claim any handle
 * for its DIDs, so we must verify independently.
 *
 * Uses @atcute/identity-resolver which supports:
 * - DNS over HTTPS (works on Cloudflare Workers, no node:dns needed)
 * - HTTP well-known (`https://{handle}/.well-known/atproto-did`)
 * - Composite strategies (race both methods for speed)
 */

import {
	CompositeHandleResolver,
	DohJsonHandleResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";

let resolver: CompositeHandleResolver | undefined;

function getResolver(): CompositeHandleResolver {
	if (!resolver) {
		resolver = new CompositeHandleResolver({
			strategy: "race",
			methods: {
				dns: new DohJsonHandleResolver({ dohUrl: "https://cloudflare-dns.com/dns-query" }),
				http: new WellKnownHandleResolver(),
			},
		});
	}
	return resolver;
}

/**
 * Resolve an AT Protocol handle to a DID by verifying the binding
 * directly against the handle's domain (DNS-over-HTTPS + HTTP, raced).
 *
 * Returns the verified DID, or null if resolution fails.
 */
export async function verifyHandleDID(handle: string): Promise<string | null> {
	// Basic validation — must be at least `x.y` (atcute expects `${string}.${string}`)
	if (!handle.includes(".")) return null;

	try {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated above with includes("."), satisfies atcute's template literal type
		const did = await getResolver().resolve(handle as `${string}.${string}`);
		return did;
	} catch {
		return null;
	}
}
