/**
 * Registry artifact proxy
 *
 * GET /_emdash/api/admin/plugins/registry/artifact?url=<artifact-url>
 *
 * Proxies an icon / screenshot / banner image referenced by a registry
 * release record so the admin UI can display it without cross-origin
 * requests to arbitrary publisher hosting.
 *
 * Trust model (CRITICAL): unlike the marketplace icon proxy — which fetches
 * a single, trusted, operator-configured origin — this proxy fetches an
 * ARBITRARY, publisher-supplied URL taken from a registry record. It MUST
 * therefore apply the SSRF defences (`assertSafeArtifactUrl`, which wraps
 * `resolveAndValidateExternalUrl`) before every fetch, re-validating each
 * redirect hop, and serve back only image content types.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { assertSafeArtifactUrl } from "#api/index.js";

export const prerender = false;

/** Image content types the proxy will pass through. Anything else is rejected. */
const ALLOWED_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
	"image/avif",
]);

/** Cap proxied images so a hostile host can't stream an unbounded body. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Redirect hops to follow, re-validating each target against SSRF rules. */
const MAX_REDIRECTS = 5;

/** Wall-clock budget covering connect + headers + body. */
const FETCH_TIMEOUT_MS = 15_000;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	const target = url.searchParams.get("url");
	if (!target) {
		return apiError("INVALID_REQUEST", "Missing artifact url", 400);
	}
	if (target.length > 2048) {
		return apiError("INVALID_REQUEST", "Artifact url too long", 400);
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
			current = await assertSafeArtifactUrl(target);
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
		// SVG is active content: an `<svg><script>` navigated to as a top-level
		// document executes in this (authenticated admin) origin. `<img src>`
		// rendering — the only way the admin UI uses these — never runs that
		// script, but the proxy URL is directly navigable. `Content-Disposition:
		// attachment` forces a download instead of rendering, and the sandbox
		// CSP neutralises script/plugins if a client renders it anyway. Both
		// apply to every image type, not just SVG.
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
