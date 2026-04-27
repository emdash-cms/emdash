/**
 * Media CRUD handlers
 */

import type { Kysely } from "kysely";

import { MediaRepository, type MediaItem } from "../../database/repositories/media.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

export interface MediaListResponse {
	items: MediaItem[];
	nextCursor?: string;
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
		limit?: number;
		mimeType?: string;
	},
): Promise<ApiResult<MediaListResponse>> {
	try {
		const repo = new MediaRepository(db);
		const result = await repo.findMany({
			cursor: params.cursor,
			limit: Math.min(params.limit || 50, 100),
			mimeType: params.mimeType,
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
	},
): Promise<ApiResult<MediaResponse>> {
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
	} catch {
		return {
			success: false,
			error: {
				code: "MEDIA_UPDATE_ERROR",
				message: "Failed to update media",
			},
		};
	}
}

/**
 * Delete media item
 */
export async function handleMediaDelete(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const repo = new MediaRepository(db);
		const deleted = await repo.delete(id);

		if (!deleted) {
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
			data: { deleted: true },
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
