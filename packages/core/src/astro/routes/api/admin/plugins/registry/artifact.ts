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
 * URL from the validated release record fetched from the configured
 * aggregator. The proxy can therefore only ever fetch a URL the publisher
 * declared in their signed release — not an arbitrary caller-supplied URL.
 *
 * The publisher-declared URL is still untrusted (an attacker who controls a
 * publisher record, or the aggregator, can point it anywhere), so the
 * resolved URL passes through the SSRF defences (`assertSafeArtifactUrl`,
 * re-validated on every redirect hop) before any fetch, and only allowlisted
 * image content types are served back.
 */

import type { Did } from "@atcute/lexicons";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { assertSafeArtifactUrl } from "#api/index.js";

import { coerceRegistryConfig, validateAggregatorUrl } from "../../../../../../registry/config.js";

export const prerender = false;

/**
 * Image content types the proxy will pass through. Anything else is rejected.
 *
 * SVG is deliberately excluded: it is active content (an `<svg><script>`
 * executes when navigated to as a top-level document), and the publisher
 * supplies the bytes. Rather than serve it behind mitigations, we refuse it
 * end-to-end — the publish CLI rejects SVG artifacts too, so a conforming
 * release never references one. AVIF is included.
 */
const ALLOWED_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
]);

/** Artifact kinds the proxy can resolve. `screenshot` additionally needs `index`. */
const ALLOWED_KINDS = new Set(["icon", "banner", "screenshot"]);

/** Loose DID shape (`did:method:id`); the aggregator lexicon is authoritative. */
const DID_PATTERN = /^did:[a-z]+:.+/;
/** Slug grammar: ASCII letter then letters / digits / `-` / `_`. Mirrors the install route. */
const SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
/** Non-negative integer, for the screenshot index param. */
const INDEX_PATTERN = /^\d+$/;

/** Cap proxied images so a hostile host can't stream an unbounded body. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
 * Narrow one entry of a release's `artifacts` map to a usable image URL.
 *
 * The embedded `release` record is lexicon-validated at the DiscoveryClient
 * boundary, but `artifacts` is an aggregator pass-through typed `unknown`, so
 * the entry's shape is not guaranteed. Returns the `url` string only when the
 * value is an object carrying a non-empty string `url`; everything else
 * (missing key, wrong type, no `url`) yields `null`.
 */
function declaredArtifactUrl(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; url checked below
	const entry = value as Record<string, unknown>;
	const url = entry.url;
	if (typeof url !== "string" || url.length === 0) return null;
	return url;
}

/**
 * Resolve the declared artifact URL for `(kind, index)` from a release's
 * `artifacts` map. Returns `null` when the requested artifact isn't present
 * or doesn't carry a usable URL.
 */
function resolveDeclaredUrl(artifacts: unknown, kind: string, index: number): string | null {
	if (!artifacts || typeof artifacts !== "object") return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; each entry shape-narrowed by declaredArtifactUrl
	const map = artifacts as Record<string, unknown>;

	if (kind === "icon") return declaredArtifactUrl(map.icon);
	if (kind === "banner") return declaredArtifactUrl(map.banner);
	// kind === "screenshot"
	const screenshots = map.screenshots;
	if (!Array.isArray(screenshots)) return null;
	if (index < 0 || index >= screenshots.length) return null;
	return declaredArtifactUrl(screenshots[index]);
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
	const kind = url.searchParams.get("kind");
	const versionParam = url.searchParams.get("version");
	const indexParam = url.searchParams.get("index");

	if (!did || !slug || !kind) {
		return apiError("INVALID_REQUEST", "Missing did, slug, or kind", 400);
	}
	if (did.length > 256 || !DID_PATTERN.test(did)) {
		return apiError("INVALID_REQUEST", "Invalid did", 400);
	}
	if (slug.length > 64 || !SLUG_PATTERN.test(slug)) {
		return apiError("INVALID_REQUEST", "Invalid slug", 400);
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
	let declaredUrl: string;
	try {
		const resolved = await resolveArtifactUrl(registryConfig, did, slug, version, kind, index);
		if (resolved === null) {
			return apiError("ARTIFACT_NOT_FOUND", "Artifact not found", 404);
		}
		declaredUrl = resolved;
	} catch {
		return apiError("ARTIFACT_RESOLVE_FAILED", "Failed to resolve artifact", 502);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		// `assertSafeArtifactUrl` validates scheme / credentials / loopback +
		// resolves the hostname and rejects private / link-local / metadata
		// targets (DNS-rebinding defence). It throws a plain Error on any
		// block, so a rejection here means the URL is unsafe.
		let current: URL;
		try {
			current = await assertSafeArtifactUrl(declaredUrl);
		} catch {
			return apiError("ARTIFACT_URL_REJECTED", "Artifact URL is not allowed", 400);
		}

		let response: Response;
		for (let hop = 0; ; hop++) {
			response = await fetch(current.href, { redirect: "manual", signal: controller.signal });
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get("location");
			if (!location) break;
			if (hop === MAX_REDIRECTS) {
				return apiError("ARTIFACT_URL_REJECTED", "Too many redirects", 502);
			}
			let next: URL;
			try {
				next = await assertSafeArtifactUrl(new URL(location, current).href);
			} catch {
				return apiError("ARTIFACT_URL_REJECTED", "Redirect target is not allowed", 400);
			}
			current = next;
		}

		if (!response.ok) {
			return apiError("ARTIFACT_FETCH_FAILED", "Failed to fetch artifact", 502);
		}

		// Content-Type allowlist: only image types are proxied. A non-image
		// (HTML error page, JSON, octet-stream) is rejected so the admin
		// never renders publisher-controlled markup from the EmDash origin.
		const rawType = response.headers.get("content-type") ?? "";
		const contentType = rawType.split(";", 1)[0]!.trim().toLowerCase();
		if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
			return apiError("ARTIFACT_NOT_IMAGE", "Artifact is not an allowed image type", 415);
		}

		const declaredLength = response.headers.get("content-length");
		if (declaredLength) {
			const declared = Number(declaredLength);
			if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
				return apiError("ARTIFACT_TOO_LARGE", "Artifact exceeds size limit", 413);
			}
		}

		const bytes = await readCapped(response, MAX_IMAGE_BYTES);
		if (bytes === null) {
			return apiError("ARTIFACT_TOO_LARGE", "Artifact exceeds size limit", 413);
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
async function resolveArtifactUrl(
	registryConfig: { aggregatorUrl: string; acceptLabelers?: string },
	did: string,
	slug: string,
	version: string | undefined,
	kind: string,
	index: number,
): Promise<string | null> {
	// Lazy-load the discovery client so the `@atcute/client` dependency only
	// loads when the registry path is exercised.
	const { DiscoveryClient } = await import("@emdash-cms/registry-client/discovery");

	const aggregatorDeadline = Date.now() + AGGREGATOR_TOTAL_BUDGET_MS;
	const discovery = new DiscoveryClient({
		aggregatorUrl: registryConfig.aggregatorUrl,
		acceptLabelers: registryConfig.acceptLabelers,
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

	if (!releaseView?.release) return null;

	return resolveDeclaredUrl(releaseView.release.artifacts, kind, index);
}

/**
 * Read a response body into memory, aborting once it exceeds `limit`. Returns
 * `null` when the cap is breached (the streamed body lied about / omitted
 * Content-Length). The cap is the real defence against an unbounded body.
 */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
	const body = response.body;
	if (!body) {
		const buf = new Uint8Array(await response.arrayBuffer());
		return buf.length > limit ? null : buf;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.length;
			if (total > limit) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	return combined;
}
