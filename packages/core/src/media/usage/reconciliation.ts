import { sql, type Kysely, type RawBuilder, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database, MediaUsageReconciliationTable } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";

const ACTIVATION_KEY = "incremental_capture";
const CONTENT_ADAPTER_ID = "content-media";
const COLLECTION_SCOPE = "collection";
const MAX_CANDIDATES = 100;
const MAX_PORTABLE_DURATION_SECONDS = 365 * 24 * 60 * 60;
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export type MediaUsageReconciliationState = "pending" | "retry" | "leased" | "failed";
export type MediaUsageReconciliationPhase = "scan" | "sources";

export interface MediaUsageReconciliationRecord {
	collectionId: string;
	collectionSlug: string;
	runToken: string;
	targetEpoch: number | string | null;
	fieldFingerprint: string | null;
	state: MediaUsageReconciliationState;
	phase: MediaUsageReconciliationPhase;
	scanCursor: string | null;
	scanUpperId: string | null;
	sourceCursor: string | null;
	sourceUpperKey: string | null;
	attemptCount: number;
	nextAttemptAt: string;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	lastErrorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MediaUsageReconciliationClaim extends MediaUsageReconciliationRecord {
	leaseToken: string;
}

export interface MediaUsageReconciliationSourceCandidate {
	sourceKey: string;
	contentId: string | null;
	sourceVariant: string;
}

export type MediaUsageReconciliationWorkBarrier =
	| { state: "empty" }
	| { state: "pending" }
	| { state: "failed"; errorCode: string };

export class MediaUsageReconciliationRepository {
	constructor(private db: Kysely<Database>) {}

	async findByIdentity(
		collectionId: string,
		runToken: string,
	): Promise<MediaUsageReconciliationRecord | null> {
		assertIdentity({ collectionId, runToken });
		const row = await this.db
			.selectFrom("_emdash_media_usage_reconciliations")
			.selectAll()
			.where("collection_id", "=", collectionId)
			.where("run_token", "=", runToken)
			.executeTakeFirst();
		return row ? rowToRecord(row) : null;
	}

	async beginRun(claim: MediaUsageReconciliationClaim): Promise<number | string | null> {
		const now = timestampOffset(this.db, 0);
		const sameRun = sql<boolean>`status = 'running' AND cursor = ${claim.runToken}`;
		const row = await this.db
			.updateTable("_emdash_media_usage_index_status as status")
			.set({
				status: "running",
				started_at: sql<string | null>`CASE WHEN ${sameRun} THEN started_at ELSE ${now} END`,
				completed_at: null,
				cursor: claim.runToken,
				indexed_source_count: 0,
				failed_source_count: 0,
				last_error_code: null,
				change_epoch: sql<number>`CASE WHEN ${sameRun} THEN change_epoch ELSE change_epoch + 1 END`,
				reconciliation_required: 1,
				updated_at: now,
			})
			.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
			.where("status.scope_type", "=", COLLECTION_SCOPE)
			.where("status.collection_id", "=", claim.collectionId)
			.where("status.scope_key", "=", claim.collectionSlug)
			.where("status.capture_state", "=", "active")
			.where("status.reconciliation_required", "=", 1)
			.where((eb) =>
				eb.or([eb("status.status", "!=", "running"), eb("status.cursor", "=", claim.runToken)]),
			)
			.where(this.liveClaimExists(claim))
			.returning("change_epoch")
			.executeTakeFirst();
		return row?.change_epoch ?? null;
	}

	async findScanUpperId(claim: MediaUsageReconciliationClaim): Promise<string | null> {
		const tableName = contentTableName(claim.collectionSlug);
		const result = await sql<{ id: string }>`
			SELECT content.id
			FROM ${sql.ref(tableName)} AS content
			WHERE ${this.liveClaimExistsSql(claim)}
			ORDER BY content.id DESC
			LIMIT 1
		`.execute(this.db);
		return result.rows[0]?.id ?? null;
	}

	async initializeScan(input: {
		claim: MediaUsageReconciliationClaim;
		targetEpoch: number | string;
		fieldFingerprint: string;
		scanUpperId: string | null;
	}): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				target_epoch: input.targetEpoch,
				field_fingerprint: input.fieldFingerprint,
				phase: "scan",
				scan_cursor: null,
				scan_upper_id: input.scanUpperId,
				source_cursor: null,
				source_upper_key: null,
				attempt_count: 0,
				last_error_code: null,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", input.claim.collectionId)
			.where("reconciliation.run_token", "=", input.claim.runToken)
			.where("reconciliation.target_epoch", "is", null)
			.where("reconciliation.state", "=", "leased")
			.where("reconciliation.lease_token", "=", input.claim.leaseToken)
			.where(liveLease(this.db))
			.where(this.statusOwnsRun(input.claim, input.targetEpoch))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async findScanPage(
		reconciliation: MediaUsageReconciliationRecord,
		limit: number,
	): Promise<string[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
			throw new Error("Reconciliation scan page limit must be from 1 to 50");
		}
		if (!reconciliation.leaseToken || reconciliation.targetEpoch === null) return [];
		const tableName = contentTableName(reconciliation.collectionSlug);
		const lowerBound = reconciliation.scanCursor
			? sql`AND content.id > ${reconciliation.scanCursor}`
			: sql``;
		const upperBound = reconciliation.scanUpperId
			? sql`AND content.id <= ${reconciliation.scanUpperId}`
			: sql`AND 1 = 0`;
		const result = await sql<{ id: string }>`
			SELECT content.id
			FROM ${sql.ref(tableName)} AS content
			WHERE 1 = 1
				${lowerBound}
				${upperBound}
				AND ${this.liveClaimExistsSql(reconciliation)}
			ORDER BY content.id ASC
			LIMIT ${limit}
		`.execute(this.db);
		return result.rows.map((row) => row.id);
	}

	async checkpointScan(input: {
		claim: MediaUsageReconciliationClaim;
		targetEpoch: number | string;
		previousCursor: string | null;
		nextCursor: string;
	}): Promise<boolean> {
		let query = this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				scan_cursor: input.nextCursor,
				attempt_count: 0,
				last_error_code: null,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", input.claim.collectionId)
			.where("reconciliation.run_token", "=", input.claim.runToken)
			.where("reconciliation.target_epoch", "=", input.targetEpoch)
			.where("reconciliation.state", "=", "leased")
			.where("reconciliation.phase", "=", "scan")
			.where("reconciliation.lease_token", "=", input.claim.leaseToken)
			.where(liveLease(this.db))
			.where(this.statusOwnsRun(input.claim, input.targetEpoch));
		query = input.previousCursor
			? query.where("reconciliation.scan_cursor", "=", input.previousCursor)
			: query.where("reconciliation.scan_cursor", "is", null);
		const result = await query.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async ownsRun(
		claim: MediaUsageReconciliationClaim,
		targetEpoch: number | string,
	): Promise<boolean> {
		const result = await sql<{ owned: boolean | number }>`
			SELECT ${this.statusOwnsRun(claim, targetEpoch)} AS owned
		`.execute(this.db);
		return Boolean(result.rows[0]?.owned);
	}

	async restartRun(
		claim: MediaUsageReconciliationClaim,
		previousEpoch: number | string,
	): Promise<number | string | null> {
		const now = timestampOffset(this.db, 0);
		const interruptedRestart = sql<boolean>`status = 'running'
			AND cursor = ${claim.runToken}
			AND change_epoch > ${previousEpoch}`;
		const row = await this.db
			.updateTable("_emdash_media_usage_index_status as status")
			.set({
				status: "running",
				started_at: sql<
					string | null
				>`CASE WHEN ${interruptedRestart} THEN started_at ELSE ${now} END`,
				completed_at: null,
				cursor: claim.runToken,
				last_error_code: null,
				change_epoch: sql<number>`CASE WHEN ${interruptedRestart} THEN change_epoch ELSE change_epoch + 1 END`,
				reconciliation_required: 1,
				updated_at: now,
			})
			.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
			.where("status.scope_type", "=", COLLECTION_SCOPE)
			.where("status.collection_id", "=", claim.collectionId)
			.where("status.scope_key", "=", claim.collectionSlug)
			.where("status.capture_state", "=", "active")
			.where("status.reconciliation_required", "=", 1)
			.where((eb) =>
				eb.or([eb("status.status", "!=", "running"), eb("status.cursor", "=", claim.runToken)]),
			)
			.where(this.liveClaimExists(claim))
			.returning("change_epoch")
			.executeTakeFirst();
		return row?.change_epoch ?? null;
	}

	async restartScan(input: {
		claim: MediaUsageReconciliationClaim;
		previousEpoch: number | string;
		targetEpoch: number | string;
		fieldFingerprint: string;
		scanUpperId: string | null;
	}): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				target_epoch: input.targetEpoch,
				field_fingerprint: input.fieldFingerprint,
				phase: "scan",
				scan_cursor: null,
				scan_upper_id: input.scanUpperId,
				source_cursor: null,
				source_upper_key: null,
				attempt_count: 0,
				next_attempt_at: timestampOffset(this.db, 0),
				last_error_code: null,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", input.claim.collectionId)
			.where("reconciliation.run_token", "=", input.claim.runToken)
			.where("reconciliation.target_epoch", "=", input.previousEpoch)
			.where("reconciliation.state", "=", "leased")
			.where("reconciliation.lease_token", "=", input.claim.leaseToken)
			.where(liveLease(this.db))
			.where(this.statusOwnsRun(input.claim, input.targetEpoch))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async findWorkBarrier(collectionId: string): Promise<MediaUsageReconciliationWorkBarrier> {
		if (!collectionId) throw new Error("Reconciliation work barrier requires a collection ID");
		const failed = await this.db
			.selectFrom("_emdash_media_usage_work")
			.select("last_error_code")
			.where("collection_id", "=", collectionId)
			.where("state", "=", "failed")
			.orderBy("content_id")
			.limit(1)
			.executeTakeFirst();
		if (failed) {
			return {
				state: "failed",
				errorCode: failed.last_error_code ?? "MEDIA_USAGE_PROCESSING_FAILED",
			};
		}
		const pending = await this.db
			.selectFrom("_emdash_media_usage_work")
			.select("content_id")
			.where("collection_id", "=", collectionId)
			.limit(1)
			.executeTakeFirst();
		return pending ? { state: "pending" } : { state: "empty" };
	}

	async findSourceUpperKey(
		claim: MediaUsageReconciliationClaim,
		targetEpoch: number | string,
	): Promise<string | null> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_sources as source")
			.select("source.source_key")
			.where("source.source_type", "=", "content")
			.where("source.collection_id", "=", claim.collectionId)
			.where("source.identity_version", "=", 1)
			.where(this.liveClaimExists(claim))
			.where(this.statusOwnsRun(claim, targetEpoch))
			.orderBy("source.source_key", "desc")
			.limit(1)
			.executeTakeFirst();
		return row?.source_key ?? null;
	}

	async transitionToSources(input: {
		claim: MediaUsageReconciliationClaim;
		targetEpoch: number | string;
		fieldFingerprint: string;
		sourceUpperKey: string | null;
	}): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				phase: "sources",
				source_cursor: null,
				source_upper_key: input.sourceUpperKey,
				attempt_count: 0,
				last_error_code: null,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", input.claim.collectionId)
			.where("reconciliation.run_token", "=", input.claim.runToken)
			.where("reconciliation.target_epoch", "=", input.targetEpoch)
			.where("reconciliation.field_fingerprint", "=", input.fieldFingerprint)
			.where("reconciliation.state", "=", "leased")
			.where("reconciliation.phase", "=", "scan")
			.where("reconciliation.lease_token", "=", input.claim.leaseToken)
			.where(liveLease(this.db))
			.where(this.statusOwnsRun(input.claim, input.targetEpoch))
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_work as work")
							.select("work.content_id")
							.where("work.collection_id", "=", input.claim.collectionId),
					),
				),
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async findSourcePage(
		reconciliation: MediaUsageReconciliationRecord,
		limit: number,
	): Promise<MediaUsageReconciliationSourceCandidate[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
			throw new Error("Reconciliation source page limit must be from 1 to 50");
		}
		if (!reconciliation.leaseToken || reconciliation.targetEpoch === null) return [];
		let query = this.db
			.selectFrom("_emdash_media_usage_sources as source")
			.select(["source.source_key", "source.content_id", "source.source_variant"])
			.where("source.source_type", "=", "content")
			.where("source.collection_id", "=", reconciliation.collectionId)
			.where("source.identity_version", "=", 1)
			.where(this.liveClaimExists(reconciliation))
			.where(this.statusOwnsRun(reconciliation, reconciliation.targetEpoch));
		if (reconciliation.sourceCursor) {
			query = query.where("source.source_key", ">", reconciliation.sourceCursor);
		}
		if (reconciliation.sourceUpperKey) {
			query = query.where("source.source_key", "<=", reconciliation.sourceUpperKey);
		} else {
			query = query.where(sql<boolean>`1 = 0`);
		}
		const rows = await query.orderBy("source.source_key").limit(limit).execute();
		return rows.map((row) => ({
			sourceKey: row.source_key,
			contentId: row.content_id,
			sourceVariant: row.source_variant,
		}));
	}

	async findMissingContentIds(
		collectionSlug: string,
		contentIds: readonly string[],
	): Promise<string[]> {
		const unique = [...new Set(contentIds)];
		if (unique.length === 0) return [];
		if (unique.length > 50 || unique.some((contentId) => !contentId)) {
			throw new Error("Reconciliation source page has invalid content identity");
		}
		const tableName = contentTableName(collectionSlug);
		const existing = await sql<{ id: string }>`
			SELECT id FROM ${sql.ref(tableName)} WHERE id IN (${sql.join(unique)})
		`.execute(this.db);
		const present = new Set(existing.rows.map((row) => row.id));
		return unique.filter((contentId) => !present.has(contentId));
	}

	async checkpointSources(input: {
		claim: MediaUsageReconciliationClaim;
		targetEpoch: number | string;
		previousCursor: string | null;
		nextCursor: string;
	}): Promise<boolean> {
		let query = this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				source_cursor: input.nextCursor,
				attempt_count: 0,
				last_error_code: null,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", input.claim.collectionId)
			.where("reconciliation.run_token", "=", input.claim.runToken)
			.where("reconciliation.target_epoch", "=", input.targetEpoch)
			.where("reconciliation.state", "=", "leased")
			.where("reconciliation.phase", "=", "sources")
			.where("reconciliation.lease_token", "=", input.claim.leaseToken)
			.where(liveLease(this.db))
			.where(this.statusOwnsRun(input.claim, input.targetEpoch));
		query = input.previousCursor
			? query.where("reconciliation.source_cursor", "=", input.previousCursor)
			: query.where("reconciliation.source_cursor", "is", null);
		const result = await query.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async finishFailedCoverage(collectionId: string, runToken: string): Promise<boolean> {
		assertIdentity({ collectionId, runToken });
		const now = timestampOffset(this.db, 0);
		const result = await this.db
			.updateTable("_emdash_media_usage_index_status as status")
			.set({
				status: sql<string>`CASE WHEN EXISTS (
					SELECT 1 FROM _emdash_media_usage_sources AS source
					WHERE source.source_type = 'content'
						AND source.collection_id = ${collectionId}
						AND source.identity_version = 1
					LIMIT 1
				) THEN 'partial' ELSE 'failed' END`,
				completed_at: null,
				cursor: null,
				last_error_code: sql<string>`CASE WHEN (
					SELECT reconciliation.last_error_code
					FROM _emdash_media_usage_reconciliations AS reconciliation
					WHERE reconciliation.collection_id = ${collectionId}
						AND reconciliation.run_token = ${runToken}
				) = 'MEDIA_USAGE_RECONCILIATION_ENTRY_FAILED'
				THEN COALESCE(
					(SELECT work.last_error_code
					 FROM _emdash_media_usage_work AS work
					 WHERE work.collection_id = ${collectionId} AND work.state = 'failed'
					 ORDER BY work.content_id LIMIT 1),
					'MEDIA_USAGE_RECONCILIATION_ENTRY_FAILED'
				)
				ELSE (
					SELECT reconciliation.last_error_code
					FROM _emdash_media_usage_reconciliations AS reconciliation
					WHERE reconciliation.collection_id = ${collectionId}
						AND reconciliation.run_token = ${runToken}
				) END`,
				reconciliation_required: 1,
				updated_at: now,
			})
			.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
			.where("status.scope_type", "=", COLLECTION_SCOPE)
			.where("status.collection_id", "=", collectionId)
			.where("status.status", "=", "running")
			.where("status.cursor", "=", runToken)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_reconciliations as reconciliation")
						.select("reconciliation.collection_id")
						.where("reconciliation.collection_id", "=", collectionId)
						.where("reconciliation.run_token", "=", runToken)
						.where("reconciliation.state", "=", "failed"),
				),
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async finalizeCoverage(input: {
		claim: MediaUsageReconciliationClaim;
		targetEpoch: number | string;
		fieldFingerprint: string;
		schemaVersion: number;
	}): Promise<boolean> {
		const now = timestampOffset(this.db, 0);
		const result = await this.db
			.updateTable("_emdash_media_usage_index_status as status")
			.set({
				status: "complete",
				schema_version: input.schemaVersion,
				completed_at: now,
				cursor: null,
				last_error_code: null,
				reconciliation_required: 0,
				updated_at: now,
			})
			.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
			.where("status.scope_type", "=", COLLECTION_SCOPE)
			.where("status.collection_id", "=", input.claim.collectionId)
			.where("status.scope_key", "=", input.claim.collectionSlug)
			.where("status.capture_state", "=", "active")
			.where("status.reconciliation_required", "=", 1)
			.where("status.status", "=", "running")
			.where("status.cursor", "=", input.claim.runToken)
			.where("status.change_epoch", "=", input.targetEpoch)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_work as work")
							.select("work.content_id")
							.where("work.collection_id", "=", input.claim.collectionId),
					),
				),
			)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_reconciliations as reconciliation")
						.innerJoin("_emdash_collections as collection", (join) =>
							join
								.onRef("collection.id", "=", "reconciliation.collection_id")
								.onRef("collection.slug", "=", "reconciliation.collection_slug"),
						)
						.select("reconciliation.collection_id")
						.where("reconciliation.collection_id", "=", input.claim.collectionId)
						.where("reconciliation.run_token", "=", input.claim.runToken)
						.where("reconciliation.target_epoch", "=", input.targetEpoch)
						.where("reconciliation.field_fingerprint", "=", input.fieldFingerprint)
						.where("reconciliation.state", "=", "leased")
						.where("reconciliation.phase", "=", "sources")
						.where("reconciliation.lease_token", "=", input.claim.leaseToken)
						.where(liveLease(this.db, "reconciliation.lease_expires_at"))
						.where((inner) =>
							inner.not(
								inner.exists(
									inner
										.selectFrom("_emdash_media_usage_collection_deletions as deletion")
										.select("deletion.collection_id")
										.where("deletion.collection_id", "=", input.claim.collectionId),
								),
							),
						),
				),
			)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_activation as activation")
						.select("activation.task_key")
						.where("activation.task_key", "=", ACTIVATION_KEY)
						.where("activation.state", "=", "active"),
				),
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async deleteFinalized(claim: MediaUsageReconciliationClaim): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage_reconciliations as reconciliation")
			.where("reconciliation.collection_id", "=", claim.collectionId)
			.where("reconciliation.run_token", "=", claim.runToken)
			.where("reconciliation.state", "=", "leased")
			.where("reconciliation.lease_token", "=", claim.leaseToken)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_index_status as status")
						.select("status.collection_id")
						.where("status.collection_id", "=", claim.collectionId)
						.where("status.scope_key", "=", claim.collectionSlug)
						.where("status.status", "=", "complete")
						.where("status.reconciliation_required", "=", 0),
				),
			)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0) === 1;
	}

	async deleteOneObsolete(): Promise<boolean> {
		const result = await sql<{ collection_id: string }>`
			DELETE FROM _emdash_media_usage_reconciliations
			WHERE (collection_id, run_token) IN (
				SELECT reconciliation.collection_id, reconciliation.run_token
				FROM _emdash_media_usage_reconciliations AS reconciliation
				INNER JOIN _emdash_media_usage_index_status AS status
					ON status.collection_id = reconciliation.collection_id
					AND status.scope_key = reconciliation.collection_slug
				WHERE status.adapter_id = ${CONTENT_ADAPTER_ID}
					AND status.scope_type = ${COLLECTION_SCOPE}
					AND status.reconciliation_required = 0
				ORDER BY reconciliation.updated_at, reconciliation.collection_id
				LIMIT 1
			)
			RETURNING collection_id
		`.execute(this.db);
		return result.rows.length === 1;
	}

	private liveClaimExists(
		claim: Pick<
			MediaUsageReconciliationRecord,
			"collectionId" | "collectionSlug" | "runToken" | "leaseToken"
		>,
	): RawBuilder<boolean> {
		return this.liveClaimExistsSql(claim);
	}

	private liveClaimExistsSql(
		claim: Pick<
			MediaUsageReconciliationRecord,
			"collectionId" | "collectionSlug" | "runToken" | "leaseToken"
		>,
	): RawBuilder<boolean> {
		return sql<boolean>`EXISTS (
			SELECT 1
			FROM _emdash_media_usage_reconciliations AS reconciliation
			INNER JOIN _emdash_collections AS collection
				ON collection.id = reconciliation.collection_id
				AND collection.slug = reconciliation.collection_slug
			WHERE reconciliation.collection_id = ${claim.collectionId}
				AND reconciliation.collection_slug = ${claim.collectionSlug}
				AND reconciliation.run_token = ${claim.runToken}
				AND reconciliation.state = 'leased'
				AND reconciliation.lease_token = ${claim.leaseToken}
				AND ${liveLease(this.db, "reconciliation.lease_expires_at")}
				AND EXISTS (
					SELECT 1 FROM _emdash_media_usage_activation AS activation
					WHERE activation.task_key = ${ACTIVATION_KEY}
						AND activation.state = 'active'
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion
					WHERE deletion.collection_id = reconciliation.collection_id
				)
		)`;
	}

	private statusOwnsRun(
		claim: Pick<MediaUsageReconciliationRecord, "collectionId" | "collectionSlug" | "runToken">,
		targetEpoch: number | string,
	): RawBuilder<boolean> {
		return sql<boolean>`EXISTS (
			SELECT 1 FROM _emdash_media_usage_index_status AS status
			WHERE status.adapter_id = ${CONTENT_ADAPTER_ID}
				AND status.scope_type = ${COLLECTION_SCOPE}
				AND status.collection_id = ${claim.collectionId}
				AND status.scope_key = ${claim.collectionSlug}
				AND status.capture_state = 'active'
				AND status.reconciliation_required = 1
				AND status.status = 'running'
				AND status.cursor = ${claim.runToken}
				AND status.change_epoch = ${targetEpoch}
		)`;
	}

	async seedNextCandidate(): Promise<boolean> {
		const runToken = ulid();
		const now = timestampOffset(this.db, 0);
		const result = await sql<{ collection_id: string }>`
			INSERT INTO _emdash_media_usage_reconciliations (
				collection_id,
				collection_slug,
				run_token,
				next_attempt_at,
				updated_at
			)
			SELECT status.collection_id, status.scope_key, ${runToken}, ${now}, ${now}
			FROM _emdash_media_usage_index_status AS status
			INNER JOIN _emdash_collections AS collection
				ON collection.id = status.collection_id
				AND collection.slug = status.scope_key
			WHERE status.adapter_id = ${CONTENT_ADAPTER_ID}
				AND status.scope_type = ${COLLECTION_SCOPE}
				AND status.capture_state = 'active'
				AND status.reconciliation_required = 1
				AND status.collection_id IS NOT NULL
				AND EXISTS (
					SELECT 1 FROM _emdash_media_usage_activation AS activation
					WHERE activation.task_key = ${ACTIVATION_KEY}
						AND activation.state = 'active'
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage_reconciliations AS existing
					WHERE existing.collection_id = status.collection_id
				)
				AND NOT EXISTS (
					SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion
					WHERE deletion.collection_id = status.collection_id
				)
			ORDER BY status.collection_id
			LIMIT 1
			ON CONFLICT (collection_id) DO NOTHING
			RETURNING collection_id
		`.execute(this.db);
		return result.rows.length === 1;
	}

	async findDue(limit: number): Promise<MediaUsageReconciliationRecord[]> {
		assertLimit(limit);
		const nextAttemptIsDue = timestampIsDue(this.db, "next_attempt_at");
		const leaseIsDue = timestampIsDue(this.db, "lease_expires_at");
		const result = await sql<Selectable<MediaUsageReconciliationTable>>`
			WITH pending_candidates AS (
				SELECT * FROM _emdash_media_usage_reconciliations
				WHERE state = 'pending' AND ${nextAttemptIsDue}
				ORDER BY next_attempt_at, updated_at, collection_id
				LIMIT ${limit}
			), retry_candidates AS (
				SELECT * FROM _emdash_media_usage_reconciliations
				WHERE state = 'retry' AND ${nextAttemptIsDue}
				ORDER BY next_attempt_at, updated_at, collection_id
				LIMIT ${limit}
			), leased_candidates AS (
				SELECT * FROM _emdash_media_usage_reconciliations
				WHERE state = 'leased' AND ${leaseIsDue}
				ORDER BY lease_expires_at, updated_at, collection_id
				LIMIT ${limit}
			), candidates AS (
				SELECT * FROM pending_candidates
				UNION ALL SELECT * FROM retry_candidates
				UNION ALL SELECT * FROM leased_candidates
			)
			SELECT * FROM candidates
			ORDER BY CASE WHEN state = 'leased' THEN lease_expires_at ELSE next_attempt_at END,
				updated_at,
				collection_id
			LIMIT ${limit}
		`.execute(this.db);
		return result.rows.map(rowToRecord);
	}

	async findFailed(limit: number): Promise<MediaUsageReconciliationRecord[]> {
		assertLimit(limit);
		const rows = await this.db
			.selectFrom("_emdash_media_usage_reconciliations as reconciliation")
			.innerJoin("_emdash_media_usage_index_status as status", (join) =>
				join
					.onRef("status.collection_id", "=", "reconciliation.collection_id")
					.onRef("status.scope_key", "=", "reconciliation.collection_slug"),
			)
			.selectAll("reconciliation")
			.where("reconciliation.state", "=", "failed")
			.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
			.where("status.scope_type", "=", COLLECTION_SCOPE)
			.where((eb) =>
				eb.or([
					eb("status.reconciliation_required", "=", 0),
					eb.and([
						eb("status.status", "=", "running"),
						eb("status.cursor", "=", eb.ref("reconciliation.run_token")),
					]),
					eb.and([
						eb("status.cursor", "is", null),
						eb("status.change_epoch", ">", eb.ref("reconciliation.target_epoch")),
					]),
				]),
			)
			.orderBy("reconciliation.updated_at")
			.orderBy("reconciliation.collection_id")
			.limit(limit)
			.execute();
		return rows.map(rowToRecord);
	}

	async claim(input: {
		collectionId: string;
		runToken: string;
		leaseDurationSeconds: number;
	}): Promise<MediaUsageReconciliationClaim | null> {
		assertIdentity(input);
		assertDuration(input.leaseDurationSeconds, "lease duration");
		const leaseToken = ulid();
		const row = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				state: "leased",
				lease_token: leaseToken,
				lease_expires_at: timestampOffset(this.db, input.leaseDurationSeconds),
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", input.collectionId)
			.where("reconciliation.run_token", "=", input.runToken)
			.where((eb) =>
				eb.or([
					eb.and([
						eb("reconciliation.state", "in", ["pending", "retry"]),
						timestampIsDue(this.db, "reconciliation.next_attempt_at"),
					]),
					eb.and([
						eb("reconciliation.state", "=", "leased"),
						timestampIsDue(this.db, "reconciliation.lease_expires_at"),
					]),
				]),
			)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_activation as activation")
						.select("activation.task_key")
						.where("activation.task_key", "=", ACTIVATION_KEY)
						.where("activation.state", "=", "active"),
				),
			)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_index_status as status")
						.innerJoin("_emdash_collections as collection", (join) =>
							join
								.onRef("collection.id", "=", "status.collection_id")
								.onRef("collection.slug", "=", "status.scope_key"),
						)
						.select("status.collection_id")
						.whereRef("status.collection_id", "=", "reconciliation.collection_id")
						.whereRef("status.scope_key", "=", "reconciliation.collection_slug")
						.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
						.where("status.scope_type", "=", COLLECTION_SCOPE)
						.where("status.capture_state", "=", "active")
						.where("status.reconciliation_required", "=", 1),
				),
			)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_collection_deletions as deletion")
							.select("deletion.collection_id")
							.whereRef("deletion.collection_id", "=", "reconciliation.collection_id"),
					),
				),
			)
			.returningAll()
			.executeTakeFirst();
		return row
			? ({ ...rowToRecord(row), leaseToken } satisfies MediaUsageReconciliationClaim)
			: null;
	}

	async release(input: {
		collectionId: string;
		runToken: string;
		leaseToken: string;
		delaySeconds: number;
	}): Promise<boolean> {
		assertLeaseIdentity(input);
		assertDuration(input.delaySeconds, "release delay", true);
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations")
			.set({
				state: "pending",
				next_attempt_at: timestampOffset(this.db, input.delaySeconds),
				lease_token: null,
				lease_expires_at: null,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("collection_id", "=", input.collectionId)
			.where("run_token", "=", input.runToken)
			.where("state", "=", "leased")
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(this.db))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async recordFailure(input: {
		collectionId: string;
		runToken: string;
		leaseToken: string;
		errorCode: string;
		retryDelaySeconds: number;
		terminal: boolean;
	}): Promise<boolean> {
		assertLeaseIdentity(input);
		if (!STABLE_ERROR_CODE_PATTERN.test(input.errorCode)) {
			throw new Error("Reconciliation failure requires a stable error code");
		}
		assertDuration(input.retryDelaySeconds, "retry delay", true);
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations")
			.set({
				state: input.terminal
					? "failed"
					: sql<string>`CASE WHEN attempt_count >= 4 THEN 'failed' ELSE 'retry' END`,
				...(input.terminal
					? {
							target_epoch: sql<number | string | null>`COALESCE(
								target_epoch,
								(SELECT status.change_epoch
								 FROM _emdash_media_usage_index_status AS status
								 WHERE status.adapter_id = ${CONTENT_ADAPTER_ID}
									AND status.scope_type = ${COLLECTION_SCOPE}
									AND status.collection_id = ${input.collectionId}
									AND status.status = 'running'
									AND status.cursor = ${input.runToken})
							)`,
						}
					: {}),
				attempt_count: sql<number>`attempt_count + 1`,
				next_attempt_at: timestampOffset(this.db, input.retryDelaySeconds),
				lease_token: null,
				lease_expires_at: null,
				last_error_code: input.errorCode,
				updated_at: timestampOffset(this.db, 0),
			})
			.where("collection_id", "=", input.collectionId)
			.where("run_token", "=", input.runToken)
			.where("state", "=", "leased")
			.where("lease_token", "=", input.leaseToken)
			.where(liveLease(this.db))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async recordEntryFailure(claim: MediaUsageReconciliationClaim): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				state: "failed",
				attempt_count: sql<number>`attempt_count + 1`,
				next_attempt_at: timestampOffset(this.db, 0),
				lease_token: null,
				lease_expires_at: null,
				last_error_code: "MEDIA_USAGE_RECONCILIATION_ENTRY_FAILED",
				updated_at: timestampOffset(this.db, 0),
			})
			.where("reconciliation.collection_id", "=", claim.collectionId)
			.where("reconciliation.run_token", "=", claim.runToken)
			.where("reconciliation.state", "=", "leased")
			.where("reconciliation.lease_token", "=", claim.leaseToken)
			.where(liveLease(this.db))
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_work as work")
						.select("work.content_id")
						.where("work.collection_id", "=", claim.collectionId)
						.where("work.state", "=", "failed"),
				),
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async resetFailedForNewEpoch(
		observed: Selectable<MediaUsageReconciliationTable> | MediaUsageReconciliationRecord,
	): Promise<boolean> {
		const collectionId =
			"collection_id" in observed ? observed.collection_id : observed.collectionId;
		const runToken = "run_token" in observed ? observed.run_token : observed.runToken;
		const targetEpoch = "target_epoch" in observed ? observed.target_epoch : observed.targetEpoch;
		if (targetEpoch === null) return false;
		const now = timestampOffset(this.db, 0);
		const result = await this.db
			.updateTable("_emdash_media_usage_reconciliations as reconciliation")
			.set({
				state: "pending",
				phase: "scan",
				target_epoch: null,
				field_fingerprint: null,
				scan_cursor: null,
				scan_upper_id: null,
				source_cursor: null,
				source_upper_key: null,
				attempt_count: 0,
				next_attempt_at: now,
				lease_token: null,
				lease_expires_at: null,
				last_error_code: null,
				updated_at: now,
			})
			.where("reconciliation.collection_id", "=", collectionId)
			.where("reconciliation.run_token", "=", runToken)
			.where("reconciliation.state", "=", "failed")
			.where("reconciliation.target_epoch", "=", targetEpoch)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_index_status as status")
						.select("status.collection_id")
						.whereRef("status.collection_id", "=", "reconciliation.collection_id")
						.whereRef("status.scope_key", "=", "reconciliation.collection_slug")
						.where("status.adapter_id", "=", CONTENT_ADAPTER_ID)
						.where("status.scope_type", "=", COLLECTION_SCOPE)
						.where("status.capture_state", "=", "active")
						.where("status.reconciliation_required", "=", 1)
						.where("status.cursor", "is", null)
						.where("status.change_epoch", ">", targetEpoch),
				),
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}
}

function rowToRecord(
	row: Selectable<MediaUsageReconciliationTable>,
): MediaUsageReconciliationRecord {
	if (!isState(row.state) || !isPhase(row.phase) || !Number.isSafeInteger(row.attempt_count)) {
		throw new Error("Invalid media usage reconciliation lifecycle");
	}
	return {
		collectionId: row.collection_id,
		collectionSlug: row.collection_slug,
		runToken: row.run_token,
		targetEpoch: row.target_epoch,
		fieldFingerprint: row.field_fingerprint,
		state: row.state,
		phase: row.phase,
		scanCursor: row.scan_cursor,
		scanUpperId: row.scan_upper_id,
		sourceCursor: row.source_cursor,
		sourceUpperKey: row.source_upper_key,
		attemptCount: row.attempt_count,
		nextAttemptAt: row.next_attempt_at,
		leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at,
		lastErrorCode: row.last_error_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function isState(state: string): state is MediaUsageReconciliationState {
	return state === "pending" || state === "retry" || state === "leased" || state === "failed";
}

function isPhase(phase: string): phase is MediaUsageReconciliationPhase {
	return phase === "scan" || phase === "sources";
}

function assertLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) {
		throw new Error("Reconciliation candidate limit must be from 1 to 100");
	}
}

function assertIdentity(input: { collectionId: string; runToken: string }): void {
	if (!input.collectionId || !input.runToken) {
		throw new Error("Reconciliation requires an exact collection and run token");
	}
}

function assertLeaseIdentity(input: {
	collectionId: string;
	runToken: string;
	leaseToken: string;
}): void {
	assertIdentity(input);
	if (!input.leaseToken) throw new Error("Reconciliation requires a lease token");
}

function assertDuration(value: number, label: string, allowZero = false): void {
	if (
		!Number.isSafeInteger(value) ||
		value < (allowZero ? 0 : 1) ||
		value > MAX_PORTABLE_DURATION_SECONDS
	) {
		throw new Error(`Reconciliation ${label} is outside the portable range`);
	}
}

function liveLease(db: Kysely<Database>, column = "lease_expires_at"): RawBuilder<boolean> {
	const expiry = sql.ref(column);
	return isPostgres(db)
		? sql<boolean>`${expiry} > to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: sql<boolean>`${expiry} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampIsDue(db: Kysely<Database>, column: string): RawBuilder<boolean> {
	const value = sql.ref(column);
	return isPostgres(db)
		? sql<boolean>`${value} <= to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: sql<boolean>`${value} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function timestampOffset(db: Kysely<Database>, offsetSeconds: number): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql<string>`to_char(
			(clock_timestamp() AT TIME ZONE 'UTC') + (${offsetSeconds} * INTERVAL '1 second'),
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		)`;
	}
	return sql<string>`strftime(
		'%Y-%m-%dT%H:%M:%fZ',
		'now',
		${`${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds} seconds`}
	)`;
}

function contentTableName(collectionSlug: string): string {
	validateIdentifier(collectionSlug, "collection slug");
	const tableName = `ec_${collectionSlug}`;
	validateIdentifier(tableName, "content table");
	return tableName;
}
