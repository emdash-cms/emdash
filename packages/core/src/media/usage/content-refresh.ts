import { sql, type Kysely } from "kysely";

import { MediaUsageRepository } from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { isI18nEnabled } from "../../i18n/config.js";
import { loadContentMediaUsageFields } from "./content-fields.js";
import {
	CONTENT_SOURCE_SCHEMA_VERSION,
	loadContentMediaUsageSnapshots,
} from "./content-snapshots.js";
import {
	buildContentMediaUsageSourceKey,
	MEDIA_USAGE_CONTENT_SOURCE_VARIANTS,
} from "./source-key.js";

export const CONTENT_MEDIA_USAGE_ADAPTER_ID = "content-media";
export const CONTENT_MEDIA_USAGE_COLLECTION_SCOPE = "collection";

const CONTENT_USAGE_LOCKS_KEY = Symbol.for("emdash.mediaUsage.contentLocks");

export type ContentMediaUsageRefreshErrorCode =
	| "CONTENT_NOT_FOUND"
	| "DRAFT_REVISION_NOT_FOUND"
	| "DRAFT_REVISION_MISMATCH"
	| "DRAFT_REVISION_INVALID"
	| "CONTENT_USAGE_REFRESH_ERROR"
	| "CONTENT_USAGE_DELETE_ERROR"
	| "CONTENT_USAGE_STALE";

export interface ContentMediaUsageRefreshResult {
	success: boolean;
	refreshedSourceCount: number;
	deletedSourceCount: number;
	failedSourceCount: number;
	errorCode?: ContentMediaUsageRefreshErrorCode;
}

const ZERO_RESULT: ContentMediaUsageRefreshResult = {
	success: true,
	refreshedSourceCount: 0,
	deletedSourceCount: 0,
	failedSourceCount: 0,
};

export async function refreshContentMediaUsage(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	validateIdentifier(collectionSlug, "collection slug");
	return withContentUsageLock(collectionSlug, contentId, () =>
		refreshContentMediaUsageUnlocked(db, collectionSlug, contentId),
	);
}

async function refreshContentMediaUsageUnlocked(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	try {
		const snapshotsResult = await loadContentMediaUsageSnapshots(db, collectionSlug, contentId);
		if (!snapshotsResult.success) {
			return markSnapshotFailure(db, collectionSlug, snapshotsResult);
		}

		const repo = new MediaUsageRepository(db);
		for (const snapshot of snapshotsResult.snapshots) {
			await repo.replaceSource(snapshot.source, snapshot.occurrences);
		}

		const expectedSourceKeys = new Set(
			snapshotsResult.snapshots.map((snapshot) => snapshot.source.sourceKey),
		);
		const absentSourceKeys = MEDIA_USAGE_CONTENT_SOURCE_VARIANTS.map((sourceVariant) =>
			buildContentMediaUsageSourceKey({ collectionSlug, contentId, sourceVariant }),
		).filter((sourceKey) => !expectedSourceKeys.has(sourceKey));
		const deletedSourceCount = await repo.deleteSources(absentSourceKeys);

		return {
			success: true,
			refreshedSourceCount: snapshotsResult.snapshots.length,
			deletedSourceCount,
			failedSourceCount: 0,
		};
	} catch (error) {
		console.error(`[media-usage] Failed to refresh ${collectionSlug}/${contentId}:`, error);
		await markContentMediaUsageCollectionStaleSafely(
			db,
			collectionSlug,
			"CONTENT_USAGE_REFRESH_ERROR",
		);
		return {
			success: false,
			refreshedSourceCount: 0,
			deletedSourceCount: 0,
			failedSourceCount: 0,
			errorCode: "CONTENT_USAGE_REFRESH_ERROR",
		};
	}
}

export async function deleteContentMediaUsage(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	validateIdentifier(collectionSlug, "collection slug");
	return withContentUsageLock(collectionSlug, contentId, () =>
		deleteContentMediaUsageUnlocked(db, collectionSlug, contentId),
	);
}

async function deleteContentMediaUsageUnlocked(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<ContentMediaUsageRefreshResult> {
	try {
		const deletedSourceCount = await new MediaUsageRepository(db).deleteContentSources(
			collectionSlug,
			contentId,
		);
		return { ...ZERO_RESULT, deletedSourceCount };
	} catch (error) {
		console.error(
			`[media-usage] Failed to delete usage for ${collectionSlug}/${contentId}:`,
			error,
		);
		await markContentMediaUsageCollectionStaleSafely(
			db,
			collectionSlug,
			"CONTENT_USAGE_DELETE_ERROR",
		);
		return {
			success: false,
			refreshedSourceCount: 0,
			deletedSourceCount: 0,
			failedSourceCount: 0,
			errorCode: "CONTENT_USAGE_DELETE_ERROR",
		};
	}
}

export async function refreshContentMediaUsageAfterWrite(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<void> {
	const result = await refreshContentMediaUsage(db, collectionSlug, contentId);
	if (!result.success) {
		console.error(
			`[media-usage] Usage refresh for ${collectionSlug}/${contentId} finished with ${result.errorCode}`,
		);
	}
}

export async function markContentMediaUsageCollectionStale(
	db: Kysely<Database>,
	collectionSlug: string,
	lastErrorCode: ContentMediaUsageRefreshErrorCode | string,
): Promise<void> {
	validateIdentifier(collectionSlug, "collection slug");
	const repo = new MediaUsageRepository(db);
	const identity = {
		adapterId: CONTENT_MEDIA_USAGE_ADAPTER_ID,
		scopeType: CONTENT_MEDIA_USAGE_COLLECTION_SCOPE,
		scopeKey: collectionSlug,
	};
	const existing = await repo.findIndexStatus(identity);
	await repo.upsertIndexStatus({
		...identity,
		status: "stale",
		schemaVersion: existing?.schemaVersion ?? CONTENT_SOURCE_SCHEMA_VERSION,
		startedAt: existing?.startedAt ?? null,
		completedAt: existing?.completedAt ?? null,
		cursor: existing?.cursor ?? null,
		indexedSourceCount: existing?.indexedSourceCount ?? 0,
		failedSourceCount: existing?.failedSourceCount ?? 0,
		lastErrorCode,
	});
}

export async function findNonTranslatableSiblingContentIds(
	db: Kysely<Database>,
	collectionSlug: string,
	updatedContentId: string,
	translationGroup: string | null | undefined,
	updatedData: Record<string, unknown> | undefined,
): Promise<string[]> {
	if (!isI18nEnabled() || !updatedData || !translationGroup) return [];

	validateIdentifier(collectionSlug, "collection slug");
	const collection = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", collectionSlug)
		.executeTakeFirst();
	if (!collection) return [];

	const fields = await db
		.selectFrom("_emdash_fields")
		.select("slug")
		.where("collection_id", "=", collection.id)
		.where("translatable", "=", 0)
		.execute();

	const touchedNonTranslatableSlugs = fields
		.filter((field) => field.slug in updatedData)
		.map((field) => field.slug);
	if (touchedNonTranslatableSlugs.length === 0) return [];

	const usageFields = await loadContentMediaUsageFields(db, collectionSlug);
	const usageRelevantSlugs = new Set([
		...usageFields.extractionFields.map((field) => field.slug),
		...usageFields.displayFieldSlugs,
	]);
	if (!touchedNonTranslatableSlugs.some((slug) => usageRelevantSlugs.has(slug))) return [];

	const tableName = `ec_${collectionSlug}`;
	const rows = await sql<{ id: string }>`
		SELECT id
		FROM ${sql.ref(tableName)}
		WHERE translation_group = ${translationGroup}
		AND id != ${updatedContentId}
		ORDER BY id ASC
	`.execute(db);

	return rows.rows.map((row) => row.id);
}

async function markSnapshotFailure(
	db: Kysely<Database>,
	collectionSlug: string,
	result: Exclude<Awaited<ReturnType<typeof loadContentMediaUsageSnapshots>>, { success: true }>,
): Promise<ContentMediaUsageRefreshResult> {
	const repo = new MediaUsageRepository(db);
	if (result.source) {
		await repo.markSourceAttempted({
			...result.source,
			sourceCompleteness: "failed",
			lastErrorCode: result.error,
		});
	}
	await markContentMediaUsageCollectionStale(db, collectionSlug, result.error);
	return {
		success: false,
		refreshedSourceCount: 0,
		deletedSourceCount: 0,
		failedSourceCount: result.source ? 1 : 0,
		errorCode: result.error,
	};
}

async function markContentMediaUsageCollectionStaleSafely(
	db: Kysely<Database>,
	collectionSlug: string,
	lastErrorCode: ContentMediaUsageRefreshErrorCode,
): Promise<void> {
	try {
		await markContentMediaUsageCollectionStale(db, collectionSlug, lastErrorCode);
	} catch (error) {
		console.error(`[media-usage] Failed to mark ${collectionSlug} stale:`, error);
	}
}

async function withContentUsageLock<T>(
	collectionSlug: string,
	contentId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const locks = getContentUsageLocks();
	const lockKey = `${collectionSlug}\0${contentId}`;
	const previous = locks.get(lockKey) ?? Promise.resolve();
	let releaseCurrent!: () => void;
	const current = new Promise<void>((resolve) => {
		releaseCurrent = resolve;
	});
	const next = previous.catch(() => {}).then(() => current);
	locks.set(lockKey, next);

	try {
		await previous.catch(() => {});
		return await fn();
	} finally {
		releaseCurrent();
		if (locks.get(lockKey) === next) locks.delete(lockKey);
	}
}

function getContentUsageLocks(): Map<string, Promise<void>> {
	const global = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = global[CONTENT_USAGE_LOCKS_KEY];
	if (existing instanceof Map) return existing as Map<string, Promise<void>>;
	const locks = new Map<string, Promise<void>>();
	global[CONTENT_USAGE_LOCKS_KEY] = locks;
	return locks;
}
