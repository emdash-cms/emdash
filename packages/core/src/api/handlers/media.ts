/**
 * Media CRUD handlers
 */

import type { Kysely } from "kysely";

import { MediaRepository, type MediaItem } from "../../database/repositories/media.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { isValidFocalPointUpdate, type FocalPointUpdate } from "../../media/focal-point.js";
import { removeUploadAttempt } from "../../media/upload-attempts.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";

const FOREIGN_KEY_VIOLATION_RE = /foreign key constraint failed/i;

export interface MediaListResponse {
	items: MediaItem[];
	nextCursor?: string;
	totalCount?: number;
}

export interface MediaResponse {
	item: MediaItem;
}

/**
 * List media items
 */
export async function handleMediaList(
	db: Kysely<Database>,
	params: {
		cursor?: string;
		page?: number;
		limit?: number;
		mimeType?: string | readonly string[];
		q?: string;
		folderId?: string | null;
	},
): Promise<ApiResult<MediaListResponse>> {
	try {
		if (params.page !== undefined) {
			const limit = Math.min(params.limit || 50, 100);
			const offset = (params.page - 1) * limit;
			if (
				params.cursor !== undefined ||
				!Number.isSafeInteger(params.page) ||
				params.page < 1 ||
				!Number.isSafeInteger(offset)
			) {
				return {
					success: false,
					error: { code: "VALIDATION_ERROR", message: "Invalid media page" },
				};
			}

			const repo = new MediaRepository(db);
			const result = await repo.findPage({
				page: params.page,
				limit,
				mimeType: params.mimeType,
				q: params.q,
				folderId: params.folderId,
			});
			return { success: true, data: result };
		}

		const repo = new MediaRepository(db);
		const result = await repo.findMany({
			cursor: params.cursor,
			limit: Math.min(params.limit || 50, 100),
			mimeType: params.mimeType,
			q: params.q,
			folderId: params.folderId,
		});

		return {
			success: true,
			data: {
				items: result.items,
				nextCursor: result.nextCursor,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: "INVALID_CURSOR", message: error.message },
			};
		}
		return {
			success: false,
			error: {
				code: "MEDIA_LIST_ERROR",
				message: "Failed to list media",
			},
		};
	}
}

/**
 * Get single media item
 */
export async function handleMediaGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<MediaResponse>> {
	try {
		const repo = new MediaRepository(db);
		const item = await repo.findById(id);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Media item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_GET_ERROR",
				message: "Failed to get media",
			},
		};
	}
}

/**
 * Create media item (after file upload)
 */
export async function handleMediaCreate(
	db: Kysely<Database>,
	input: {
		filename: string;
		mimeType: string;
		size?: number;
		width?: number;
		height?: number;
		alt?: string;
		storageKey: string;
		contentHash?: string;
		blurhash?: string;
		dominantColor?: string;
		authorId?: string;
		folderId?: string | null;
	},
): Promise<ApiResult<MediaResponse>> {
	try {
		const repo = new MediaRepository(db);
		const item = await repo.create(input);

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_CREATE_ERROR",
				message: "Failed to create media",
			},
		};
	}
}

/**
 * Confirm an upload minted by the signed upload URL endpoint.
 *
 * The storage key must belong to a pending media row created for the same
 * user; arbitrary keys never reach storage this way.
 */
export async function handleMediaRegisterUpload(
	db: Kysely<Database>,
	storage: Storage,
	input: {
		storageKey: string;
		authorId?: string;
	},
): Promise<ApiResult<MediaResponse>> {
	const invalidKey: ApiResult<never> = {
		success: false,
		error: {
			code: "INVALID_STORAGE_KEY",
			message:
				"storageKey does not match a pending upload created for this user; request a signed upload URL first",
		},
	};
	try {
		const repo = new MediaRepository(db);
		const pending = await repo.findPendingByStorageKey(input.storageKey);
		if (!pending) return invalidKey;
		if ((pending.authorId ?? null) !== (input.authorId ?? null)) return invalidKey;
		if (pending.size === null) {
			return {
				success: false,
				error: {
					code: "INVALID_STATE",
					message: "Pending upload has no expected size",
				},
			};
		}
		if (!(await storage.exists(input.storageKey))) {
			return {
				success: false,
				error: { code: "FILE_NOT_FOUND", message: "File was not uploaded to storage" },
			};
		}

		const storedFile = await storage.download(input.storageKey);
		try {
			if (storedFile.size !== pending.size) {
				return {
					success: false,
					error: {
						code: "UPLOAD_SIZE_MISMATCH",
						message: "Stored file size does not match the pending upload",
					},
				};
			}
		} finally {
			try {
				await storedFile.body.cancel();
			} catch (error) {
				console.error("[media] upload confirmation cancellation failed:", error);
			}
		}

		const item = await repo.confirmUpload(pending.id, undefined, input.storageKey);
		if (!item) return invalidKey;
		try {
			await repo.deleteUploadAttempt(input.storageKey);
		} catch (error) {
			console.error("[media] upload attempt cleanup failed:", error);
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_REGISTER_ERROR",
				message: "Failed to register the upload",
			},
		};
	}
}

/**
 * Update media metadata
 */
export async function handleMediaUpdate(
	db: Kysely<Database>,
	id: string,
	input: {
		alt?: string;
		caption?: string;
		width?: number;
		height?: number;
		folderId?: string | null;
	} & FocalPointUpdate,
): Promise<ApiResult<MediaResponse>> {
	if (!isValidFocalPointUpdate(input)) {
		return {
			success: false,
			error: {
				code: "VALIDATION_ERROR",
				message: "focalX and focalY must both be valid numbers or both be null",
			},
		};
	}
	try {
		const repo = new MediaRepository(db);
		const item = await repo.update(id, input);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Media item not found: ${id}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch (error) {
		if (isForeignKeyViolation(error)) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Media folder not found" },
			};
		}
		return {
			success: false,
			error: {
				code: "MEDIA_UPDATE_ERROR",
				message: "Failed to update media",
			},
		};
	}
}

export async function handleMediaReplaceMetadata(
	db: Kysely<Database>,
	id: string,
	expectedStorageKey: string,
	input: { size: number; width: number; height: number; contentHash: string },
): Promise<ApiResult<MediaResponse>> {
	try {
		const item = await new MediaRepository(db).replaceReadyFile(id, expectedStorageKey, input);
		if (!item) {
			return {
				success: false,
				error: {
					code: "MEDIA_REPLACE_METADATA_ERROR",
					message: "Failed to update replaced media metadata",
				},
			};
		}
		return { success: true, data: { item } };
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_REPLACE_METADATA_ERROR",
				message: "Failed to update replaced media metadata",
			},
		};
	}
}

function isForeignKeyViolation(error: unknown): boolean {
	if (error && typeof error === "object") {
		if ("code" in error && error.code === "23503") return true;
	}
	const message = error instanceof Error ? error.message : "";
	if (FOREIGN_KEY_VIOLATION_RE.test(message)) return true;
	return Boolean(
		error && typeof error === "object" && "cause" in error && isForeignKeyViolation(error.cause),
	);
}

/** Delete a media item, then delete or queue cleanup of its stored object. */
export async function handleMediaDelete(
	db: Kysely<Database>,
	id: string,
	storage?: Storage | null,
): Promise<ApiResult<{ deleted: true; storageKey: string; storageDeleted: boolean }>> {
	try {
		const repo = new MediaRepository(db);
		const notFound: ApiResult<never> = {
			success: false,
			error: { code: "NOT_FOUND", message: `Media item not found: ${id}` },
		};

		const media = await repo.findById(id);
		if (!media) return notFound;

		if (storage) await repo.trackStorageKeyForCleanup(media.id, media.storageKey);
		const storageKey = await repo.deleteWithStorageKey(id);
		if (!storageKey) return notFound;

		let storageDeleted = false;
		if (storage) {
			if (await repo.isStorageKeyReferenced(storageKey)) {
				// A legacy or concurrently-created row still owns this object. Remove
				// the cleanup marker created above so scheduled cleanup cannot delete it.
				await repo.deleteUploadAttempt(storageKey);
			} else {
				storageDeleted = await removeUploadAttempt(storage, repo, storageKey, {
					allowUntracked: true,
				});
			}
		}

		return {
			success: true,
			data: { deleted: true, storageKey, storageDeleted },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_DELETE_ERROR",
				message: "Failed to delete media",
			},
		};
	}
}
