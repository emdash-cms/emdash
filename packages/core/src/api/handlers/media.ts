/**
 * Media CRUD handlers
 */

import type { Kysely } from "kysely";

import { MediaRepository, type MediaItem } from "../../database/repositories/media.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { isValidFocalPointUpdate, type FocalPointUpdate } from "../../media/focal-point.js";
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

/**
 * Delete media item
 */
export async function handleMediaDelete(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<{ deleted: true; storageKey: string }>> {
	try {
		const repo = new MediaRepository(db);
		const storageKey = await repo.deleteWithStorageKey(id);

		if (!storageKey) {
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
			data: { deleted: true, storageKey },
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
