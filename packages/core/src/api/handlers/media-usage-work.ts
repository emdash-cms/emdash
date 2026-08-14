import type { Kysely } from "kysely";

import { MediaUsageWorkRepository } from "../../database/repositories/media-usage-work.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { MediaUsageCollectionDeletionRepository } from "../../media/usage/collection-deletion.js";
import { ErrorCode } from "../errors.js";
import type {
	MediaUsageWorkListQuery,
	MediaUsageWorkListResponse,
	MediaUsageWorkRetryRequest,
	MediaUsageWorkRetryResponse,
	MediaUsageCollectionDeletionListQuery,
	MediaUsageCollectionDeletionListResponse,
	MediaUsageCollectionDeletionRetryRequest,
	MediaUsageCollectionDeletionRetryResponse,
} from "../schemas/media-usage.js";
import type { ApiResult } from "../types.js";

export type {
	MediaUsageWorkItem,
	MediaUsageWorkListQuery,
	MediaUsageWorkListResponse,
	MediaUsageWorkRetryRequest,
	MediaUsageWorkRetryResponse,
} from "../schemas/media-usage.js";

export async function handleMediaUsageWorkList(
	db: Kysely<Database>,
	query: MediaUsageWorkListQuery,
): Promise<ApiResult<MediaUsageWorkListResponse>> {
	try {
		const page = await new MediaUsageWorkRepository(db).findOperatorPage({
			collectionSlug: query.collection,
			state: query.state,
			cursor: query.cursor,
			limit: query.limit,
		});
		if (!page) {
			return {
				success: false,
				error: {
					code: ErrorCode.COLLECTION_NOT_FOUND,
					message: "Collection not found",
				},
			};
		}
		return { success: true, data: page };
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: {
					code: ErrorCode.INVALID_CURSOR,
					message: "Invalid media usage work cursor",
				},
			};
		}
		console.error("[media-usage-work] list failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_WORK_LIST_ERROR,
				message: "Failed to list media usage work",
			},
		};
	}
}

export async function handleMediaUsageCollectionDeletionList(
	db: Kysely<Database>,
	query: MediaUsageCollectionDeletionListQuery,
): Promise<ApiResult<MediaUsageCollectionDeletionListResponse>> {
	try {
		return {
			success: true,
			data: await new MediaUsageCollectionDeletionRepository(db).findOperatorPage(query),
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: ErrorCode.INVALID_CURSOR, message: "Invalid cursor" },
			};
		}
		console.error("[media-usage:collection-deletion] list failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_COLLECTION_DELETION_LIST_ERROR,
				message: "Failed to list collection deletions",
			},
		};
	}
}

export async function handleMediaUsageCollectionDeletionRetry(
	db: Kysely<Database>,
	input: MediaUsageCollectionDeletionRetryRequest,
): Promise<ApiResult<MediaUsageCollectionDeletionRetryResponse>> {
	try {
		const result = await new MediaUsageCollectionDeletionRepository(db).retryOperatorDeletion(
			input,
		);
		if (result.outcome === "pending") {
			return { success: true, data: { changed: result.changed, item: result.item } };
		}
		if (result.outcome === "lease_active") {
			return {
				success: false,
				error: {
					code: ErrorCode.WORK_LEASE_ACTIVE,
					message: "Collection deletion is currently leased",
					details: { leaseExpiresAt: result.leaseExpiresAt },
				},
			};
		}
		return {
			success: false,
			error: {
				code: result.outcome === "not_found" ? ErrorCode.NOT_FOUND : ErrorCode.WORK_CHANGED,
				message:
					result.outcome === "not_found"
						? "Collection deletion not found"
						: "Collection deletion changed",
			},
		};
	} catch (error) {
		console.error("[media-usage:collection-deletion] retry failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_COLLECTION_DELETION_RETRY_ERROR,
				message: "Failed to retry collection deletion",
			},
		};
	}
}

export async function handleMediaUsageWorkRetry(
	db: Kysely<Database>,
	input: MediaUsageWorkRetryRequest,
): Promise<ApiResult<MediaUsageWorkRetryResponse>> {
	try {
		const result = await new MediaUsageWorkRepository(db).retryOperatorWork(input);
		switch (result.outcome) {
			case "pending":
				return {
					success: true,
					data: { changed: result.changed, item: result.work },
				};
			case "lease_active":
				return {
					success: false,
					error: {
						code: ErrorCode.WORK_LEASE_ACTIVE,
						message: "Media usage work is currently leased",
						details: { leaseExpiresAt: result.leaseExpiresAt },
					},
				};
			case "collection_not_found":
				return {
					success: false,
					error: {
						code: ErrorCode.COLLECTION_NOT_FOUND,
						message: "Collection not found",
					},
				};
			case "conflict":
				return {
					success: false,
					error: {
						code: ErrorCode.WORK_CHANGED,
						message: "Media usage work changed; retry the request",
					},
				};
		}
	} catch (error) {
		console.error("[media-usage-work] retry failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_WORK_RETRY_ERROR,
				message: "Failed to retry media usage work",
			},
		};
	}
}
