import type { APIRoute } from "astro";
import type { Storage } from "emdash";
import { ulid } from "ulidx";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { MediaRepository } from "#db/repositories/media.js";
import { normalizeMime } from "#media/mime.js";
import { removeUploadAttempt } from "#media/upload-attempts.js";

export const prerender = false;

type FixedLengthStreamConstructor = new (
	expectedLength: number | bigint,
) => TransformStream<ArrayBuffer | ArrayBufferView, Uint8Array>;

declare const FixedLengthStream: FixedLengthStreamConstructor | undefined;

function preserveKnownLength(
	body: ReadableStream<Uint8Array>,
	expectedLength: number,
): ReadableStream<Uint8Array> {
	if (typeof FixedLengthStream === "undefined") return body;
	return body.pipeThrough(new FixedLengthStream(expectedLength));
}

function createUploadAttemptKey(key: string): string {
	const pathSeparator = key.lastIndexOf("/");
	const extensionSeparator = key.lastIndexOf(".");
	if (extensionSeparator > pathSeparator) {
		return `${key.slice(0, extensionSeparator)}.${ulid()}${key.slice(extensionSeparator)}`;
	}
	return `${key}.${ulid()}`;
}

async function getStoredSize(storage: Storage, key: string): Promise<number | null> {
	if (!(await storage.exists(key))) return null;
	const download = await storage.download(key);
	try {
		return download.size;
	} finally {
		try {
			await download.body.cancel();
		} catch (error) {
			console.error("[media] upload download cancellation failed:", error);
		}
	}
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
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

	if (!emdash.storage) {
		return apiError("NO_STORAGE", "Storage not configured", 500);
	}

	try {
		const repo = new MediaRepository(emdash.db);
		const media = await repo.findById(id);
		if (!media) {
			return apiError("NOT_FOUND", `Media item not found: ${id}`, 404);
		}

		if (media.status !== "pending") {
			return apiError("INVALID_STATE", `Media item is not pending: ${media.status}`, 400);
		}

		const ownerDenied = requireOwnerPerm(
			user,
			media.authorId ?? "",
			"media:upload",
			"media:edit_any",
		);
		if (ownerDenied) return ownerDenied;

		if (!Number.isSafeInteger(media.size) || media.size === null || media.size <= 0) {
			return apiError("INVALID_STATE", "Pending media item has no valid upload size", 400);
		}
		const expectedSize = media.size;

		const contentType = request.headers.get("Content-Type");
		if (!contentType || normalizeMime(contentType) !== media.mimeType) {
			return apiError("INVALID_TYPE", "Upload content type does not match the media item", 400);
		}

		if (!request.body) {
			return apiError("NO_FILE", "No file provided", 400);
		}

		const contentLength = request.headers.get("Content-Length");
		if (contentLength !== null) {
			const declaredSize = Number(contentLength);
			if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
				return apiError("INVALID_REQUEST", "Invalid Content-Length header", 400);
			}
			if (declaredSize > expectedSize) {
				return apiError("PAYLOAD_TOO_LARGE", "Upload exceeds the expected size", 413);
			}
			if (declaredSize !== expectedSize) {
				return apiError("UPLOAD_SIZE_MISMATCH", "Upload size does not match the media item", 400);
			}
		}

		const storedSize = await getStoredSize(emdash.storage, media.storageKey);
		if (storedSize === expectedSize) {
			return apiSuccess({ uploaded: true, size: expectedSize });
		}

		let receivedSize = 0;
		const checkedBody = request.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					receivedSize += chunk.byteLength;
					if (receivedSize > expectedSize) {
						controller.error(new Error("Upload exceeds the expected size"));
						return;
					}
					controller.enqueue(chunk);
				},
			}),
		);
		const body = preserveKnownLength(checkedBody, expectedSize);

		const attemptKey = createUploadAttemptKey(media.storageKey);
		await repo.createUploadAttempt(id, attemptKey);

		let attemptSize: number;
		try {
			const result = await emdash.storage.upload({
				key: attemptKey,
				body,
				contentType: media.mimeType,
			});
			attemptSize = result.size;
		} catch (error) {
			await removeUploadAttempt(emdash.storage, repo, attemptKey);
			if (receivedSize > expectedSize) {
				return apiError("PAYLOAD_TOO_LARGE", "Upload exceeds the expected size", 413);
			}
			return handleError(error, "Upload failed", "UPLOAD_ERROR");
		}

		if (receivedSize !== expectedSize || attemptSize !== expectedSize) {
			await removeUploadAttempt(emdash.storage, repo, attemptKey);
			return apiError("UPLOAD_SIZE_MISMATCH", "Upload size does not match the media item", 400);
		}

		let published: boolean;
		try {
			published = await repo.publishPendingStorageKey(id, media.storageKey, attemptKey);
		} catch (error) {
			try {
				const current = await repo.findById(id);
				if (
					current?.storageKey === attemptKey &&
					(current.status === "pending" || current.status === "ready") &&
					current.size === expectedSize &&
					(await getStoredSize(emdash.storage, attemptKey)) === expectedSize
				) {
					return apiSuccess({ uploaded: true, size: expectedSize });
				}
			} catch (verificationError) {
				console.error("[media] upload publication verification failed:", verificationError);
			}
			return handleError(error, "Upload failed", "UPLOAD_ERROR");
		}

		if (!published) {
			const current = await repo.findById(id);
			if (
				current &&
				(current.status === "pending" || current.status === "ready") &&
				current.size === expectedSize &&
				(await getStoredSize(emdash.storage, current.storageKey)) === expectedSize
			) {
				if (current.storageKey !== attemptKey) {
					await removeUploadAttempt(emdash.storage, repo, attemptKey);
				}
				return apiSuccess({ uploaded: true, size: expectedSize });
			}
			await removeUploadAttempt(emdash.storage, repo, attemptKey);
			return apiError("INVALID_STATE", "Media item is no longer pending", 400);
		}

		return apiSuccess({ uploaded: true, size: receivedSize });
	} catch (error) {
		return handleError(error, "Upload failed", "UPLOAD_ERROR");
	}
};
