/**
 * Confirm media upload endpoint
 *
 * POST /_emdash/api/media/{id}/confirm
 *
 * Confirms that the client has successfully uploaded the file to storage.
 * Marks the media record as ready and optionally updates metadata.
 */

import type { APIRoute } from "astro";
import type { DownloadResult } from "emdash";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { mediaConfirmBody } from "#api/schemas.js";
import { MediaRepository } from "#db/repositories/media.js";
import { enrichImageMetadata } from "#media/enrich.js";
import type { MediaItem } from "#types";
import { computeContentHash, MAX_CONTENT_HASH_BYTES } from "#utils/hash.js";

export const prerender = false;

/**
 * Max raw bytes to buffer for server-side LQIP generation at confirm time. The
 * signed-URL upload flow exists so large files bypass server buffering — re-reading
 * the whole object into a Worker's 128 MB heap to compute a blurhash would OOM
 * on the very uploads that flow was designed for. LQIP is progressive
 * enhancement: large images simply ship without a server-generated placeholder.
 */
const MAX_PLACEHOLDER_DOWNLOAD_BYTES = MAX_CONTENT_HASH_BYTES;

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

async function forgetUploadAttempt(repo: MediaRepository, storageKey: string): Promise<void> {
	try {
		await repo.deleteUploadAttempt(storageKey);
	} catch (error) {
		console.error("[media] confirm upload attempt cleanup failed:", error);
	}
}

async function confirmationConflict(repo: MediaRepository, id: string): Promise<Response> {
	const current = await repo.findById(id);
	if (!current) {
		return apiError("NOT_FOUND", `Media item not found: ${id}`, 404);
	}
	if (current.status === "ready") {
		await forgetUploadAttempt(repo, current.storageKey);
		return apiSuccess({ item: addUrlToMedia(current) });
	}
	if (current.status === "pending") {
		return apiError("INVALID_STATE", "Media item changed during confirmation", 409);
	}
	return apiError("INVALID_STATE", `Media item is not pending: ${current.status}`, 400);
}

async function consumeDownload(download: DownloadResult): Promise<Uint8Array> {
	const reader = download.body.getReader();
	try {
		const bytes = new Uint8Array(download.size);
		let receivedSize = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (receivedSize + value.byteLength > bytes.byteLength) {
				throw new Error("Stored file exceeds its reported size");
			}
			bytes.set(value, receivedSize);
			receivedSize += value.byteLength;
		}
		if (receivedSize !== download.size) {
			throw new Error("Stored file size does not match its reported size");
		}
		return bytes;
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch (cancelError) {
			console.error("[media] confirm download cancellation failed:", cancelError);
		}
		throw error;
	} finally {
		reader.releaseLock();
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

		// Only the uploader or a user with media:edit_any can confirm/fail a pending upload
		const ownerDenied = requireOwnerPerm(
			user,
			existing.authorId ?? "",
			"media:upload",
			"media:edit_any",
		);
		if (ownerDenied) return ownerDenied;

		if (existing.status === "ready") {
			await forgetUploadAttempt(repo, existing.storageKey);
			return apiSuccess({ item: addUrlToMedia(existing) });
		}
		if (existing.status !== "pending") {
			return apiError("INVALID_STATE", `Media item is not pending: ${existing.status}`, 400);
		}

		if (body.size !== undefined && existing.size !== null && body.size !== existing.size) {
			return apiError(
				"UPLOAD_SIZE_MISMATCH",
				"Confirmed size does not match the pending media item",
				400,
			);
		}

		let confirmedSize = existing.size ?? body.size;
		let contentHash = existing.contentHash;
		let imageBytes: Uint8Array | undefined;

		if (emdash.storage) {
			const exists = await emdash.storage.exists(existing.storageKey);
			if (!exists) {
				const failed = await repo.markFailed(id, existing.storageKey);
				if (!failed) return await confirmationConflict(repo, id);
				return apiError("FILE_NOT_FOUND", "File was not uploaded to storage", 400);
			}

			const storedFile = await emdash.storage.download(existing.storageKey);
			if (confirmedSize !== undefined && storedFile.size !== confirmedSize) {
				await cancelDownload(storedFile);
				return apiError(
					"UPLOAD_SIZE_MISMATCH",
					"Stored file size does not match the pending media item",
					400,
				);
			}
			confirmedSize = storedFile.size;

			const isImage = existing.mimeType.startsWith("image/");
			const canBuffer = storedFile.size <= MAX_PLACEHOLDER_DOWNLOAD_BYTES;
			const hasServerHash =
				contentHash !== null && (await repo.hasUploadAttempt(existing.storageKey));
			if (canBuffer && (isImage || !hasServerHash)) {
				const bytes = await consumeDownload(storedFile);
				contentHash = bytes.byteLength > 0 ? await computeContentHash(bytes) : null;
				if (isImage && bytes.byteLength > 0) imageBytes = bytes;
			} else {
				if (!hasServerHash) contentHash = null;
				await cancelDownload(storedFile);
			}

			if (isImage && !canBuffer) {
				console.warn(
					`[media] confirm skipping placeholder: object ${existing.storageKey} reported size ${storedFile.size} bytes (> ${MAX_PLACEHOLDER_DOWNLOAD_BYTES})`,
				);
			}
		}

		// LQIP is best-effort; oversized images skip server-side placeholders.
		let blurhash: string | undefined;
		let dominantColor: string | undefined;
		let width = body.width;
		let height = body.height;
		if (imageBytes) {
			try {
				const enriched = await enrichImageMetadata(imageBytes, existing.mimeType, {
					knownDimensions:
						body.width != null && body.height != null
							? { width: body.width, height: body.height }
							: undefined,
				});
				blurhash = enriched.blurhash;
				dominantColor = enriched.dominantColor;
				width = width ?? enriched.width;
				height = height ?? enriched.height;
			} catch (error) {
				console.error("[media] confirm placeholder generation failed:", error);
			}
		}

		// Confirm the upload
		const item = await repo.confirmUpload(
			id,
			{
				size: confirmedSize,
				width,
				height,
				blurhash,
				dominantColor,
				contentHash,
			},
			existing.storageKey,
		);

		if (!item) {
			return await confirmationConflict(repo, id);
		}

		await forgetUploadAttempt(repo, item.storageKey);

		// Add URL to the response (relative URL for portability)
		const itemWithUrl = addUrlToMedia(item);

		return apiSuccess({ item: itemWithUrl });
	} catch (error) {
		return handleError(error, "Failed to confirm upload", "CONFIRM_ERROR");
	}
};
