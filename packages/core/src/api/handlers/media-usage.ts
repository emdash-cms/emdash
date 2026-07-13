import type { Kysely } from "kysely";

import {
	MediaUsageRepository,
	type MediaUsageCollectionIndexStatusScope,
} from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
} from "../../media/usage/content-refresh.js";
import {
	repairContentMediaUsageAll,
	repairContentMediaUsageCollection,
	type ContentMediaUsageRepairAllResult,
	type ContentMediaUsageRepairCollectionResult,
} from "../../media/usage/content-repair.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "../../media/usage/content-snapshots.js";
import { ErrorCode } from "../errors.js";
import type {
	MediaUsageCoverageStatus,
	MediaUsageRepairRequest,
	MediaUsageRepairResponse,
	MediaUsageSummary,
} from "../schemas/media-usage.js";
import type { ApiResult } from "../types.js";

export type {
	MediaUsageCoverage,
	MediaUsageCoverageStatus,
	MediaUsageRepairRequest,
	MediaUsageRepairResponse,
	MediaUsageSummary,
} from "../schemas/media-usage.js";

type ContentMediaUsageRepairResult =
	| ContentMediaUsageRepairCollectionResult
	| ContentMediaUsageRepairAllResult;

export function aggregateMediaUsageCoverageStatus(
	scopes: readonly MediaUsageCollectionIndexStatusScope[],
): MediaUsageCoverageStatus {
	const statuses = scopes.map(normalizeMediaUsageCoverageStatus);
	if (statuses.every((status) => status === "complete")) {
		return "complete";
	}
	if (statuses.includes("unknown")) return "unknown";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("stale")) return "stale";
	if (statuses.includes("partial")) return "partial";
	if (statuses.every((status) => status === "never")) return "never";
	if (statuses.every((status) => status === "failed")) return "failed";
	return "partial";
}

export async function handleMediaUsageSummaries(
	db: Kysely<Database>,
	mediaIds: readonly string[],
	options: { includeCount: boolean },
): Promise<ApiResult<Record<string, MediaUsageSummary>>> {
	try {
		const repository = new MediaUsageRepository(db);
		const scopes = await repository.findCollectionIndexStatusScopes({
			adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
			scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
		});
		const coverage = {
			scope: "all_content_collections" as const,
			status: aggregateMediaUsageCoverageStatus(scopes),
		};
		const counts = options.includeCount
			? await repository.findActiveEntryCountsByMediaIds(mediaIds)
			: null;
		const summaries: Record<string, MediaUsageSummary> = {};

		for (const mediaId of new Set(mediaIds)) {
			summaries[mediaId] = {
				count: counts ? (counts.get(mediaId) ?? 0) : null,
				coverage,
			};
		}

		return { success: true, data: summaries };
	} catch (error) {
		console.error("[media-usage] summary read failed:", error);
		return {
			success: false,
			error: {
				code: ErrorCode.MEDIA_USAGE_READ_ERROR,
				message: "Failed to read media usage",
			},
		};
	}
}

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

function normalizeMediaUsageCoverageStatus(
	scope: MediaUsageCollectionIndexStatusScope,
): MediaUsageCoverageStatus {
	if (scope.status === null) return "never";
	if (scope.status === "complete") {
		return scope.schemaVersion === CONTENT_SOURCE_SCHEMA_VERSION ? "complete" : "stale";
	}
	if (
		scope.status === "never" ||
		scope.status === "running" ||
		scope.status === "partial" ||
		scope.status === "failed" ||
		scope.status === "stale"
	) {
		return scope.status;
	}
	return "unknown";
}
