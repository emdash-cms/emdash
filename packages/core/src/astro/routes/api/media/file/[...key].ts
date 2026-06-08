/**
 * Serve uploaded media files
 *
 * GET /_emdash/api/media/file/:key - Serve file from storage
 */

import type { APIRoute } from "astro";
import { transformableContentTypes, transformMedia } from "virtual:emdash/media-transform";

import { apiError, handleError } from "#api/error.js";

export const prerender = false;

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

function shouldTransform(contentType: string): boolean {
	if (!transformMedia) return false;
	if (!transformableContentTypes) return true;
	return transformableContentTypes.includes(contentType);
}

export const GET: APIRoute = async ({ params, locals, request }) => {
	const { key } = params;
	const { emdash } = locals;

	if (!key) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	if (!emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage not configured", 500);
	}

	try {
		const result = await emdash.storage.download(key);
		let body: BodyInit = result.body;
		let contentType = result.contentType;
		let contentLength: number | undefined = result.size;
		let transformHeaders: Record<string, string> | undefined;

		if (shouldTransform(result.contentType)) {
			const bodyBytes = await new Response(result.body).arrayBuffer();
			body = bodyBytes;

			try {
				const transformed = await transformMedia?.({
					body: bodyBytes,
					contentType: result.contentType,
					size: result.size,
					key,
					request,
				});
				if (transformed) {
					body = transformed.body;
					contentType = transformed.contentType;
					contentLength = transformed.contentLength;
					transformHeaders = transformed.headers;
				}
			} catch (error) {
				console.error({
					event: "emdash_media_transform_failed",
					key,
					contentType: result.contentType,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const headers: Record<string, string> = {
			"Content-Type": contentType,
			"Cache-Control": "public, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
			// Sandbox CSP on all user-uploaded content — prevents script execution
			// even for SVGs navigated to directly or content types that support scripting.
			"Content-Security-Policy":
				"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
			...transformHeaders,
		};

		if (contentLength) {
			headers["Content-Length"] = String(contentLength);
		}

		// Safe image/media types can render inline; everything else (SVG, PDF,
		// HTML, JS, etc.) must be downloaded to prevent stored XSS.
		if (SAFE_INLINE_TYPES.has(contentType)) {
			headers["Content-Disposition"] = "inline";
		} else {
			headers["Content-Disposition"] = "attachment";
		}

		return new Response(body, { status: 200, headers });
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
