/**
 * Confirm media upload endpoint
 *
 * POST /_emdash/api/media/{id}/confirm
 *
 * Confirms that the client has successfully uploaded the file to storage.
 * Marks the media record as ready and optionally updates metadata.
 */

import type { APIRoute } from "astro";
import { MediaRepository } from "emdash";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { mediaConfirmBody } from "#api/schemas.js";
import { enrichImageMetadata } from "#media/enrich.js";
import type { MediaItem } from "#types";

export const prerender = false;

/**
 * Max raw bytes to buffer for server-side LQIP generation at confirm time. The
 * signed-URL upload flow exists so large files bypass server buffering — re-reading
 * the whole object into a Worker's 128 MB heap to compute a blurhash would OOM
 * on the very uploads that flow was designed for. LQIP is progressive
 * enhancement: large images simply ship without a server-generated placeholder.
 */
const MAX_PLACEHOLDER_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Add URL to media item (relative URL for portability)
 */
function addUrlToMedia(item: MediaItem): MediaItem & { url: string } {
	return {
		...item,
		url: `/_emdash/api/media/file/${item.storageKey}`,
	};
}

/**
 * Confirm upload completion
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const denied = requirePerm(user, "media:upload");
	if (denied) return denied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Media ID is required", 400);
	}

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseOptionalBody(request, mediaConfirmBody, {});
		if (isParseError(body)) return body;

		const repo = new MediaRepository(emdash.db);

		// Get the media item first to check status
		const existing = await repo.findById(id);
		if (!existing) {
			return apiError("NOT_FOUND", `Media item not found: ${id}`, 404);
		}

		if (existing.status !== "pending") {
			return apiError("INVALID_STATE", `Media item is not pending: ${existing.status}`, 400);
		}

		// Only the uploader or a user with media:edit_any can confirm/fail a pending upload
		const ownerDenied = requireOwnerPerm(
			user,
			existing.authorId ?? "",
			"media:edit_own",
			"media:edit_any",
		);
		if (ownerDenied) return ownerDenied;

		// Optionally verify the file exists in storage
		if (emdash.storage) {
			const exists = await emdash.storage.exists(existing.storageKey);
			if (!exists) {
				// Mark as failed
				await repo.markFailed(id);
				return apiError("FILE_NOT_FOUND", "File was not uploaded to storage", 400);
			}
		}

		// For images, read the just-uploaded bytes back from storage once to
		// generate LQIP placeholders (and server-side dimensions as a fallback).
		// The signed-URL flow uploads directly to storage, so this confirm is the
		// only point at which the server sees the bytes. Best-effort: a decode
		// failure must not block the upload from being marked ready. We also cap
		// the download size — buffering a large original into a Worker heap to
		// compute a 32px blurhash would OOM on the uploads the signed-URL path
		// exists to support, so oversized files skip the server-side placeholder.
		let blurhash: string | undefined;
		let dominantColor: string | undefined;
		let width = body.width;
		let height = body.height;
		if (emdash.storage && existing.mimeType.startsWith("image/")) {
			const knownSize = body.size ?? existing.size ?? undefined;
			const tooLarge = knownSize != null && knownSize > MAX_PLACEHOLDER_DOWNLOAD_BYTES;
			if (!tooLarge) {
				try {
					const { body: stream } = await emdash.storage.download(existing.storageKey);
					const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
					// Defense-in-depth for the unknown-size case: even though we
					// already buffered it, refuse the decode so we don't also pay
					// the (larger) RGBA allocation.
					if (bytes.byteLength > MAX_PLACEHOLDER_DOWNLOAD_BYTES) {
						console.warn(
							`[media] confirm skipping placeholder: object ${existing.storageKey} is ${bytes.byteLength} bytes (> ${MAX_PLACEHOLDER_DOWNLOAD_BYTES})`,
						);
					} else {
						const enriched = await enrichImageMetadata(bytes, existing.mimeType, {
							knownDimensions:
								body.width != null && body.height != null
									? { width: body.width, height: body.height }
									: undefined,
						});
						blurhash = enriched.blurhash;
						dominantColor = enriched.dominantColor;
						width = width ?? enriched.width;
						height = height ?? enriched.height;
					}
				} catch (error) {
					console.error("[media] confirm placeholder generation failed:", error);
				}
			} else {
				console.warn(
					`[media] confirm skipping placeholder: object ${existing.storageKey} reported size ${knownSize} bytes (> ${MAX_PLACEHOLDER_DOWNLOAD_BYTES})`,
				);
			}
		}

		// Confirm the upload
		const item = await repo.confirmUpload(id, {
			size: body.size,
			width,
			height,
			blurhash,
			dominantColor,
		});

		if (!item) {
			return apiError("CONFIRM_FAILED", "Failed to confirm upload", 500);
		}

		// Add URL to the response (relative URL for portability)
		const itemWithUrl = addUrlToMedia(item);

		return apiSuccess({ item: itemWithUrl });
	} catch (error) {
		return handleError(error, "Failed to confirm upload", "CONFIRM_ERROR");
	}
};
