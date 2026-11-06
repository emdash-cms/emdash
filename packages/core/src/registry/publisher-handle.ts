/**
 * Verified publisher handles for the registry admin.
 *
 * The admin shows a publisher's handle in place of its DID only when the
 * handle is verified in both directions: the DID document claims the handle
 * (`alsoKnownAs`), and the handle resolves back to the same DID through DNS
 * (`_atproto` TXT) or HTTPS (`/.well-known/atproto-did`). The aggregator's own
 * `handle` field is never consulted.
 *
 * The lookups run on the server because the HTTPS method contacts whatever
 * host the handle names, which the admin's CSP cannot allow in advance.
 * Directory lookups (PLC, DNS-over-HTTPS) go to fixed origins. Every other
 * host is publisher-controlled, so its addresses must pass the SSRF checks
 * first; because only HTTPS is allowed, a DNS answer that changes between the
 * check and the connection still has to present a certificate for that host.
 */

import type { HandleResolver } from "@atcute/identity-resolver";
import { isHandle, type Did, type Handle } from "@atcute/lexicons/syntax";

import { resolveAndValidateExternalUrl, SsrfError } from "../security/ssrf.js";

export type PublisherHandleResolution =
	| { status: "ok"; handle: string }
	| { status: "invalid" }
	| { status: "missing" };

const PLC_DIRECTORY_URL = "https://plc.directory";
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DIRECTORY_ORIGINS = new Set([PLC_DIRECTORY_URL, new URL(DOH_URL).origin]);

const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const WEB_DID_PREFIX = "did:web:";
const HANDLE_URI_PREFIX = "at://";

/** Covers the DID document plus the DNS and HTTPS handle checks. */
const LOOKUP_TIMEOUT_MS = 8_000;
/** Far above any legitimate DID document, DoH answer, or well-known body. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * What `resolveAndValidateExternalUrl` throws when DNS returns no A or AAAA
 * records, NXDOMAIN included. It is the only `SsrfError` that describes the
 * host rather than a refusal to contact it.
 */
const NO_ADDRESSES_MESSAGE = "Hostname resolved to no addresses";

/**
 * Conclusive results are shared across requests in this isolate. The admin
 * keeps its own 24-hour copy per browser, so this layer only absorbs repeat
 * lookups from other admins and page loads; a short TTL keeps it from
 * stretching how long a changed or broken handle keeps its old status.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const CACHE_KEY = Symbol.for("emdash.registry.publisherHandles");

type HandleLookup = { did: string } | "not-found" | "failed";

interface CachedResolution {
	resolution: PublisherHandleResolution;
	expiresAt: number;
}

function resolutionCache(): Map<string, CachedResolution> {
	const holder = globalThis as typeof globalThis & {
		[CACHE_KEY]?: Map<string, CachedResolution>;
	};
	holder[CACHE_KEY] ??= new Map();
	return holder[CACHE_KEY];
}

function isPlcDid(value: string): value is Did<"plc"> {
	return PLC_DID_PATTERN.test(value);
}

/** atproto only uses hostname-level `did:web` identifiers. */
function isWebDid(value: string): value is Did<"web"> {
	if (!value.startsWith(WEB_DID_PREFIX)) return false;
	const host = value.slice(WEB_DID_PREFIX.length);
	return host === host.toLowerCase() && isHandle(host);
}

export function isPublisherDid(value: string): boolean {
	return isPlcDid(value) || isWebDid(value);
}

/**
 * Resolve a publisher DID to its verified handle.
 *
 * Returns `null` when the outcome is indeterminate (network failure, timeout,
 * unexpected response); the caller should retry later rather than treat the
 * publisher as broken.
 */
export async function resolvePublisherHandle(
	did: string,
): Promise<PublisherHandleResolution | null> {
	const cache = resolutionCache();
	const cached = cache.get(did);
	if (cached && cached.expiresAt > Date.now()) return cached.resolution;
	cache.delete(did);

	const resolution = await lookUpPublisherHandle(did);
	if (resolution) {
		if (cache.size >= CACHE_MAX_ENTRIES) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		cache.set(did, { resolution, expiresAt: Date.now() + CACHE_TTL_MS });
	}
	return resolution;
}

async function lookUpPublisherHandle(did: string): Promise<PublisherHandleResolution | null> {
	if (!isPublisherDid(did)) return null;

	const identity = await import("@atcute/identity-resolver");
	const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
	const fetch = boundedFetch(deadline);

	let alsoKnownAs: readonly string[] | undefined;
	try {
		const document = isPlcDid(did)
			? await new identity.PlcDidDocumentResolver({ apiUrl: PLC_DIRECTORY_URL, fetch }).resolve(
					did,
					{ signal: deadline },
				)
			: await new identity.AtprotoWebDidDocumentResolver({ fetch }).resolve(
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- isPublisherDid admitted only plc and web DIDs
					did as Did<"web">,
					{ signal: deadline },
				);
		alsoKnownAs = document.alsoKnownAs;
	} catch (error) {
		if (error instanceof identity.DocumentNotFoundError) return { status: "missing" };
		console.warn(`[registry] DID document lookup failed for ${did}:`, error);
		return null;
	}

	const claimed = claimedHandle(alsoKnownAs);
	if (claimed === null) return { status: "missing" };
	if (claimed === undefined) return { status: "invalid" };

	const lookup = await resolveHandleDid(
		[
			new identity.DohJsonHandleResolver({ dohUrl: DOH_URL, fetch }),
			new identity.WellKnownHandleResolver({ fetch }),
		],
		claimed,
		deadline,
		(error) =>
			error instanceof identity.DidNotFoundError ||
			error instanceof identity.InvalidResolvedHandleError ||
			error instanceof identity.AmbiguousHandleError,
	);
	if (lookup === "failed") {
		console.warn(`[registry] handle lookup failed for ${claimed} (${did})`);
		return null;
	}
	if (lookup === "not-found" || lookup.did !== did) return { status: "invalid" };
	return { status: "ok", handle: claimed };
}

/**
 * The first `at://` entry is the claimed handle, as in `@atcute/identity`'s
 * `getAtprotoHandle`: `null` when none is claimed, `undefined` when the claim
 * is not a valid handle.
 */
function claimedHandle(alsoKnownAs: readonly string[] | undefined): Handle | null | undefined {
	const entry = alsoKnownAs?.find((value) => value.startsWith(HANDLE_URI_PREFIX));
	if (entry === undefined) return null;
	const handle = entry.slice(HANDLE_URI_PREFIX.length).toLowerCase();
	return isHandle(handle) ? handle : undefined;
}

/**
 * Race the DNS and HTTPS methods like atcute's `CompositeHandleResolver`: the
 * first DID either method returns wins. Unlike it, a lookup where every method
 * failed reports whether all of them failed conclusively (no record, no valid
 * DID), so a network error or timeout is never mistaken for a broken handle.
 */
function resolveHandleDid(
	resolvers: readonly HandleResolver[],
	handle: Handle,
	deadline: AbortSignal,
	isConclusive: (error: unknown) => boolean,
): Promise<HandleLookup> {
	return new Promise<HandleLookup>((resolve) => {
		const controller = new AbortController();
		const settle = (lookup: HandleLookup) => {
			deadline.removeEventListener("abort", onDeadline);
			controller.abort();
			resolve(lookup);
		};
		function onDeadline() {
			settle("failed");
		}
		if (deadline.aborted) return settle("failed");
		deadline.addEventListener("abort", onDeadline, { once: true });

		let pending = resolvers.length;
		let conclusive = true;
		for (const resolver of resolvers) {
			resolver.resolve(handle, { signal: controller.signal }).then(
				(did) => settle({ did }),
				(error: unknown) => {
					if (!isConclusive(error)) conclusive = false;
					pending -= 1;
					if (pending === 0) settle(conclusive ? "not-found" : "failed");
				},
			);
		}
	});
}

/**
 * `fetch` for the atcute resolvers: HTTPS only, no credentials, no redirects,
 * a shared deadline, and a response size cap. Only the `accept` header the
 * resolvers set is forwarded.
 *
 * A publisher host with no DNS addresses answers as a 404, which atcute reads
 * as "no DID here" (a lapsed handle domain, a did:web host that is gone). A
 * host the SSRF policy refuses still throws: it was never asked, so the
 * lookup stays indeterminate.
 */
function boundedFetch(deadline: AbortSignal): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new TypeError("Identity lookups require an HTTPS URL without credentials");
		}
		if (!DIRECTORY_ORIGINS.has(url.origin)) {
			try {
				await resolveAndValidateExternalUrl(url.href);
			} catch (error) {
				if (error instanceof SsrfError && error.message === NO_ADDRESSES_MESSAGE) {
					return new Response(null, { status: 404 });
				}
				throw error;
			}
		}

		const accept = new Headers(init?.headers).get("accept");
		const response = await globalThis.fetch(url, {
			method: "GET",
			headers: accept ? { accept } : {},
			redirect: "manual",
			signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
		});
		return limitResponseBody(response, MAX_RESPONSE_BYTES);
	};
}

function limitResponseBody(response: Response, maxBytes: number): Response {
	if (!response.body) return response;
	let received = 0;
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength;
				if (received > maxBytes) {
					controller.error(new RangeError("Identity response exceeds its size limit"));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
