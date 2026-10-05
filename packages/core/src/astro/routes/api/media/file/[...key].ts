/**
 * Serve uploaded media files
 *
 * GET /_emdash/api/media/file/:key - Serve file from storage, or a byte range of it
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";
import { IMMUTABLE_IMAGE_CACHE, MUTABLE_MEDIA_CACHE_CONTROL } from "#media/image-endpoint.js";

import { parseRangeHeader, resolveByteRange } from "../../../../../storage/range.js";
import { isRefusedStorageKey } from "../../../../../transfer/staging/keys.js";

export const prerender = false;

const MAX_KEY_DECODES = 3;

/**
 * Whether a key is, or percent-decodes to, a key this route must refuse.
 * Every decoding layer is checked because storage backends differ in whether
 * they decode keys; a key that is still encoded after the last layer, or
 * does not decode, is refused.
 */
function isPrivateMediaKey(key: string): boolean {
	let candidate = key;
	for (let layer = 0; layer <= MAX_KEY_DECODES; layer++) {
		if (isRefusedStorageKey(candidate)) return true;
		let decoded: string;
		try {
			decoded = decodeURIComponent(candidate);
		} catch {
			return true;
		}
		if (decoded === candidate) return false;
		candidate = decoded;
	}
	return true;
}

/**
 * Content types that are safe to display inline (simple raster/vector images, video, audio).
 * Everything else gets Content-Disposition: attachment to prevent script execution.
 */
const SAFE_INLINE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/x-icon",
	"video/mp4",
	"video/webm",
	"audio/mpeg",
	"audio/wav",
	"audio/ogg",
]);

export const GET: APIRoute = async ({ params, locals, request, cache }) => {
	const { key } = params;
	const { emdash } = locals;

	if (!key) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	// Backup archives and transfer staging share the storage bucket but hold
	// whole-site content; they must never be reachable through this public,
	// unauthenticated route.
	if (isPrivateMediaKey(key)) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	if (!emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage not configured", 500);
	}

	try {
		// No ETag or Last-Modified is sent, so an If-Range can never match and
		// the whole file must be served.
		const range = request.headers.has("If-Range")
			? null
			: parseRangeHeader(request.headers.get("Range"));
		// The route cache keys entries by URL alone, so a cached partial
		// response would be served to requests for the whole file.
		if (range && cache?.enabled) cache.set(false);
		const result = range
			? await emdash.storage.download(key, { range })
			: await emdash.storage.download(key);
		const served = range ? result.range : undefined;

		// Adapters return the whole file for a range they don't serve, including
		// one past the end. A size of 0 may be unknown, so it rules nothing out.
		if (range && !served && result.size > 0 && !resolveByteRange(range, result.size)) {
			await result.body.cancel().catch(() => undefined);
			const response = apiError("RANGE_NOT_SATISFIABLE", "Range not satisfiable", 416);
			response.headers.set("Content-Range", `bytes */${result.size}`);
			return response;
		}

		const headers: Record<string, string> = {
			"Content-Type": result.contentType,
			"Cache-Control": result.contentType.startsWith("image/")
				? MUTABLE_MEDIA_CACHE_CONTROL
				: IMMUTABLE_IMAGE_CACHE,
			"Accept-Ranges": "bytes",
			"X-Content-Type-Options": "nosniff",
			// Sandbox CSP on all user-uploaded content — prevents script execution
			// even for SVGs navigated to directly or content types that support scripting.
			"Content-Security-Policy":
				"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
		};

		// Safe image/media types can render inline; everything else (SVG, PDF,
		// HTML, JS, etc.) must be downloaded to prevent stored XSS.
		if (SAFE_INLINE_TYPES.has(result.contentType)) {
			headers["Content-Disposition"] = "inline";
		} else {
			headers["Content-Disposition"] = "attachment";
		}

		if (served) {
			const end = served.offset + served.length - 1;
			headers["Content-Range"] = `bytes ${served.offset}-${end}/${result.size}`;
			headers["Content-Length"] = String(served.length);
			return new Response(result.body, { status: 206, headers });
		}

		if (result.size) {
			headers["Content-Length"] = String(result.size);
		}

		return new Response(result.body, { status: 200, headers });
	} catch (error) {
		// Check if it's a "not found" error
		if (
			error instanceof Error &&
			(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
		) {
			return apiError("NOT_FOUND", "File not found", 404);
		}
		return handleError(error, "Failed to serve file", "FILE_SERVE_ERROR");
	}
};
