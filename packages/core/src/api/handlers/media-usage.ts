import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import {
	repairContentMediaUsageAll,
	repairContentMediaUsageCollection,
	type ContentMediaUsageRepairAllResult,
	type ContentMediaUsageRepairCollectionResult,
} from "../../media/usage/content-repair.js";
import { ErrorCode } from "../errors.js";
import type { MediaUsageRepairRequest, MediaUsageRepairResponse } from "../schemas/media-usage.js";
import type { ApiResult } from "../types.js";

export type { MediaUsageRepairRequest, MediaUsageRepairResponse } from "../schemas/media-usage.js";

type ContentMediaUsageRepairResult =
	| ContentMediaUsageRepairCollectionResult
	| ContentMediaUsageRepairAllResult;

export async function handleMediaUsageRepair(
	db: Kysely<Database>,
	input: MediaUsageRepairRequest,
): Promise<ApiResult<MediaUsageRepairResponse>> {
	try {
		let result: ContentMediaUsageRepairResult;
		if (input.scope === "collection") {
			result = await repairContentMediaUsageCollection(db, { collectionSlug: input.collection });
		} else if (input.scope === "all") {
			result = await repairContentMediaUsageAll(db);
		} else {
			return {
				success: false,
				error: {
					code: ErrorCode.VALIDATION_ERROR,
					message: "Invalid media usage repair request",
				},
			};
		}

		return { success: true, data: toMediaUsageRepairResponse(result) };
	} catch (error) {
		console.error("[media-usage] repair failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_REPAIR_ERROR,
				message: "Failed to repair media usage",
			},
		};
	}
}

export function toMediaUsageRepairResponse(
	result: ContentMediaUsageRepairResult,
): MediaUsageRepairResponse {
	const collections = "collections" in result ? result.collections : [result];

	return {
		status: result.status,
		indexedSourceCount: result.indexedSourceCount,
		failedSourceCount: result.failedSourceCount,
		skippedSourceCount: result.skippedSourceCount,
		deletedSourceCount: result.deletedSourceCount,
		collections: collections.map(toMediaUsageRepairCollectionSummary),
	};
}

function toMediaUsageRepairCollectionSummary(result: ContentMediaUsageRepairCollectionResult) {
	return {
		collection: result.scope.scopeKey,
		status: result.status,
		indexedSourceCount: result.indexedSourceCount,
		failedSourceCount: result.failedSourceCount,
		skippedSourceCount: result.skippedSourceCount,
		deletedSourceCount: result.deletedSourceCount,
		lastErrorCode: result.lastErrorCode,
		startedAt: result.startedAt,
		completedAt: result.completedAt,
	};
}
