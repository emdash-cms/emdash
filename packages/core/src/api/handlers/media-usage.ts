import type { Kysely } from "kysely";

import {
	MediaUsageRepository,
	type MediaUsageCollectionIndexStatusScope,
	type MediaUsageEntryGroup,
} from "../../database/repositories/media-usage.js";
import { MediaRepository } from "../../database/repositories/media.js";
import { InvalidCursorError } from "../../database/repositories/types.js";
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
	MediaUsageCoverage,
	MediaUsageCoverageStatus,
	MediaUsageDetailsResponse,
	MediaUsageEntryDetail,
	MediaUsageOccurrenceDetail,
	MediaUsageRepairRequest,
	MediaUsageRepairResponse,
	MediaUsageSummary,
} from "../schemas/media-usage.js";
import type { ApiResult } from "../types.js";

export type {
	MediaUsageCoverage,
	MediaUsageCoverageStatus,
	MediaUsageDetailsResponse,
	MediaUsageEntryDetail,
	MediaUsageOccurrenceDetail,
	MediaUsageSourceDetail,
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
	if (mediaIds.length === 0) return { success: true, data: {} };

	try {
		const repository = new MediaUsageRepository(db);
		const coverage = await loadMediaUsageCoverage(repository);
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

export async function handleMediaUsageDetails(
	db: Kysely<Database>,
	mediaId: string,
	options: { cursor?: string; limit?: number },
): Promise<ApiResult<MediaUsageDetailsResponse>> {
	try {
		const media = await new MediaRepository(db).findById(mediaId);
		if (!media) {
			return {
				success: false,
				error: {
					code: ErrorCode.NOT_FOUND,
					message: `Media item not found: ${mediaId}`,
				},
			};
		}

		const repository = new MediaUsageRepository(db);
		const coverage = await loadMediaUsageCoverage(repository);
		const page = await repository.findCurrentEntryUsagePageByMediaId(mediaId, options);
		return {
			success: true,
			data: {
				items: page.items.map(toMediaUsageEntryDetail),
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
				coverage,
			},
		};
	} catch (error) {
		if (error instanceof InvalidCursorError) {
			return {
				success: false,
				error: { code: ErrorCode.INVALID_CURSOR, message: error.message },
			};
		}
		console.error("[media-usage] detail read failed:", error);
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

async function loadMediaUsageCoverage(
	repository: MediaUsageRepository,
): Promise<MediaUsageCoverage> {
	const scopes = await repository.findCollectionIndexStatusScopes({
		adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
		scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
	});
	return {
		scope: "all_content_collections",
		status: aggregateMediaUsageCoverageStatus(scopes),
	};
}

function toMediaUsageEntryDetail(group: MediaUsageEntryGroup): MediaUsageEntryDetail {
	const preferred =
		group.sources.find(({ source }) => source.sourceVariant === "draft_overlay") ??
		group.sources.find(({ source }) => source.sourceVariant === "columns");
	if (!preferred) {
		throw new Error("Media usage entry has no supported source");
	}

	return {
		collection: group.collectionSlug,
		contentId: group.contentId,
		title: preferred.source.contentTitle,
		slug: preferred.source.contentSlug,
		locale: preferred.source.locale,
		status: preferred.source.contentStatus,
		scheduledAt: preferred.source.contentScheduledAt,
		deletedAt: group.contentDeletedAt,
		sources: group.sources.flatMap(({ source, occurrences }) => {
			if (source.sourceVariant !== "columns" && source.sourceVariant !== "draft_overlay") {
				return [];
			}
			return [
				{
					variant: source.sourceVariant,
					occurrences: occurrences.map((occurrence) => ({
						fieldSlug: occurrence.fieldSlug,
						fieldPath: occurrence.fieldPath,
						occurrenceIndex: occurrence.occurrenceIndex,
						referenceType: normalizeMediaUsageReferenceType(occurrence.referenceType),
					})),
				},
			];
		}),
	};
}

function normalizeMediaUsageReferenceType(
	referenceType: string,
): MediaUsageOccurrenceDetail["referenceType"] {
	if (
		referenceType === "image_field" ||
		referenceType === "file_field" ||
		referenceType === "portable_text_image"
	) {
		return referenceType;
	}
	return "unknown";
}
