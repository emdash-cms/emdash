import { sql, type Kysely, type RawBuilder, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { isPostgres, tableExists } from "../../database/dialect-helpers.js";
import type { Database, MediaUsageIndexStatusTable } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";

const ADAPTER_ID = "content-media";
const SCOPE_TYPE = "collection";
const CLEANUP_ERROR_CODE = "MEDIA_USAGE_DELETION_CLEANUP_FAILED";
const CLEANUP_NOT_READY_ERROR_CODE = "MEDIA_USAGE_DELETION_NOT_READY";

export const MEDIA_USAGE_DELETION_CLEANUP_LIMITS = Object.freeze({
	candidatesPerTick: 4,
	workRowsPerBatch: 10,
	occurrenceRowsPerBatch: 10,
	leaseDurationSeconds: 60,
	maxAttempts: 5,
	retryBaseSeconds: 30,
	retryMaxSeconds: 15 * 60,
	retryJitterRatio: 0.25,
});

type CleanupPhase = "work" | "sources" | "status";
type DueCleanupState = "pending" | "retry" | "leased";

interface CleanupRecord {
	collectionId: string;
	collectionSlug: string;
	state: DueCleanupState;
	phase: string | null;
	workCursor: string | null;
	sourceKey: string | null;
	occurrenceCursor: string | null;
	attemptCount: number;
	updatedAt: string;
	nextAttemptAt: string | null;
	leaseExpiresAt: string | null;
}

interface CleanupLease extends CleanupRecord {
	leaseToken: string;
}

export interface MediaUsageDeletionCleanupTickResult {
	outcome: "idle" | "progress" | "complete" | "retry" | "failed" | "conflict";
	candidateCount: number;
	claimed: boolean;
	phase: CleanupPhase | null;
	rowsDeleted: number;
}

class CleanupProcessingError extends Error {
	readonly errorCode: string;

	constructor(errorCode: string) {
		super(errorCode);
		this.errorCode = errorCode;
	}
}

export async function processDueMediaUsageDeletionCleanup(
	db: Kysely<Database>,
): Promise<MediaUsageDeletionCleanupTickResult> {
	const repo = new MediaUsageDeletionCleanupRepository(db);
	const candidates = await repo.findDueCleanup(
		MEDIA_USAGE_DELETION_CLEANUP_LIMITS.candidatesPerTick,
	);
	if (candidates.length === 0) return cleanupResult("idle", 0, false, null, 0);

	for (const candidate of candidates) {
		const claim = await repo.claimCleanup(
			candidate,
			MEDIA_USAGE_DELETION_CLEANUP_LIMITS.leaseDurationSeconds,
		);
		if (!claim) continue;

		const phase = cleanupPhase(claim.phase);
		try {
			await assertCleanupReady(db, claim);
			if (!phase) throw new CleanupProcessingError(CLEANUP_ERROR_CODE);

			switch (phase) {
				case "work":
					return await processWorkPhase(repo, claim, candidates.length);
				case "sources":
					return await processSourcesPhase(repo, claim, candidates.length);
				case "status":
					return await processStatusPhase(repo, claim, candidates.length);
			}
		} catch (error) {
			const errorCode =
				error instanceof CleanupProcessingError ? error.errorCode : CLEANUP_ERROR_CODE;
			try {
				const failure = await repo.recordFailure(
					claim,
					errorCode,
					MEDIA_USAGE_DELETION_CLEANUP_LIMITS,
				);
				if (failure) {
					return cleanupResult(failure, candidates.length, true, phase, 0);
				}
			} catch {
				return cleanupResult("conflict", candidates.length, true, phase, 0);
			}
			return cleanupResult("conflict", candidates.length, true, phase, 0);
		}
	}

	return cleanupResult("conflict", candidates.length, false, null, 0);
}

async function assertCleanupReady(db: Kysely<Database>, claim: CleanupLease): Promise<void> {
	validateIdentifier(claim.collectionSlug, "collection slug");
	const registered = await db
		.selectFrom("_emdash_collections")
		.select("id")
		.where("slug", "=", claim.collectionSlug)
		.executeTakeFirst();
	if (registered) throw new CleanupProcessingError(CLEANUP_NOT_READY_ERROR_CODE);

	const tableName = `ec_${claim.collectionSlug}`;
	validateIdentifier(tableName, "content table");
	if (await tableExists(db, tableName)) {
		throw new CleanupProcessingError(CLEANUP_NOT_READY_ERROR_CODE);
	}
}

async function processWorkPhase(
	repo: MediaUsageDeletionCleanupRepository,
	claim: CleanupLease,
	candidateCount: number,
): Promise<MediaUsageDeletionCleanupTickResult> {
	const contentIds = await repo.findWorkContentIds(
		claim,
		MEDIA_USAGE_DELETION_CLEANUP_LIMITS.workRowsPerBatch,
	);
	if (contentIds.length === 0) {
		const advanced = await repo.releaseWithCheckpoint(claim, {
			phase: "sources",
			workCursor: claim.workCursor,
			sourceKey: null,
			occurrenceCursor: null,
		});
		return cleanupResult(advanced ? "progress" : "conflict", candidateCount, true, "work", 0);
	}

	const rowsDeleted = await repo.deleteWorkContentIds(claim, contentIds);
	const advanced = await repo.releaseWithCheckpoint(claim, {
		phase: "work",
		workCursor: contentIds.at(-1)!,
		sourceKey: claim.sourceKey,
		occurrenceCursor: claim.occurrenceCursor,
	});
	return cleanupResult(
		advanced ? "progress" : "conflict",
		candidateCount,
		true,
		"work",
		rowsDeleted,
	);
}

async function processSourcesPhase(
	repo: MediaUsageDeletionCleanupRepository,
	claim: CleanupLease,
	candidateCount: number,
): Promise<MediaUsageDeletionCleanupTickResult> {
	if (claim.occurrenceCursor !== null && claim.sourceKey === null) {
		throw new CleanupProcessingError(CLEANUP_ERROR_CODE);
	}

	const sourceKey =
		claim.sourceKey !== null && claim.occurrenceCursor !== null
			? claim.sourceKey
			: await repo.findCleanupSourceKey(claim);
	if (!sourceKey) {
		const advanced = await repo.releaseWithCheckpoint(claim, {
			phase: "status",
			workCursor: claim.workCursor,
			sourceKey: claim.sourceKey,
			occurrenceCursor: null,
		});
		return cleanupResult(advanced ? "progress" : "conflict", candidateCount, true, "sources", 0);
	}

	const occurrenceIds = await repo.findOccurrenceIds(
		claim,
		sourceKey,
		MEDIA_USAGE_DELETION_CLEANUP_LIMITS.occurrenceRowsPerBatch,
	);
	if (occurrenceIds.length > 0) {
		const rowsDeleted = await repo.deleteOccurrenceIds(claim, sourceKey, occurrenceIds);
		const advanced = await repo.releaseWithCheckpoint(claim, {
			phase: "sources",
			workCursor: claim.workCursor,
			sourceKey,
			occurrenceCursor: occurrenceIds.at(-1)!,
		});
		return cleanupResult(
			advanced ? "progress" : "conflict",
			candidateCount,
			true,
			"sources",
			rowsDeleted,
		);
	}

	const rowsDeleted = await repo.deleteDrainedSource(claim, sourceKey);
	if (rowsDeleted === 0 && (await repo.boundSourceExists(claim, sourceKey))) {
		throw new CleanupProcessingError(CLEANUP_NOT_READY_ERROR_CODE);
	}
	const advanced = await repo.releaseWithCheckpoint(claim, {
		phase: "sources",
		workCursor: claim.workCursor,
		sourceKey,
		occurrenceCursor: null,
	});
	return cleanupResult(
		advanced ? "progress" : "conflict",
		candidateCount,
		true,
		"sources",
		rowsDeleted,
	);
}

async function processStatusPhase(
	repo: MediaUsageDeletionCleanupRepository,
	claim: CleanupLease,
	candidateCount: number,
): Promise<MediaUsageDeletionCleanupTickResult> {
	if (await repo.deleteCompletedStatus(claim)) {
		return cleanupResult("complete", candidateCount, true, "status", 1);
	}
	if (await repo.leaseIsLive(claim)) {
		throw new CleanupProcessingError(CLEANUP_NOT_READY_ERROR_CODE);
	}
	return cleanupResult("conflict", candidateCount, true, "status", 0);
}

function cleanupResult(
	outcome: MediaUsageDeletionCleanupTickResult["outcome"],
	candidateCount: number,
	claimed: boolean,
	phase: CleanupPhase | null,
	rowsDeleted: number,
): MediaUsageDeletionCleanupTickResult {
	return { outcome, candidateCount, claimed, phase, rowsDeleted };
}

function cleanupPhase(value: string | null): CleanupPhase | null {
	return value === "work" || value === "sources" || value === "status" ? value : null;
}

class MediaUsageDeletionCleanupRepository {
	constructor(private db: Kysely<Database>) {}

	async findDueCleanup(limit: number): Promise<CleanupRecord[]> {
		const pending = await this.findDueRows("pending", "cleanup_next_attempt_at", limit);
		const retry = await this.findDueRows("retry", "cleanup_next_attempt_at", limit);
		const leased = await this.findDueRows("leased", "cleanup_lease_expires_at", limit);
		return [...pending, ...retry, ...leased]
			.map(rowToCleanupRecord)
			.toSorted(compareCleanupRecords)
			.slice(0, limit);
	}

	private findDueRows(
		state: DueCleanupState,
		timestampColumn: "cleanup_next_attempt_at" | "cleanup_lease_expires_at",
		limit: number,
	): Promise<Selectable<MediaUsageIndexStatusTable>[]> {
		return this.db
			.selectFrom("_emdash_media_usage_index_status")
			.selectAll()
			.where("adapter_id", "=", ADAPTER_ID)
			.where("scope_type", "=", SCOPE_TYPE)
			.where("capture_state", "=", "deleting")
			.where("collection_id", "is not", null)
			.where("cleanup_state", "=", state)
			.where(timestampColumn, "is not", null)
			.where(timestampIsDue(this.db, timestampColumn))
			.orderBy(timestampColumn, "asc")
			.orderBy("updated_at", "asc")
			.orderBy("collection_id", "asc")
			.limit(limit)
			.execute();
	}

	async claimCleanup(
		candidate: CleanupRecord,
		leaseDurationSeconds: number,
	): Promise<CleanupLease | null> {
		const leaseToken = ulid();
		const now = timestampOffset(this.db, 0);
		let query = this.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				cleanup_state: "leased",
				cleanup_lease_token: leaseToken,
				cleanup_lease_expires_at: timestampOffset(this.db, leaseDurationSeconds),
				updated_at: now,
			})
			.where("adapter_id", "=", ADAPTER_ID)
			.where("scope_type", "=", SCOPE_TYPE)
			.where("scope_key", "=", candidate.collectionSlug)
			.where("collection_id", "=", candidate.collectionId)
			.where("capture_state", "=", "deleting")
			.where("cleanup_state", "=", candidate.state)
			.where("cleanup_attempt_count", "=", candidate.attemptCount)
			.where("updated_at", "=", candidate.updatedAt)
			.where(nullableEquals("cleanup_phase", candidate.phase))
			.where(nullableEquals("cleanup_work_cursor", candidate.workCursor))
			.where(nullableEquals("cleanup_source_key", candidate.sourceKey))
			.where(nullableEquals("cleanup_occurrence_cursor", candidate.occurrenceCursor));
		if (candidate.state === "leased") {
			query = query
				.where("cleanup_lease_expires_at", "is not", null)
				.where(timestampIsDue(this.db, "cleanup_lease_expires_at"));
		} else {
			query = query
				.where("cleanup_next_attempt_at", "is not", null)
				.where(timestampIsDue(this.db, "cleanup_next_attempt_at"));
		}
		const row = await query.returningAll().executeTakeFirst();
		return row ? { ...rowToCleanupRecord(row), leaseToken } : null;
	}

	async findWorkContentIds(claim: CleanupLease, limit: number): Promise<string[]> {
		let query = this.db
			.selectFrom("_emdash_media_usage_work")
			.select("content_id")
			.where("collection_id", "=", claim.collectionId)
			.where(activeCleanupLease(this.db, claim));
		if (claim.workCursor) query = query.where("content_id", ">", claim.workCursor);
		const rows = await query.orderBy("content_id", "asc").limit(limit).execute();
		return rows.map((row) => row.content_id);
	}

	async deleteWorkContentIds(claim: CleanupLease, contentIds: readonly string[]): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage_work")
			.where("collection_id", "=", claim.collectionId)
			.where("content_id", "in", contentIds)
			.where(activeCleanupLease(this.db, claim))
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	async findCleanupSourceKey(claim: CleanupLease): Promise<string | null> {
		let query = this.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("source_type", "=", "content")
			.where("collection_id", "=", claim.collectionId)
			.where(activeCleanupLease(this.db, claim));
		if (claim.sourceKey !== null) {
			query = query.where("source_key", ">", claim.sourceKey);
		}
		const row = await query.orderBy("source_key", "asc").limit(1).executeTakeFirst();
		return row?.source_key ?? null;
	}

	async findOccurrenceIds(
		claim: CleanupLease,
		sourceKey: string,
		limit: number,
	): Promise<string[]> {
		let query = this.db
			.selectFrom("_emdash_media_usage")
			.select("id")
			.where("source_key", "=", sourceKey)
			.where(cleanupSourceIsExactOrAbsent(claim, sourceKey))
			.where(activeCleanupLease(this.db, claim));
		if (claim.sourceKey === sourceKey && claim.occurrenceCursor !== null) {
			query = query.where("id", ">", claim.occurrenceCursor);
		}
		const rows = await query.orderBy("id", "asc").limit(limit).execute();
		return rows.map((row) => row.id);
	}

	async deleteOccurrenceIds(
		claim: CleanupLease,
		sourceKey: string,
		occurrenceIds: readonly string[],
	): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage")
			.where("source_key", "=", sourceKey)
			.where("id", "in", occurrenceIds)
			.where(cleanupSourceIsExactOrAbsent(claim, sourceKey))
			.where(activeCleanupLease(this.db, claim))
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	async deleteDrainedSource(claim: CleanupLease, sourceKey: string): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage_sources")
			.where("source_key", "=", sourceKey)
			.where("source_type", "=", "content")
			.where("collection_id", "=", claim.collectionId)
			.where(
				sql<boolean>`NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage AS occurrence
					WHERE occurrence.source_key = ${sourceKey}
				)`,
			)
			.where(activeCleanupLease(this.db, claim))
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	async boundSourceExists(claim: CleanupLease, sourceKey: string): Promise<boolean> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("source_key", "=", sourceKey)
			.where("source_type", "=", "content")
			.where("collection_id", "=", claim.collectionId)
			.where(activeCleanupLease(this.db, claim))
			.executeTakeFirst();
		return row !== undefined;
	}

	async releaseWithCheckpoint(
		claim: CleanupLease,
		next: {
			phase: CleanupPhase;
			workCursor: string | null;
			sourceKey: string | null;
			occurrenceCursor: string | null;
		},
	): Promise<boolean> {
		const now = timestampOffset(this.db, 0);
		const result = await this.claimUpdate(claim)
			.set({
				cleanup_state: "pending",
				cleanup_phase: next.phase,
				cleanup_work_cursor: next.workCursor,
				cleanup_source_key: next.sourceKey,
				cleanup_occurrence_cursor: next.occurrenceCursor,
				cleanup_lease_token: null,
				cleanup_lease_expires_at: null,
				cleanup_attempt_count: 0,
				cleanup_next_attempt_at: now,
				cleanup_last_error_code: null,
				updated_at: now,
			})
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	async recordFailure(
		claim: CleanupLease,
		errorCode: string,
		limits: typeof MEDIA_USAGE_DELETION_CLEANUP_LIMITS,
	): Promise<"retry" | "failed" | null> {
		const attemptCount = claim.attemptCount + 1;
		const failed = attemptCount >= limits.maxAttempts;
		const result = await this.claimUpdate(claim)
			.set({
				cleanup_state: failed ? "failed" : "retry",
				cleanup_lease_token: null,
				cleanup_lease_expires_at: null,
				cleanup_attempt_count: attemptCount,
				cleanup_next_attempt_at: failed
					? null
					: timestampOffset(
							this.db,
							retryDelaySeconds(
								claim.attemptCount,
								limits.retryBaseSeconds,
								limits.retryMaxSeconds,
								limits.retryJitterRatio,
							),
						),
				cleanup_last_error_code: errorCode,
				updated_at: timestampOffset(this.db, 0),
			})
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0 ? (failed ? "failed" : "retry") : null;
	}

	async deleteCompletedStatus(claim: CleanupLease): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage_index_status")
			.where("adapter_id", "=", ADAPTER_ID)
			.where("scope_type", "=", SCOPE_TYPE)
			.where("scope_key", "=", claim.collectionSlug)
			.where("collection_id", "=", claim.collectionId)
			.where("capture_state", "=", "deleting")
			.where("cleanup_state", "=", "leased")
			.where("cleanup_phase", "=", "status")
			.where("cleanup_lease_token", "=", claim.leaseToken)
			.where(leaseIsLive(this.db))
			.where(
				sql<boolean>`NOT EXISTS (
					SELECT 1 FROM _emdash_collections AS collection
					WHERE collection.slug = ${claim.collectionSlug}
				)`,
			)
			.where(
				sql<boolean>`NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage_work AS work
					WHERE work.collection_id = ${claim.collectionId}
				)`,
			)
			.where(
				sql<boolean>`NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage_sources AS source
					WHERE source.collection_id = ${claim.collectionId}
				)`,
			)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0) > 0;
	}

	async leaseIsLive(claim: CleanupLease): Promise<boolean> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("collection_id")
			.where("adapter_id", "=", ADAPTER_ID)
			.where("scope_type", "=", SCOPE_TYPE)
			.where("collection_id", "=", claim.collectionId)
			.where("capture_state", "=", "deleting")
			.where("cleanup_state", "=", "leased")
			.where("cleanup_lease_token", "=", claim.leaseToken)
			.where(leaseIsLive(this.db))
			.executeTakeFirst();
		return row !== undefined;
	}

	private claimUpdate(claim: CleanupLease) {
		return this.db
			.updateTable("_emdash_media_usage_index_status")
			.where("adapter_id", "=", ADAPTER_ID)
			.where("scope_type", "=", SCOPE_TYPE)
			.where("scope_key", "=", claim.collectionSlug)
			.where("collection_id", "=", claim.collectionId)
			.where("capture_state", "=", "deleting")
			.where("cleanup_state", "=", "leased")
			.where("cleanup_lease_token", "=", claim.leaseToken)
			.where(nullableEquals("cleanup_phase", claim.phase))
			.where(nullableEquals("cleanup_work_cursor", claim.workCursor))
			.where(nullableEquals("cleanup_source_key", claim.sourceKey))
			.where(nullableEquals("cleanup_occurrence_cursor", claim.occurrenceCursor))
			.where(leaseIsLive(this.db));
	}
}

function rowToCleanupRecord(row: Selectable<MediaUsageIndexStatusTable>): CleanupRecord {
	if (!row.collection_id || !isDueCleanupState(row.cleanup_state)) {
		throw new Error("Media usage deletion cleanup record has invalid identity or state");
	}
	return {
		collectionId: row.collection_id,
		collectionSlug: row.scope_key,
		state: row.cleanup_state,
		phase: row.cleanup_phase,
		workCursor: row.cleanup_work_cursor,
		sourceKey: row.cleanup_source_key,
		occurrenceCursor: row.cleanup_occurrence_cursor,
		attemptCount: row.cleanup_attempt_count,
		updatedAt: row.updated_at,
		nextAttemptAt: row.cleanup_next_attempt_at,
		leaseExpiresAt: row.cleanup_lease_expires_at,
	};
}

function isDueCleanupState(value: string | null): value is DueCleanupState {
	return value === "pending" || value === "retry" || value === "leased";
}

function compareCleanupRecords(a: CleanupRecord, b: CleanupRecord): number {
	const aDue = a.state === "leased" ? a.leaseExpiresAt : a.nextAttemptAt;
	const bDue = b.state === "leased" ? b.leaseExpiresAt : b.nextAttemptAt;
	return (
		(aDue ?? "").localeCompare(bDue ?? "") ||
		a.updatedAt.localeCompare(b.updatedAt) ||
		a.collectionId.localeCompare(b.collectionId)
	);
}

function nullableEquals(column: string, value: string | null): RawBuilder<boolean> {
	return value === null
		? sql<boolean>`${sql.ref(column)} IS NULL`
		: sql<boolean>`${sql.ref(column)} = ${value}`;
}

function activeCleanupLease(db: Kysely<Database>, claim: CleanupLease): RawBuilder<boolean> {
	return sql<boolean>`EXISTS (
		SELECT 1
		FROM _emdash_media_usage_index_status AS cleanup
		WHERE cleanup.adapter_id = ${ADAPTER_ID}
			AND cleanup.scope_type = ${SCOPE_TYPE}
			AND cleanup.scope_key = ${claim.collectionSlug}
			AND cleanup.collection_id = ${claim.collectionId}
			AND cleanup.capture_state = 'deleting'
			AND cleanup.cleanup_state = 'leased'
			AND cleanup.cleanup_lease_token = ${claim.leaseToken}
			AND cleanup.cleanup_lease_expires_at IS NOT NULL
			AND ${isPostgres(db) ? sql`cleanup.cleanup_lease_expires_at::timestamptz > clock_timestamp()` : sql`cleanup.cleanup_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`}
	)`;
}

function cleanupSourceIsExactOrAbsent(claim: CleanupLease, sourceKey: string): RawBuilder<boolean> {
	return sql<boolean>`(
		EXISTS (
			SELECT 1 FROM _emdash_media_usage_sources AS source
			WHERE source.source_key = ${sourceKey}
				AND source.source_type = 'content'
				AND source.collection_id = ${claim.collectionId}
		)
		OR NOT EXISTS (
			SELECT 1 FROM _emdash_media_usage_sources AS source
			WHERE source.source_key = ${sourceKey}
		)
	)`;
}

function leaseIsLive(db: Kysely<Database>): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`cleanup_lease_expires_at::timestamptz > clock_timestamp()`
		: sql<boolean>`cleanup_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampIsDue(db: Kysely<Database>, column: string): RawBuilder<boolean> {
	return isPostgres(db)
		? sql<boolean>`${sql.ref(column)}::timestamptz <= clock_timestamp()`
		: sql<boolean>`${sql.ref(column)} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampOffset(db: Kysely<Database>, seconds: number): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql<string>`to_char(
			clock_timestamp() AT TIME ZONE 'UTC' + (${seconds} * interval '1 second'),
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		)`;
	}
	return sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`+${seconds} seconds`})`;
}

function retryDelaySeconds(
	attemptCount: number,
	base: number,
	maximum: number,
	jitterRatio: number,
): number {
	const exponential = Math.min(maximum, base * 2 ** attemptCount);
	const jitter = Math.floor(exponential * jitterRatio * Math.random());
	return Math.min(maximum, exponential + jitter);
}
