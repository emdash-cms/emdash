/**
 * Production SSRF egress for artifact acquisition (plan W7.2, Slice-B design
 * 2026-07-17). Constructs the `{ fetch, resolveHostname }` pair
 * `fetchVerifiedResource` injects into every declared-URL artifact download.
 *
 * The security posture lives entirely in `fetchVerifiedResource`
 * (`@emdash-cms/registry-verification`): HTTPS-only, credential-free URLs,
 * manual per-hop redirect re-validation with per-hop hostname re-resolution,
 * private/reserved-IP rejection, and byte/time budgets. This module supplies
 * only the two injected primitives and adds NOTHING to the request — no
 * ambient credentials, no header injection, no redirect following of its own.
 *
 *  - `resolveHostname` is the ratified `cloudflareDohResolver` (DoH against a
 *    fixed trusted host, A+AAAA, fails closed). `fetchVerifiedResource` checks
 *    every returned address against the private/reserved blocklist before each
 *    hop, so a rebinding or private-IP host is rejected before any fetch.
 *  - `fetch` is a thin pass-through over `globalThis.fetch`. It forwards the
 *    method/redirect/signal `fetchVerifiedResource` sets verbatim and never
 *    overrides them, so the hardened posture is preserved.
 *
 * No recursion into the SSRF-checked path: `cloudflareDohResolver` reaches its
 * fixed DoH host with its own plain `globalThis.fetch`, never through the
 * `fetch` this module returns, so resolving a hostname does not itself trigger
 * another resolve.
 */

import type { FetchImplementation, HostnameResolver } from "@emdash-cms/registry-verification";
import { cloudflareDohResolver } from "emdash/security/ssrf";

export interface ArtifactEgress {
	readonly fetch: FetchImplementation;
	readonly resolveHostname: HostnameResolver;
}

/**
 * Forwards `fetchVerifiedResource`'s pre-built request unchanged. Wrapping
 * `globalThis.fetch` in an arrow rather than passing the bare reference keeps
 * the call bound to the global and makes the "no added headers/credentials"
 * contract explicit at the call site.
 */
const passthroughFetch: FetchImplementation = (input, init) => globalThis.fetch(input, init);

export function createArtifactEgress(): ArtifactEgress {
	return { fetch: passthroughFetch, resolveHostname: cloudflareDohResolver };
}
