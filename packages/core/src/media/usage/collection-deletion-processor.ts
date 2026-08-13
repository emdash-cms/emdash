import { sql, type Kysely, type RawBuilder, type Transaction, type Updateable } from "kysely";

import { isPostgres, tableExists } from "../../database/dialect-helpers.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database, MediaUsageCollectionDeletionTable } from "../../database/types.js";
import {
	collectionDeletionCurrentTimestamp,
	deleteActivatedMediaUsageCollection,
	MediaUsageCollectionDeletionRepository,
	type MediaUsageCollectionDeletionRecord,
} from "./collection-deletion.js";

export const MEDIA_USAGE_COLLECTION_DELETION_LIMITS = Object.freeze({
	candidatesPerTick: 4,
	deletionsPerTick: 1,
	rowsPerBatch: 50,
	leaseDurationSeconds: 5 * 60,
	maxAttempts: 5,
	retryBaseSeconds: 30,
	retryMaxSeconds: 15 * 60,
	maxQueriesPerTick: 30,
});

export interface MediaUsageCollectionDeletionTickResult {
	candidateCount: number;
	claimedCount: number;
	outcome: "idle" | "progress" | "finalized" | "retry" | "failed" | "claim_lost";
}

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

export async function processDueMediaUsageCollectionDeletions(
	db: Kysely<Database>,
): Promise<MediaUsageCollectionDeletionTickResult> {
	const repository = new MediaUsageCollectionDeletionRepository(db);
	const candidates = await repository.findDue(
		MEDIA_USAGE_COLLECTION_DELETION_LIMITS.candidatesPerTick,
	);
	if (candidates.length === 0) return { candidateCount: 0, claimedCount: 0, outcome: "idle" };

	let claim: (MediaUsageCollectionDeletionRecord & { leaseToken: string }) | null = null;
	for (const candidate of candidates) {
		claim = await repository.claim({
			collectionId: candidate.collectionId,
			phase: candidate.phase,
			leaseDurationSeconds: MEDIA_USAGE_COLLECTION_DELETION_LIMITS.leaseDurationSeconds,
		});
		if (claim?.leaseToken) break;
	}
	if (!claim?.leaseToken) {
		return { candidateCount: candidates.length, claimedCount: 0, outcome: "claim_lost" };
	}

	try {
		const processed = await processClaimedDeletion(db, claim);
		if (!processed.finalized && !processed.released && !(await repository.release(claim))) {
			return { candidateCount: candidates.length, claimedCount: 1, outcome: "claim_lost" };
		}
		return {
			candidateCount: candidates.length,
			claimedCount: 1,
			outcome: processed.finalized ? "finalized" : "progress",
		};
	} catch (error) {
		const terminal = claim.attemptCount + 1 >= MEDIA_USAGE_COLLECTION_DELETION_LIMITS.maxAttempts;
		const recorded = await repository.recordFailure({
			collectionId: claim.collectionId,
			leaseToken: claim.leaseToken,
			errorCode: "MEDIA_USAGE_COLLECTION_DELETION_FAILED",
			terminal,
			retryDelaySeconds: retryDelaySeconds(claim.attemptCount),
		});
		if (!recorded) {
			return { candidateCount: candidates.length, claimedCount: 1, outcome: "claim_lost" };
		}
		console.error("[media-usage:collection-deletion] Processing failed:", error);
		return {
			candidateCount: candidates.length,
			claimedCount: 1,
			outcome: terminal ? "failed" : "retry",
		};
	}
}

async function processClaimedDeletion(
	db: Kysely<Database>,
	claim: MediaUsageCollectionDeletionRecord & { leaseToken: string },
): Promise<{ finalized: boolean; released: boolean }> {
	if (claim.phase === "fence" || claim.phase === "registry" || claim.phase === "table") {
		await deleteActivatedMediaUsageCollection(
			db,
			{
				collectionId: claim.collectionId,
				collectionSlug: claim.collectionSlug,
				forceDelete: claim.forceDelete,
			},
			{ frontPhaseLimit: 1, claimed: claim },
		);
		return { finalized: false, released: true };
	}
	if (claim.phase === "work") await processWorkBatch(db, claim);
	if (claim.phase === "sources") await processSourceBatch(db, claim);
	if (claim.phase === "status") await processStatus(db, claim);
	if (claim.phase === "finalize") {
		await finalizeDeletion(db, claim);
		return { finalized: true, released: true };
	}
	return { finalized: false, released: false };
}

async function processWorkBatch(
	db: Kysely<Database>,
	claim: MediaUsageCollectionDeletionRecord & { leaseToken: string },
): Promise<boolean> {
	await withTransaction(db, async (trx) => {
		const rows = await trx
			.selectFrom("_emdash_media_usage_work")
			.select("content_id")
			.where("collection_id", "=", claim.collectionId)
			.$if(claim.workCursor !== null, (query) => query.where("content_id", ">", claim.workCursor!))
			.orderBy("content_id", "asc")
			.limit(MEDIA_USAGE_COLLECTION_DELETION_LIMITS.rowsPerBatch + 1)
			.execute();
		const batch = rows.slice(0, MEDIA_USAGE_COLLECTION_DELETION_LIMITS.rowsPerBatch);
		if (batch.length > 0) {
			await trx
				.deleteFrom("_emdash_media_usage_work")
				.where("collection_id", "=", claim.collectionId)
				.where(
					"content_id",
					"in",
					batch.map((row) => row.content_id),
				)
				.where(liveLeaseGuard(trx, claim))
				.execute();
		}
		await updateDeletion(trx, claim, {
			phase: rows.length > MEDIA_USAGE_COLLECTION_DELETION_LIMITS.rowsPerBatch ? "work" : "sources",
			work_cursor:
				rows.length > MEDIA_USAGE_COLLECTION_DELETION_LIMITS.rowsPerBatch
					? batch.at(-1)!.content_id
					: null,
		});
	});
	return false;
}

async function processSourceBatch(
	db: Kysely<Database>,
	claim: MediaUsageCollectionDeletionRecord & { leaseToken: string },
): Promise<boolean> {
	await withTransaction(db, async (trx) => {
		let sourceKey = claim.sourceKey;
		if (!sourceKey) {
			const source = await trx
				.selectFrom("_emdash_media_usage_sources")
				.select("source_key")
				.where("source_type", "=", "content")
				.where("collection_id", "=", claim.collectionId)
				.orderBy("source_key", "asc")
				.limit(1)
				.executeTakeFirst();
			if (!source) {
				await updateDeletion(trx, claim, {
					phase: "status",
					source_key: null,
					occurrence_cursor: null,
				});
				return;
			}
			sourceKey = source.source_key;
			await updateDeletion(trx, claim, { source_key: sourceKey, occurrence_cursor: null });
		}

		const occurrences = await trx
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("source_key", "=", sourceKey)
			.$if(claim.occurrenceCursor !== null, (query) =>
				query.where("id", ">", claim.occurrenceCursor!),
			)
			.orderBy("id", "asc")
			.limit(MEDIA_USAGE_COLLECTION_DELETION_LIMITS.rowsPerBatch + 1)
			.execute();
		const batch = occurrences.slice(0, MEDIA_USAGE_COLLECTION_DELETION_LIMITS.rowsPerBatch);
		if (batch.length > 0) {
			await trx
				.deleteFrom("_emdash_media_usage")
				.where("source_key", "=", sourceKey)
				.where(
					"id",
					"in",
					batch.map((row) => row.id),
				)
				.where(liveLeaseGuard(trx, claim))
				.execute();
		}
		if (occurrences.length > MEDIA_USAGE_COLLECTION_DELETION_LIMITS.rowsPerBatch) {
			await updateDeletion(trx, claim, {
				source_key: sourceKey,
				occurrence_cursor: batch.at(-1)!.id,
			});
			return;
		}
		await trx
			.deleteFrom("_emdash_media_usage_sources")
			.where("source_key", "=", sourceKey)
			.where("source_type", "=", "content")
			.where("collection_id", "=", claim.collectionId)
			.where(liveLeaseGuard(trx, claim))
			.execute();
		await updateDeletion(trx, claim, { source_key: null, occurrence_cursor: null });
	});
	return false;
}

async function processStatus(
	db: Kysely<Database>,
	claim: MediaUsageCollectionDeletionRecord & { leaseToken: string },
): Promise<boolean> {
	await withTransaction(db, async (trx) => {
		if (await exactCleanupRowsRemain(trx, claim, false)) {
			throw new Error("Collection deletion cleanup is incomplete");
		}
		await trx
			.deleteFrom("_emdash_media_usage_reconciliations")
			.where("collection_id", "=", claim.collectionId)
			.where("collection_slug", "=", claim.collectionSlug)
			.where(liveLeaseGuard(trx, claim))
			.execute();
		await trx
			.deleteFrom("_emdash_media_usage_index_status")
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", claim.collectionSlug)
			.where("collection_id", "=", claim.collectionId)
			.where(liveLeaseGuard(trx, claim))
			.execute();
		await updateDeletion(trx, claim, { phase: "finalize" });
	});
	return false;
}

async function finalizeDeletion(
	db: Kysely<Database>,
	claim: MediaUsageCollectionDeletionRecord & { leaseToken: string },
): Promise<boolean> {
	if (await tableExists(db, `ec_${claim.collectionSlug}`)) {
		throw new Error("Collection table still exists during deletion finalization");
	}
	if (await exactCleanupRowsRemain(db, claim)) throw new Error("Collection deletion is incomplete");
	const registry = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("id", "=", claim.collectionId)
		.where("slug", "=", claim.collectionSlug)
		.executeTakeFirst();
	if (registry) throw new Error("Collection registry identity still exists");
	const result = await db
		.deleteFrom("_emdash_media_usage_collection_deletions")
		.where("collection_id", "=", claim.collectionId)
		.where("collection_slug", "=", claim.collectionSlug)
		.where("state", "=", "leased")
		.where("phase", "=", "finalize")
		.where("lease_token", "=", claim.leaseToken)
		.where(liveLeaseGuard(db, claim))
		.executeTakeFirst();
	if (Number(result.numDeletedRows ?? 0) !== 1)
		throw new Error("Collection deletion lost finalization");
	return true;
}

async function exactCleanupRowsRemain(
	db: DatabaseExecutor,
	claim: Pick<MediaUsageCollectionDeletionRecord, "collectionId" | "collectionSlug">,
	includeStatus = true,
): Promise<boolean> {
	const result = await sql<{
		work_present: boolean | number;
		source_present: boolean | number;
		status_present: boolean | number;
	}>`
		SELECT
			EXISTS (
				SELECT 1 FROM _emdash_media_usage_work
				WHERE collection_id = ${claim.collectionId}
			) AS work_present,
			EXISTS (
				SELECT 1 FROM _emdash_media_usage_sources
				WHERE source_type = 'content' AND collection_id = ${claim.collectionId}
			) AS source_present,
			EXISTS (
				SELECT 1 FROM _emdash_media_usage_index_status
				WHERE adapter_id = 'content-media'
					AND scope_type = 'collection'
					AND scope_key = ${claim.collectionSlug}
					AND collection_id = ${claim.collectionId}
			) AS status_present
	`.execute(db);
	const row = result.rows[0];
	return (
		Boolean(row?.work_present) ||
		Boolean(row?.source_present) ||
		(includeStatus && Boolean(row?.status_present))
	);
}

async function updateDeletion(
	db: DatabaseExecutor,
	claim: MediaUsageCollectionDeletionRecord & { leaseToken: string },
	values: Updateable<MediaUsageCollectionDeletionTable>,
): Promise<void> {
	const result = await db
		.updateTable("_emdash_media_usage_collection_deletions")
		.set({
			...values,
			attempt_count: 0,
			last_error_code: null,
			updated_at: collectionDeletionCurrentTimestamp(db),
		})
		.where("collection_id", "=", claim.collectionId)
		.where("state", "=", "leased")
		.where("lease_token", "=", claim.leaseToken)
		.where(liveLeaseGuard(db, claim))
		.executeTakeFirst();
	if (Number(result.numUpdatedRows ?? 0) !== 1)
		throw new Error("Collection deletion lease was lost");
}

function liveLeaseGuard(
	db: DatabaseExecutor,
	claim: Pick<MediaUsageCollectionDeletionRecord, "collectionId"> & { leaseToken: string },
): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`EXISTS (
			SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion
			WHERE deletion.collection_id = ${claim.collectionId}
				AND deletion.state = 'leased'
				AND deletion.lease_token = ${claim.leaseToken}
				AND deletion.lease_expires_at::timestamptz > clock_timestamp()
		)`
		: sql<boolean>`EXISTS (
			SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion
			WHERE deletion.collection_id = ${claim.collectionId}
				AND deletion.state = 'leased'
				AND deletion.lease_token = ${claim.leaseToken}
				AND deletion.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		)`;
}

function retryDelaySeconds(attemptCount: number): number {
	return Math.min(
		MEDIA_USAGE_COLLECTION_DELETION_LIMITS.retryMaxSeconds,
		MEDIA_USAGE_COLLECTION_DELETION_LIMITS.retryBaseSeconds * 2 ** attemptCount,
	);
}
