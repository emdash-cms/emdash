import { apiError, handleError } from "../api/error.js";
import type { Storage } from "../storage/types.js";

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

export async function serveStoredMedia(
	storage: Storage,
	key: string,
	cacheControl: string,
): Promise<Response> {
	try {
		const result = await storage.download(key);
		const headers: Record<string, string> = {
			"Content-Type": result.contentType,
			"Cache-Control": cacheControl,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy":
				"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
			"Content-Disposition": SAFE_INLINE_TYPES.has(result.contentType) ? "inline" : "attachment",
		};

		if (result.size) headers["Content-Length"] = String(result.size);
		return new Response(result.body, { status: 200, headers });
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
		) {
			return apiError("NOT_FOUND", "File not found", 404);
		}
		return handleError(error, "Failed to serve file", "FILE_SERVE_ERROR");
	}
}
