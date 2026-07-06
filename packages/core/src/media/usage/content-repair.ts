import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import {
	MediaUsageRepository,
	type MediaUsageSource,
} from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import {
	loadContentMediaUsageFields,
	MediaUsageFieldDiscoveryError,
	type ContentMediaUsageFieldDiscovery,
} from "./content-fields.js";
import {
	CONTENT_MEDIA_USAGE_ADAPTER_ID,
	CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
	withContentUsageCollectionLock,
} from "./content-refresh.js";
import {
	CONTENT_SOURCE_SCHEMA_VERSION,
	loadContentMediaUsageSnapshots,
} from "./content-snapshots.js";
import {
	buildContentMediaUsageSourceKey,
	MEDIA_USAGE_CONTENT_SOURCE_VARIANTS,
} from "./source-key.js";

export type ContentMediaUsageRepairStatus = "complete" | "partial" | "failed" | "stale";

export const CONTENT_MEDIA_USAGE_REPAIR_ERROR = {
	COLLECTION_NOT_FOUND: "COLLECTION_NOT_FOUND",
	CONTENT_NOT_FOUND: "CONTENT_NOT_FOUND",
	DRAFT_REVISION_NOT_FOUND: "DRAFT_REVISION_NOT_FOUND",
	DRAFT_REVISION_MISMATCH: "DRAFT_REVISION_MISMATCH",
	DRAFT_REVISION_INVALID: "DRAFT_REVISION_INVALID",
	CONTENT_USAGE_REPAIR_ERROR: "CONTENT_USAGE_REPAIR_ERROR",
	CONTENT_USAGE_REPAIR_CONFLICT: "CONTENT_USAGE_REPAIR_CONFLICT",
	INVALID_REPEATER_VALIDATION: "INVALID_REPEATER_VALIDATION",
} as const;

export type ContentMediaUsageRepairErrorCode =
	(typeof CONTENT_MEDIA_USAGE_REPAIR_ERROR)[keyof typeof CONTENT_MEDIA_USAGE_REPAIR_ERROR];

export interface ContentMediaUsageRepairCollectionInput {
	collectionSlug: string;
}

export interface ContentMediaUsageRepairScope {
	adapterId: typeof CONTENT_MEDIA_USAGE_ADAPTER_ID;
	scopeType: typeof CONTENT_MEDIA_USAGE_COLLECTION_SCOPE;
	scopeKey: string;
}

export interface ContentMediaUsageRepairCollectionResult {
	scope: ContentMediaUsageRepairScope;
	status: ContentMediaUsageRepairStatus;
	indexedSourceCount: number;
	failedSourceCount: number;
	skippedSourceCount: number;
	deletedSourceCount: number;
	lastErrorCode: string | null;
	startedAt: string;
	completedAt: string | null;
}

export interface ContentMediaUsageCollectionScan {
	collectionSlug: string;
	contentIds: string[];
}

export async function scanContentMediaUsageCollection(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<ContentMediaUsageCollectionScan | null> {
	validateIdentifier(collectionSlug, "collection slug");
	const collection = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();
	if (!collection) return null;

	const tableName = getContentTableName(collectionSlug);
	const rows = await sql<{ id: string }>`
		SELECT id
		FROM ${sql.ref(tableName)}
		ORDER BY id ASC
	`.execute(db);

	return {
		collectionSlug,
		contentIds: rows.rows.map((row) => row.id),
	};
}

export async function repairContentMediaUsageCollection(
	db: Kysely<Database>,
	input: ContentMediaUsageRepairCollectionInput,
): Promise<ContentMediaUsageRepairCollectionResult> {
	validateIdentifier(input.collectionSlug, "collection slug");
	return withContentUsageCollectionLock(input.collectionSlug, () =>
		repairContentMediaUsageCollectionUnlocked(db, input.collectionSlug),
	);
}

async function repairContentMediaUsageCollectionUnlocked(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<ContentMediaUsageRepairCollectionResult> {
	const startedAt = new Date().toISOString();
	const scope = contentMediaUsageCollectionScope(collectionSlug);
	if (!(await contentCollectionExists(db, collectionSlug))) {
		return {
			scope,
			status: "failed",
			indexedSourceCount: 0,
			failedSourceCount: 0,
			skippedSourceCount: 0,
			deletedSourceCount: 0,
			lastErrorCode: CONTENT_MEDIA_USAGE_REPAIR_ERROR.COLLECTION_NOT_FOUND,
			startedAt,
			completedAt: startedAt,
		};
	}

	const repo = new MediaUsageRepository(db);
	const runToken = ulid();
	await repo.beginIndexStatusRepair({
		...scope,
		runToken,
		schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		startedAt,
	});

	try {
		const scan = await scanContentMediaUsageCollection(db, collectionSlug);
		if (!scan) {
			const completedAt = new Date().toISOString();
			return await finalizeRepairStatus(repo, {
				...scope,
				runToken,
				counts: {
					indexedSourceCount: 0,
					failedSourceCount: 0,
					skippedSourceCount: 0,
					deletedSourceCount: 0,
					lastErrorCode: CONTENT_MEDIA_USAGE_REPAIR_ERROR.COLLECTION_NOT_FOUND,
				},
				status: "failed",
				startedAt,
				completedAt,
			});
		}
		const counts = await repairScannedContentSources(db, repo, scan);
		const finalScan = await scanContentMediaUsageCollection(db, collectionSlug);
		const scannedContentCount = finalScan?.contentIds.length ?? scan.contentIds.length;
		if (!finalScan) {
			counts.failedSourceCount++;
			counts.lastErrorCode = CONTENT_MEDIA_USAGE_REPAIR_ERROR.COLLECTION_NOT_FOUND;
		} else if (!sameContentIds(scan.contentIds, finalScan.contentIds)) {
			counts.skippedSourceCount++;
			counts.lastErrorCode = CONTENT_MEDIA_USAGE_REPAIR_ERROR.CONTENT_USAGE_REPAIR_CONFLICT;
		}
		const completedAt = new Date().toISOString();
		const status = determineRepairStatus(counts, scannedContentCount);
		return await finalizeRepairStatus(repo, {
			...scope,
			runToken,
			counts,
			status,
			startedAt,
			completedAt,
		});
	} catch (error) {
		if (!(error instanceof MediaUsageFieldDiscoveryError)) {
			console.error(`[media-usage] Failed to repair collection ${collectionSlug}:`, error);
		}
		const completedAt = new Date().toISOString();
		const lastErrorCode =
			error instanceof MediaUsageFieldDiscoveryError
				? error.code
				: CONTENT_MEDIA_USAGE_REPAIR_ERROR.CONTENT_USAGE_REPAIR_ERROR;
		return finalizeRepairStatus(repo, {
			...scope,
			runToken,
			counts: {
				indexedSourceCount: 0,
				failedSourceCount: 0,
				skippedSourceCount: 0,
				deletedSourceCount: 0,
				lastErrorCode,
			},
			status: "failed",
			startedAt,
			completedAt,
		});
	}
}

interface RepairCounts {
	indexedSourceCount: number;
	failedSourceCount: number;
	skippedSourceCount: number;
	deletedSourceCount: number;
	lastErrorCode: ContentMediaUsageRepairErrorCode | null;
}

async function repairScannedContentSources(
	db: Kysely<Database>,
	repo: MediaUsageRepository,
	scan: ContentMediaUsageCollectionScan,
): Promise<RepairCounts> {
	const counts: RepairCounts = {
		indexedSourceCount: 0,
		failedSourceCount: 0,
		skippedSourceCount: 0,
		deletedSourceCount: 0,
		lastErrorCode: null,
	};

	const fieldDiscovery = await loadContentMediaUsageFields(db, scan.collectionSlug);
	const observedSources = await repo.findSources(buildContentSourceKeysForScan(scan));

	for (const contentId of scan.contentIds) {
		await repairContentSource(
			db,
			repo,
			scan.collectionSlug,
			contentId,
			fieldDiscovery,
			observedSources,
			counts,
		);
	}

	await reconcileOrphanedContentSources(db, repo, scan.collectionSlug, counts);
	return counts;
}

async function repairContentSource(
	db: Kysely<Database>,
	repo: MediaUsageRepository,
	collectionSlug: string,
	contentId: string,
	fieldDiscovery: ContentMediaUsageFieldDiscovery,
	observedSources: Map<string, MediaUsageSource>,
	counts: RepairCounts,
): Promise<void> {
	const sourceKeys = buildContentSourceKeys(collectionSlug, contentId);
	const snapshotsResult = await loadContentMediaUsageSnapshots(
		db,
		collectionSlug,
		contentId,
		fieldDiscovery,
	);
	if (!snapshotsResult.success) {
		counts.lastErrorCode = snapshotsResult.error;
		if (snapshotsResult.source) {
			const result = await repo.markSourceAttemptedIfMatching(
				{
					...snapshotsResult.source,
					sourceCompleteness: "failed",
					lastErrorCode: snapshotsResult.error,
				},
				observedSources.get(snapshotsResult.source.sourceKey) ?? null,
			);
			if (result.attempted) {
				counts.failedSourceCount++;
			} else {
				counts.skippedSourceCount++;
				counts.lastErrorCode = CONTENT_MEDIA_USAGE_REPAIR_ERROR.CONTENT_USAGE_REPAIR_CONFLICT;
			}
			return;
		}

		counts.failedSourceCount++;
		return;
	}

	const expectedSourceKeys = new Set<string>();
	for (const snapshot of snapshotsResult.snapshots) {
		expectedSourceKeys.add(snapshot.source.sourceKey);
		const result = await repo.replaceSourceIfMatching(
			snapshot.source,
			snapshot.occurrences,
			observedSources.get(snapshot.source.sourceKey) ?? null,
		);
		if (result.replaced) {
			counts.indexedSourceCount++;
		} else {
			counts.skippedSourceCount++;
			counts.lastErrorCode = CONTENT_MEDIA_USAGE_REPAIR_ERROR.CONTENT_USAGE_REPAIR_CONFLICT;
		}
	}

	for (const sourceKey of sourceKeys) {
		if (expectedSourceKeys.has(sourceKey)) continue;
		const observedSource = observedSources.get(sourceKey);
		if (!observedSource) continue;
		await deleteObservedSource(repo, sourceKey, observedSource, counts);
	}
}

async function reconcileOrphanedContentSources(
	db: Kysely<Database>,
	repo: MediaUsageRepository,
	collectionSlug: string,
	counts: RepairCounts,
): Promise<void> {
	const sources = await repo.findCollectionContentSources(collectionSlug);
	const existingContentIds = await findExistingContentIds(
		db,
		collectionSlug,
		sources.flatMap((source) => (source.contentId ? [source.contentId] : [])),
	);

	for (const source of sources) {
		if (!source.contentId) {
			await deleteObservedSource(repo, source.sourceKey, source, counts);
			continue;
		}
		if (existingContentIds.has(source.contentId)) continue;
		await deleteObservedSourceIfContentAbsent(repo, collectionSlug, source, counts);
	}
}

async function findExistingContentIds(
	db: Kysely<Database>,
	collectionSlug: string,
	contentIds: readonly string[],
): Promise<Set<string>> {
	validateIdentifier(collectionSlug, "collection slug");
	const existingContentIds = new Set<string>();
	const uniqueContentIds = [...new Set(contentIds)];
	if (uniqueContentIds.length === 0) return existingContentIds;

	const tableName = getContentTableName(collectionSlug);
	for (const contentIdBatch of chunks(uniqueContentIds, SQL_BATCH_SIZE)) {
		const result = await sql<{ id: string }>`
			SELECT id
			FROM ${sql.ref(tableName)}
			WHERE id IN (${sql.join(contentIdBatch)})
		`.execute(db);
		for (const row of result.rows) {
			existingContentIds.add(row.id);
		}
	}

	return existingContentIds;
}

async function deleteObservedSourceIfContentAbsent(
	repo: MediaUsageRepository,
	collectionSlug: string,
	observedSource: MediaUsageSource,
	counts: RepairCounts,
): Promise<void> {
	if (!observedSource.contentId) return;
	const result = await repo.deleteSourceIfMatchingContentAbsent(
		observedSource.sourceKey,
		observedSource,
		collectionSlug,
		observedSource.contentId,
	);
	if (result.deleted) {
		counts.deletedSourceCount++;
		return;
	}
	if (result.contentPresent) return;
	if (result.source) {
		counts.skippedSourceCount++;
		counts.lastErrorCode = CONTENT_MEDIA_USAGE_REPAIR_ERROR.CONTENT_USAGE_REPAIR_CONFLICT;
	}
}

async function deleteObservedSource(
	repo: MediaUsageRepository,
	sourceKey: string,
	observedSource: MediaUsageSource,
	counts: RepairCounts,
): Promise<void> {
	const result = await repo.deleteSourceIfMatching(sourceKey, observedSource);
	if (result.deleted) {
		counts.deletedSourceCount++;
		return;
	}
	if (result.source) {
		counts.skippedSourceCount++;
		counts.lastErrorCode = CONTENT_MEDIA_USAGE_REPAIR_ERROR.CONTENT_USAGE_REPAIR_CONFLICT;
	}
}

interface FinalizeInput extends ContentMediaUsageRepairScope {
	runToken: string;
	counts: RepairCounts;
	status: Exclude<ContentMediaUsageRepairStatus, "stale">;
	startedAt: string;
	completedAt: string;
}

async function finalizeRepairStatus(
	repo: MediaUsageRepository,
	input: FinalizeInput,
): Promise<ContentMediaUsageRepairCollectionResult> {
	const result = await repo.finalizeIndexStatusRepairIfRunning({
		adapterId: input.adapterId,
		scopeType: input.scopeType,
		scopeKey: input.scopeKey,
		runToken: input.runToken,
		status: input.status,
		schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		completedAt: input.completedAt,
		indexedSourceCount: input.counts.indexedSourceCount,
		failedSourceCount: input.counts.failedSourceCount,
		lastErrorCode: input.counts.lastErrorCode,
	});

	return {
		scope: {
			adapterId: input.adapterId,
			scopeType: input.scopeType,
			scopeKey: input.scopeKey,
		},
		status: result.finalized ? input.status : "stale",
		indexedSourceCount: input.counts.indexedSourceCount,
		failedSourceCount: input.counts.failedSourceCount,
		skippedSourceCount: input.counts.skippedSourceCount,
		deletedSourceCount: input.counts.deletedSourceCount,
		lastErrorCode: result.finalized
			? input.counts.lastErrorCode
			: (result.status?.lastErrorCode ??
				CONTENT_MEDIA_USAGE_REPAIR_ERROR.CONTENT_USAGE_REPAIR_CONFLICT),
		startedAt: input.startedAt,
		completedAt: result.finalized ? input.completedAt : null,
	};
}

function determineRepairStatus(
	counts: RepairCounts,
	scannedContentCount: number,
): Exclude<ContentMediaUsageRepairStatus, "stale"> {
	if (counts.failedSourceCount === 0 && counts.skippedSourceCount === 0) return "complete";
	const trustedProgress = counts.indexedSourceCount + counts.deletedSourceCount;
	if (trustedProgress === 0 && scannedContentCount > 0) return "failed";
	return "partial";
}

function buildContentSourceKeys(collectionSlug: string, contentId: string): string[] {
	return MEDIA_USAGE_CONTENT_SOURCE_VARIANTS.map((sourceVariant) =>
		buildContentMediaUsageSourceKey({ collectionSlug, contentId, sourceVariant }),
	);
}

function buildContentSourceKeysForScan(scan: ContentMediaUsageCollectionScan): string[] {
	return scan.contentIds.flatMap((contentId) =>
		buildContentSourceKeys(scan.collectionSlug, contentId),
	);
}

async function contentCollectionExists(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();
	return row !== undefined;
}

function sameContentIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const rightIds = new Set(right);
	return left.every((id) => rightIds.has(id));
}

function contentMediaUsageCollectionScope(collectionSlug: string): ContentMediaUsageRepairScope {
	return {
		adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
		scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
		scopeKey: collectionSlug,
	};
}

function getContentTableName(collectionSlug: string): string {
	validateIdentifier(collectionSlug, "collection slug");
	return `ec_${collectionSlug}`;
}
