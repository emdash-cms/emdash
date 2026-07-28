/**
 * Confirm media upload endpoint
 *
 * POST /_emdash/api/media/{id}/confirm
 *
 * Confirms that the client has successfully uploaded the file to storage.
 * Marks the media record as ready and optionally updates metadata.
 */

import type { APIRoute } from "astro";
import { MediaRepository, type DownloadResult } from "emdash";

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

async function cancelDownload(download: DownloadResult): Promise<void> {
	try {
		await download.body.cancel();
	} catch (error) {
		console.error("[media] confirm download cancellation failed:", error);
	}
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
			"media:upload",
			"media:edit_any",
		);
		if (ownerDenied) return ownerDenied;

		if (body.size !== undefined && existing.size !== null && body.size !== existing.size) {
			return apiError(
				"UPLOAD_SIZE_MISMATCH",
				"Confirmed size does not match the pending media item",
				400,
			);
		}

		let confirmedSize = existing.size ?? body.size;
		let storedFile: DownloadResult | undefined;

		if (emdash.storage) {
			const exists = await emdash.storage.exists(existing.storageKey);
			if (!exists) {
				// Mark as failed
				await repo.markFailed(id);
				return apiError("FILE_NOT_FOUND", "File was not uploaded to storage", 400);
			}

			storedFile = await emdash.storage.download(existing.storageKey);
			if (confirmedSize !== undefined && storedFile.size !== confirmedSize) {
				await cancelDownload(storedFile);
				return apiError(
					"UPLOAD_SIZE_MISMATCH",
					"Stored file size does not match the pending media item",
					400,
				);
			}
			confirmedSize = storedFile.size;
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
		if (storedFile && existing.mimeType.startsWith("image/")) {
			const tooLarge = storedFile.size > MAX_PLACEHOLDER_DOWNLOAD_BYTES;
			if (!tooLarge) {
				try {
					const bytes = new Uint8Array(await new Response(storedFile.body).arrayBuffer());
					// Defense-in-depth for incorrect storage metadata: even though we
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
				await cancelDownload(storedFile);
				console.warn(
					`[media] confirm skipping placeholder: object ${existing.storageKey} reported size ${storedFile.size} bytes (> ${MAX_PLACEHOLDER_DOWNLOAD_BYTES})`,
				);
			}
		} else if (storedFile) {
			await cancelDownload(storedFile);
		}

		// Confirm the upload
		const item = await repo.confirmUpload(id, {
			size: confirmedSize,
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
