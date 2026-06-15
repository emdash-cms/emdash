/**
 * Transform and serve uploaded media files.
 *
 * GET /_emdash/api/media/transform/:key?w=&h=&f=&q=
 *
 * Reads the source bytes straight from the storage adapter (e.g. the R2
 * binding) and resizes them with the configured image transformer (the
 * Cloudflare `IMAGES` binding). Unlike Astro's `/_image` endpoint, this never
 * fetches the source over HTTP, so it works when the origin is gated behind
 * Cloudflare Access or when loopback fetches are disabled.
 *
 * When no transformer is configured (e.g. on Node without a binding), the
 * original bytes are streamed through unchanged so stale URLs still resolve.
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";

import { isSafeTransformKey, parseTransformParams } from "../../../../../media/image-transform.js";

export const prerender = false;

/** Long-lived immutable cache — transform output is deterministic per key+params. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
	);
}

export const GET: APIRoute = async ({ params, url, locals }) => {
	const { key } = params;
	const { emdash } = locals;

	if (!key) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	// The transform route only serves flat storage keys; reject anything with
	// slashes/traversal so it can't reroute or traverse on the backend.
	if (!isSafeTransformKey(key)) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	if (!emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage not configured", 500);
	}

	const parsed = parseTransformParams(url.searchParams);
	if (!parsed.ok) {
		return apiError("VALIDATION_ERROR", parsed.message, 400);
	}

	try {
		const source = await emdash.storage.download(key);

		// Only raster images can be transformed. Refuse anything else rather than
		// feed it to the binding (SVG/PDF/etc. would error or be unsafe).
		if (!source.contentType.startsWith("image/")) {
			return apiError("VALIDATION_ERROR", "Source is not a transformable image", 400);
		}

		// No transformer configured (Node, or no IMAGES binding): stream the
		// original through so the URL still resolves to a valid image.
		if (!emdash.transformImage) {
			return new Response(source.body, {
				status: 200,
				headers: {
					"Content-Type": source.contentType,
					"Cache-Control": IMMUTABLE_CACHE,
					"X-Content-Type-Options": "nosniff",
				},
			});
		}

		const transformed = await emdash.transformImage(source.body, parsed.options);

		return new Response(transformed.body, {
			status: 200,
			headers: {
				"Content-Type": transformed.contentType,
				"Cache-Control": IMMUTABLE_CACHE,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		if (isNotFound(error)) {
			return apiError("NOT_FOUND", "File not found", 404);
		}
		return handleError(error, "Failed to transform image", "IMAGE_TRANSFORM_ERROR");
	}
};
