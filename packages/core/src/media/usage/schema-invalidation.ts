import type { Kysely } from "kysely";

import { tableExists } from "../../database/dialect-helpers.js";
import { MediaUsageRepository } from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "./types.js";

export const CONTENT_MEDIA_USAGE_ADAPTER_ID = "content-media";
export const CONTENT_MEDIA_USAGE_COLLECTION_SCOPE = "collection";

export async function markContentMediaUsageCollectionStale(
	db: Kysely<Database>,
	collectionSlug: string,
	lastErrorCode: string,
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

export async function invalidateContentMediaUsageSchemaChange(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<boolean> {
	validateIdentifier(collectionSlug, "collection slug");
	if (!(await tableExists(db, "_emdash_media_usage_activation"))) return false;
	const activation = await db
		.selectFrom("_emdash_media_usage_activation")
		.select("state")
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirst();
	if (activation?.state !== "active") return false;

	const invalidated = await new MediaUsageRepository(db).invalidateIndexStatusForSchemaChange(
		collectionSlug,
	);
	if (!invalidated) {
		throw new Error(`Cannot invalidate media usage coverage for collection ${collectionSlug}`);
	}
	return true;
}

export async function markContentMediaUsageCollectionStaleSafely(
	db: Kysely<Database>,
	collectionSlug: string,
	lastErrorCode: string,
): Promise<boolean> {
	try {
		await markContentMediaUsageCollectionStale(db, collectionSlug, lastErrorCode);
		return true;
	} catch (error) {
		console.error(`[media-usage] Failed to mark ${collectionSlug} stale:`, error);
		return false;
	}
}
