/**
 * Registry artifact proxy
 *
 * GET /_emdash/api/admin/plugins/registry/artifact?did=&slug=&version=&kind=&index=
 *
 * Proxies an icon / screenshot / banner image referenced by a registry
 * release record so the admin UI can display it without cross-origin
 * requests to arbitrary publisher hosting.
 *
 * Trust model (CRITICAL): the proxy never accepts an artifact URL from the
 * client. The caller addresses an artifact by its coordinates
 * `(did, slug, version, kind, index)`; the server resolves the *declared*
 * artifact source from the validated release record fetched from the
 * configured aggregator. Blob-backed images resolve to the record-scoped
 * Cumulus deployment; URL artifacts retain the external fallback.
 *
 * The publisher-declared URL is still untrusted (an attacker who controls a
 * publisher record, or the aggregator, can point it anywhere), so the
 * resolved URL passes through the SSRF defences (`assertSafeArtifactUrl`,
 * re-validated on every redirect hop) before any fetch, and only allowlisted
 * image content types are served back.
 */

import type { Did } from "@atcute/lexicons";
import { evaluateRegistryReleaseWithdrawal } from "@emdash-cms/registry-client/withdrawal";
import { NSID, RECORD_SCOPED_BLOB_CACHE_TYPE } from "@emdash-cms/registry-lexicons";
import {
	recordScopedImageCacheUrl,
	resolvePublisherPdsEndpoint,
	type ReleaseArtifactReference,
} from "@emdash-cms/registry-verification/artifact";
import { multihashFromBlobCid } from "@emdash-cms/registry-verification/checksum";
import { fetchVerifiedResource } from "@emdash-cms/registry-verification/fetch";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";

import { verifyRegistryArtifactChecksum } from "../../../../../../registry/artifact-checksum.js";
import { fetchRegistryArtifactUrl } from "../../../../../../registry/artifact-fetch.js";
import { coerceRegistryConfig, validateAggregatorUrl } from "../../../../../../registry/config.js";
import { resolveAndValidateExternalUrlTarget } from "../../../../../../security/ssrf.js";

export const prerender = false;

/**
 * Image content types the proxy will pass through. Anything else is rejected.
 *
 * SVG is deliberately excluded: it is active content (an `<svg><script>`
 * executes when navigated to as a top-level document), and the publisher
 * supplies the bytes. Rather than serve it behind mitigations, we refuse it
 * end-to-end — the publish CLI rejects SVG artifacts too, so a conforming
 * release never references one.
 */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Artifact kinds the proxy can resolve. `screenshot` additionally needs `index`. */
const ALLOWED_KINDS = new Set(["icon", "banner", "screenshot"]);

/** Loose DID shape (`did:method:id`); the aggregator lexicon is authoritative. */
const DID_PATTERN = /^did:[a-z]+:.+/;
/** Slug grammar: ASCII letter then letters / digits / `-` / `_`. Mirrors the install route. */
const SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const CID_PATTERN = /^b[a-z2-7]+$/;
/** Non-negative integer, for the screenshot index param. */
const INDEX_PATTERN = /^\d+$/;

/** Cap proxied images so a hostile host can't stream an unbounded body. */
const MAX_IMAGE_BYTES = 1024 * 1024;

/** Redirect hops to follow, re-validating each target against SSRF rules. */
const MAX_REDIRECTS = 5;

/** Wall-clock budget covering connect + headers + body for the artifact fetch. */
const FETCH_TIMEOUT_MS = 15_000;

/** Per-aggregator-request timeout and overall budget for release resolution. */
const AGGREGATOR_REQUEST_TIMEOUT_MS = 15_000;
const AGGREGATOR_TOTAL_BUDGET_MS = 30_000;

/** Bound the version search: 20 pages * 50 per page = 1000 releases worth. */
const MAX_LIST_PAGES = 20;

/** Build a fetch that enforces a per-request and per-budget timeout. Mirrors the install handler. */
function timedFetch(totalDeadline: number): typeof fetch {
	return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const now = Date.now();
		const remaining = Math.max(0, totalDeadline - now);
		if (remaining === 0) {
			return Promise.reject(new Error("Aggregator request budget exhausted"));
		}
		const timeout = Math.min(AGGREGATOR_REQUEST_TIMEOUT_MS, remaining);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const callerSignal = init?.signal;
		if (callerSignal) {
			if (callerSignal.aborted) controller.abort(callerSignal.reason);
			else callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason));
		}
		return fetch(input, { ...init, signal: controller.signal }).finally(() => {
			clearTimeout(timer);
		});
	};
}

/**
 * Narrow one entry of a release's `artifacts` map to a usable image source.
 *
 * The embedded `release` record is lexicon-validated at the DiscoveryClient
 * boundary, but `artifacts` is an aggregator pass-through typed `unknown`, so
 * the entry's shape is not guaranteed.
 */
type DeclaredArtifact = ReleaseArtifactReference & { requiresAuth: boolean };

interface ResolvedArtifact {
	artifact: DeclaredArtifact;
	record: {
		did: string;
		collection: string;
		rkey: string;
		cid: string;
	};
	imageCacheUrl?: URL;
}

function declaredArtifact(value: unknown): DeclaredArtifact | null {
	if (!value || typeof value !== "object") return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; fields checked below
	const entry = value as Record<string, unknown>;
	const url = entry.url;
	const blob = entry.blob;
	const checksum = entry.checksum;
	const ref = objectProperty(blob, "ref");
	const blobCid = objectProperty(ref, "$link");
	const blobMimeType = objectProperty(blob, "mimeType");
	const blobSize = objectProperty(blob, "size");
	const hasUrl = typeof url === "string" && url.length > 0;
	const hasBlob =
		typeof blobCid === "string" &&
		blobCid.length > 0 &&
		typeof blobMimeType === "string" &&
		Number.isSafeInteger(blobSize) &&
		Number(blobSize) >= 0;
	if ((!hasUrl && !hasBlob) || typeof checksum !== "string" || checksum.length === 0) {
		return null;
	}
	return {
		...(hasUrl ? { url } : {}),
		...(hasBlob
			? {
					blob: {
						$type: "blob" as const,
						ref: { $link: blobCid },
						mimeType: blobMimeType,
						size: Number(blobSize),
					},
				}
			: {}),
		checksum,
		requiresAuth: entry.requiresAuth === true,
	};
}

/**
 * Resolve the declared artifact source for `(kind, index)` from a release's
 * `artifacts` map. Returns `null` when the requested artifact isn't present
 * or doesn't carry a usable URL.
 */
function resolveDeclaredArtifact(
	artifacts: unknown,
	kind: string,
	index: number,
): DeclaredArtifact | null {
	if (!artifacts || typeof artifacts !== "object") return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; each entry shape-narrowed by declaredArtifactUrl
	const map = artifacts as Record<string, unknown>;

	if (kind === "icon") return declaredArtifact(map.icon);
	if (kind === "banner") return declaredArtifact(map.banner);
	// kind === "screenshot"
	const screenshots = map.screenshots;
	if (!Array.isArray(screenshots)) return null;
	if (index < 0 || index >= screenshots.length) return null;
	return declaredArtifact(screenshots[index]);
}

function objectProperty(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	const did = url.searchParams.get("did");
	const slug = url.searchParams.get("slug");
	const cid = url.searchParams.get("cid");
	const kind = url.searchParams.get("kind");
	const versionParam = url.searchParams.get("version");
	const indexParam = url.searchParams.get("index");

	if (!did || !slug || !cid || !kind) {
		return apiError("INVALID_REQUEST", "Missing did, slug, cid, or kind", 400);
	}
	if (did.length > 256 || !DID_PATTERN.test(did)) {
		return apiError("INVALID_REQUEST", "Invalid did", 400);
	}
	if (slug.length > 64 || !SLUG_PATTERN.test(slug)) {
		return apiError("INVALID_REQUEST", "Invalid slug", 400);
	}
	if (cid.length > 256 || !CID_PATTERN.test(cid)) {
		return apiError("INVALID_REQUEST", "Invalid release CID", 400);
	}
	if (!ALLOWED_KINDS.has(kind)) {
		return apiError("INVALID_REQUEST", "Invalid kind", 400);
	}

	let index = 0;
	if (kind === "screenshot") {
		if (indexParam === null) {
			return apiError("INVALID_REQUEST", "Missing index for screenshot", 400);
		}
		if (!INDEX_PATTERN.test(indexParam)) {
			return apiError("INVALID_REQUEST", "Invalid index", 400);
		}
		index = Number(indexParam);
		if (!Number.isSafeInteger(index)) {
			return apiError("INVALID_REQUEST", "Invalid index", 400);
		}
	}

	let version: string | undefined;
	if (versionParam !== null && versionParam.length > 0) {
		if (versionParam.length > 64) {
			return apiError("INVALID_REQUEST", "Invalid version", 400);
		}
		version = versionParam;
	}

	const registryConfig = coerceRegistryConfig(emdash.config.experimental?.registry);
	if (!registryConfig) {
		return apiError("REGISTRY_NOT_CONFIGURED", "Registry is not configured", 400);
	}
	try {
		validateAggregatorUrl(registryConfig.aggregatorUrl);
	} catch {
		return apiError("REGISTRY_NOT_CONFIGURED", "Registry aggregator URL is invalid", 500);
	}

	// Resolve the publisher-declared artifact URL from the release record.
	let resolvedArtifact: ResolvedArtifact;
	try {
		const resolved = await resolveArtifact(registryConfig, did, slug, version, cid, kind, index);
		if (resolved === null) {
			return apiError("ARTIFACT_NOT_FOUND", "Artifact not found", 404);
		}
		resolvedArtifact = resolved;
	} catch {
		return apiError("ARTIFACT_RESOLVE_FAILED", "Failed to resolve artifact", 502);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const fetchOptions = proxyFetchOptions(controller.signal);
		let bytes: Uint8Array | undefined;
		let headers: Headers | undefined;
		let checksumValid: boolean | undefined;
		if (resolvedArtifact.imageCacheUrl) {
			const transformed = await fetchVerifiedResource(resolvedArtifact.imageCacheUrl, fetchOptions);
			if (transformed.success) {
				bytes = transformed.value.bytes;
				headers = transformed.value.headers;
			}
		}
		if (!bytes || !headers) {
			const raw = await fetchRawArtifact(resolvedArtifact, fetchOptions);
			if (!raw.success) return artifactFetchError(raw.code);
			bytes = raw.bytes;
			headers = raw.headers;
			checksumValid = raw.checksumValid;
		}

		// Content-Type allowlist: only image types are proxied. A non-image
		// (HTML error page, JSON, octet-stream) is rejected so the admin
		// never renders publisher-controlled markup from the EmDash origin.
		const rawType = headers.get("content-type") ?? "";
		const contentType = rawType.split(";", 1)[0]!.trim().toLowerCase();
		if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
			return apiError("ARTIFACT_NOT_IMAGE", "Artifact is not an allowed image type", 415);
		}

		const declaredLength = headers.get("content-length");
		if (declaredLength) {
			const declared = Number(declaredLength);
			if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
				return apiError("ARTIFACT_TOO_LARGE", "Artifact exceeds size limit", 413);
			}
		}
		if (checksumValid === false) {
			return artifactFetchError("CHECKSUM_MISMATCH");
		}

		// Only the allowlisted Content-Type is forwarded — never copy other
		// upstream headers. `private, no-store` keeps publisher images out of
		// shared caches in the authenticated admin origin.
		//
		// SVG is not in the allowlist, so active-content bytes never reach
		// here. `Content-Disposition: attachment`, the sandbox CSP, and
		// `nosniff` remain as defence-in-depth: they force a download and
		// neutralise script/plugins for any image type if a client navigates
		// directly to the proxy URL.
		return new Response(bytes, {
			headers: {
				"Content-Type": contentType,
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Disposition": "attachment",
				"Content-Security-Policy": "default-src 'none'; sandbox",
			},
		});
	} catch {
		return apiError("ARTIFACT_FETCH_FAILED", "Failed to fetch artifact", 502);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Resolve the declared artifact URL for `(did, slug, version, kind, index)`
 * from the aggregator's release record. Mirrors the install handler's release
 * lookup. Returns `null` when the package/release/artifact isn't found.
 *
 * Self-contained to this route: the install/update handlers are intentionally
 * left untouched, so a small amount of resolution-pattern duplication is
 * accepted here.
 */
async function resolveArtifact(
	registryConfig: { aggregatorUrl: string; acceptLabelers?: string },
	did: string,
	slug: string,
	version: string | undefined,
	cid: string,
	kind: string,
	index: number,
): Promise<ResolvedArtifact | null> {
	// Lazy-load the discovery client so the `@atcute/client` dependency only
	// loads when the registry path is exercised.
	const { DiscoveryClient, registryLabelerPolicy } =
		await import("@emdash-cms/registry-client/discovery");

	const aggregatorDeadline = Date.now() + AGGREGATOR_TOTAL_BUDGET_MS;
	const discovery = new DiscoveryClient({
		aggregatorUrl: registryConfig.aggregatorUrl,
		acceptLabelers: registryConfig.acceptLabelers,
		labelerPolicy: registryLabelerPolicy(registryConfig.acceptLabelers),
		fetch: timedFetch(aggregatorDeadline),
	});

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- DID shape validated by the route before this call
	const publisherDid = did as Did;

	const releaseView = await (async () => {
		if (!version) {
			return discovery.getLatestRelease({ did: publisherDid, package: slug });
		}
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			if (cursor !== undefined) {
				if (seenCursors.has(cursor)) break;
				seenCursors.add(cursor);
			}
			const result = await discovery.listReleases({
				did: publisherDid,
				package: slug,
				cursor,
				limit: 50,
			});
			for (const r of result.releases) {
				if (r.version === version) return r;
			}
			if (!result.cursor) break;
			cursor = result.cursor;
		}
		return undefined;
	})();

	if (
		!releaseView?.release ||
		releaseView.cid !== cid ||
		releaseView.did !== publisherDid ||
		releaseView.package !== slug ||
		(version !== undefined && releaseView.version !== version) ||
		releaseView.release.package !== slug ||
		releaseView.release.version !== releaseView.version
	) {
		return null;
	}
	if (evaluateRegistryReleaseWithdrawal(releaseView, discovery.labelerPolicy).withdrawn) {
		return null;
	}

	const descriptor = resolveDeclaredArtifact(releaseView.release.artifacts, kind, index);
	if (!descriptor || descriptor.requiresAuth || releaseView.release.auth !== undefined) return null;
	const blobCid = descriptor.blob?.ref.$link;
	let imageCacheUrl: URL | undefined;
	if (blobCid) {
		const expected = multihashFromBlobCid(blobCid);
		if (!expected.success || expected.value !== descriptor.checksum) return null;
		const rkey = `${slug}:${releaseView.version}`;
		const serviceEndpoint = releaseView.artifactCaches
			.map(recordScopedCacheEndpoint)
			.find((value) => value !== null);
		if (serviceEndpoint) {
			const preset = kind === "icon" ? "avatar" : kind === "banner" ? "banner" : "feed_thumbnail";
			const cacheUrl = recordScopedImageCacheUrl(
				serviceEndpoint,
				preset,
				{
					did,
					collection: NSID.packageRelease,
					rkey,
					cid: releaseView.cid,
				},
				blobCid,
			);
			if (!cacheUrl.success) return null;
			imageCacheUrl = cacheUrl.value;
		}
	}
	return {
		artifact: descriptor,
		record: {
			did,
			collection: NSID.packageRelease,
			rkey: `${slug}:${releaseView.version}`,
			cid: releaseView.cid,
		},
		...(imageCacheUrl ? { imageCacheUrl } : {}),
	};
}

function recordScopedCacheEndpoint(value: unknown): string | null {
	if (objectProperty(value, "$type") !== RECORD_SCOPED_BLOB_CACHE_TYPE) return null;
	const endpoint = objectProperty(value, "serviceEndpoint");
	return typeof endpoint === "string" ? endpoint : null;
}

/** Build bounded, SSRF-validated fetch options for cache, PDS, and URL sources. */
function proxyFetchOptions(signal: AbortSignal) {
	return {
		fetch: async (url: URL, init: RequestInit) =>
			fetchRegistryArtifactUrl(url.href, {
				signal: init.signal instanceof AbortSignal ? init.signal : signal,
				maxResponseBytes: MAX_IMAGE_BYTES,
			}),
		resolveHostname: async (hostname: string) =>
			(await resolveAndValidateExternalUrlTarget(`https://${hostname}/`)).addresses,
		allowHttpLocalhost: import.meta.env.DEV,
		maxBytes: MAX_IMAGE_BYTES,
		maxRedirects: MAX_REDIRECTS,
		totalTimeoutMs: FETCH_TIMEOUT_MS,
	};
}

async function fetchRawArtifact(
	resolved: ResolvedArtifact,
	options: ReturnType<typeof proxyFetchOptions>,
): Promise<
	| { success: true; bytes: Uint8Array; headers: Headers; checksumValid: boolean }
	| { success: false; code: string }
> {
	const urls: URL[] = [];
	const blobCid = resolved.artifact.blob?.ref.$link;
	let lastCode = "FETCH_FAILED";
	let checksumMismatch: { bytes: Uint8Array; headers: Headers } | undefined;
	if (blobCid) {
		const pds = await resolvePublisherPdsEndpoint(resolved.record.did, options);
		if (pds.success) {
			const url = new URL("/xrpc/com.atproto.sync.getBlob", pds.value);
			url.searchParams.set("did", resolved.record.did);
			url.searchParams.set("cid", blobCid);
			urls.push(url);
		} else {
			lastCode = pds.error.code;
		}
	}
	if (resolved.artifact.url) urls.push(new URL(resolved.artifact.url));

	for (const url of urls) {
		const fetched = await fetchVerifiedResource(url, options);
		if (!fetched.success) {
			lastCode = fetched.error.code;
			continue;
		}
		if (!(await verifyRegistryArtifactChecksum(fetched.value.bytes, resolved.artifact.checksum))) {
			lastCode = "CHECKSUM_MISMATCH";
			checksumMismatch = { bytes: fetched.value.bytes, headers: fetched.value.headers };
			continue;
		}
		return {
			success: true,
			bytes: fetched.value.bytes,
			headers: fetched.value.headers,
			checksumValid: true,
		};
	}
	if (checksumMismatch) return { success: true, ...checksumMismatch, checksumValid: false };
	return { success: false, code: lastCode };
}

function artifactFetchError(code: string): Response {
	if (code === "CHECKSUM_MISMATCH") {
		return apiError(
			"ARTIFACT_CHECKSUM_MISMATCH",
			"Artifact bytes do not match the approved release record",
			502,
		);
	}
	if (code === "RESOURCE_SIZE_EXCEEDED") {
		return apiError("ARTIFACT_TOO_LARGE", "Artifact exceeds size limit", 413);
	}
	if (code === "HOST_REJECTED" || code === "INVALID_URL") {
		return apiError("ARTIFACT_URL_REJECTED", "Artifact URL is not allowed", 400);
	}
	return apiError("ARTIFACT_FETCH_FAILED", "Failed to fetch artifact", 502);
}
