import { sql, type Kysely, type RawBuilder, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { isPostgres } from "../dialect-helpers.js";
import type { Database, MediaUsageWorkTable } from "../types.js";
import { decodeCursor, encodeCursor, type FindManyResult } from "./types.js";

export type MediaUsageWorkState = "pending" | "retry" | "leased" | "failed";
export type MediaUsageWorkVersion = number | string;
const MAX_PORTABLE_DURATION_SECONDS = 365 * 24 * 60 * 60;
const MAX_WORK_SELECTION_LIMIT = 1_000;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export const MEDIA_USAGE_WORK_OPERATOR_DEFAULT_LIMIT = 50;
export const MEDIA_USAGE_WORK_OPERATOR_MAX_LIMIT = 100;
export const MEDIA_USAGE_RECONCILIATION_PAGE_LIMIT = 1_000;
const MEDIA_USAGE_WORK_STATES = ["pending", "retry", "leased", "failed"] as const;

export interface MediaUsageWorkIdentity {
	collectionId: string;
	contentId: string;
	workVersion: MediaUsageWorkVersion;
}

export interface MediaUsageWorkLease extends MediaUsageWorkIdentity {
	leaseToken: string;
}

export interface MediaUsageWorkRecord extends MediaUsageWorkIdentity {
	collectionSlug: string;
	changeEpoch: number | string;
	state: MediaUsageWorkState;
	attemptCount: number;
	nextAttemptAt: string;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	lastAttemptedAt: string | null;
	lastErrorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MediaUsageOperatorWorkItem {
	collectionId: string;
	collectionSlug: string;
	contentId: string;
	state: MediaUsageWorkState;
	attemptCount: number;
	nextAttemptAt: string;
	leaseExpiresAt: string | null;
	lastAttemptedAt: string | null;
	lastErrorCode: string | null;
	updatedAt: string;
}

export type MediaUsageOperatorRetryResult =
	| { outcome: "pending"; changed: boolean; work: MediaUsageOperatorWorkItem }
	| { outcome: "lease_active"; leaseExpiresAt: string }
	| { outcome: "collection_not_found" }
	| { outcome: "conflict" };

export class MediaUsageWorkRepository {
	constructor(private db: Kysely<Database>) {}

	async enqueueReconciliationPage(input: {
		collectionId: string;
		collectionSlug: string;
		runToken: string;
		leaseToken: string;
		changeEpoch: number | string;
		phase: "scan" | "sources";
		contentIds: readonly string[];
	}): Promise<void> {
		if (!input.collectionId || !input.collectionSlug || !input.runToken || !input.leaseToken) {
			throw new Error("Reconciliation enqueue requires exact collection and lease identity");
		}
		assertNonNegativeDecimal(input.changeEpoch, "change epoch");
		const contentIds = [...new Set(input.contentIds)];
		if (contentIds.length < 1 || contentIds.length > MEDIA_USAGE_RECONCILIATION_PAGE_LIMIT) {
			throw new Error("Reconciliation enqueue requires from 1 to 1000 content IDs");
		}
		if (contentIds.some((contentId) => !contentId)) {
			throw new Error("Reconciliation enqueue content IDs must not be empty");
		}
		const now = this.timestampOffset(0);
		const contentIdsJson = JSON.stringify(contentIds);
		const page = isPostgres(this.db)
			? sql`SELECT value::text AS content_id FROM jsonb_array_elements_text(${contentIdsJson}::jsonb) AS value`
			: sql`SELECT value AS content_id FROM json_each(${contentIdsJson})`;
		await sql`
			WITH page(content_id) AS (${page})
			INSERT INTO _emdash_media_usage_work (
				collection_id, collection_slug, content_id, change_epoch, work_version,
				state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
				last_attempted_at, last_error_code, created_at, updated_at
			)
			SELECT
				${input.collectionId}, ${input.collectionSlug}, page.content_id, ${input.changeEpoch}, 1,
				'pending', 0, ${now}, NULL, NULL, NULL, NULL, ${now}, ${now}
			FROM page
			WHERE EXISTS (
				SELECT 1
				FROM _emdash_media_usage_reconciliations AS reconciliation
				INNER JOIN _emdash_media_usage_index_status AS status
					ON status.collection_id = reconciliation.collection_id
					AND status.scope_key = reconciliation.collection_slug
				INNER JOIN _emdash_collections AS collection
					ON collection.id = reconciliation.collection_id
					AND collection.slug = reconciliation.collection_slug
				WHERE reconciliation.collection_id = ${input.collectionId}
					AND reconciliation.collection_slug = ${input.collectionSlug}
					AND reconciliation.run_token = ${input.runToken}
					AND reconciliation.target_epoch = ${input.changeEpoch}
					AND reconciliation.state = 'leased'
					AND reconciliation.phase = ${input.phase}
					AND reconciliation.lease_token = ${input.leaseToken}
					AND ${this.qualifiedLeaseIsLive("reconciliation.lease_expires_at")}
					AND status.adapter_id = 'content-media'
					AND status.scope_type = 'collection'
					AND status.capture_state = 'active'
					AND status.reconciliation_required = 1
					AND status.status = 'running'
					AND status.cursor = ${input.runToken}
					AND status.change_epoch = ${input.changeEpoch}
					AND EXISTS (
						SELECT 1 FROM _emdash_media_usage_activation AS activation
						WHERE activation.task_key = 'incremental_capture'
							AND activation.state = 'active'
					)
					AND NOT EXISTS (
						SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion
						WHERE deletion.collection_id = reconciliation.collection_id
					)
			)
			ON CONFLICT (collection_id, content_id) DO UPDATE SET
				collection_slug = excluded.collection_slug,
				change_epoch = excluded.change_epoch,
				work_version = _emdash_media_usage_work.work_version + 1,
				state = 'pending',
				attempt_count = 0,
				next_attempt_at = excluded.next_attempt_at,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_attempted_at = NULL,
				last_error_code = NULL,
				updated_at = excluded.updated_at
			WHERE _emdash_media_usage_work.change_epoch < excluded.change_epoch
		`.execute(this.db);
	}

	async findOperatorPage(options: {
		collectionSlug: string;
		state?: MediaUsageWorkState;
		limit?: number;
		cursor?: string;
	}): Promise<FindManyResult<MediaUsageOperatorWorkItem> | null> {
		if (!options.collectionSlug) {
			throw new Error("Media usage work listing requires a collection slug");
		}
		if (options.state !== undefined && !isMediaUsageWorkState(options.state)) {
			throw new Error("Media usage work listing requires a valid state");
		}
		const limit = operatorLimit(options.limit);
		const cursor = options.cursor ? decodeCursor(options.cursor) : null;
		const collection = await this.db
			.selectFrom("_emdash_collections")
			.select(["id", "slug"])
			.where("slug", "=", options.collectionSlug)
			.executeTakeFirst();
		if (!collection) return null;

		const states = options.state ? [options.state] : MEDIA_USAGE_WORK_STATES;
		const candidates: MediaUsageOperatorWorkItem[] = [];
		for (const state of states) {
			const rows = await this.findOperatorRows({
				collectionId: collection.id,
				collectionSlug: collection.slug,
				state,
				limit: limit + 1,
				cursor,
			});
			candidates.push(...rows.map(rowToOperatorWork));
		}

		const ordered = candidates.toSorted(compareOperatorWork);
		const items = ordered.slice(0, limit);
		const result: FindManyResult<MediaUsageOperatorWorkItem> = { items };
		if (ordered.length > limit && items.length > 0) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.updatedAt, last.contentId);
		}
		return result;
	}

	private async findOperatorRows(input: {
		collectionId: string;
		collectionSlug: string;
		state: MediaUsageWorkState;
		limit: number;
		cursor: { orderValue: string; id: string } | null;
	}): Promise<Selectable<MediaUsageWorkTable>[]> {
		let query = this.db
			.selectFrom("_emdash_media_usage_work as work")
			.innerJoin("_emdash_collections as current_collection", (join) =>
				join
					.onRef("current_collection.id", "=", "work.collection_id")
					.onRef("current_collection.slug", "=", "work.collection_slug"),
			)
			.selectAll("work")
			.where("work.collection_id", "=", input.collectionId)
			.where("work.collection_slug", "=", input.collectionSlug)
			.where("work.state", "=", input.state);
		if (input.cursor) {
			query = query.where((eb) =>
				eb.or([
					eb("work.updated_at", "<", input.cursor!.orderValue),
					eb.and([
						eb("work.updated_at", "=", input.cursor!.orderValue),
						eb("work.content_id", "<", input.cursor!.id),
					]),
				]),
			);
		}
		return query
			.orderBy("work.updated_at", "desc")
			.orderBy("work.content_id", "desc")
			.limit(input.limit)
			.execute();
	}

	async retryOperatorWork(input: {
		collectionId: string;
		contentId: string;
	}): Promise<MediaUsageOperatorRetryResult> {
		if (!input.collectionId || !input.contentId) {
			throw new Error("Media usage operator retry requires collection and content IDs");
		}
		const collection = await this.findActiveOperatorCollection(input.collectionId);
		if (!collection) return { outcome: "collection_not_found" };

		const observed = await this.findWorkByIdentity(input.collectionId, input.contentId);
		if (observed?.state === "pending" && observed.collection_slug === collection.slug) {
			return { outcome: "pending", changed: false, work: rowToOperatorWork(observed) };
		}

		const invalidated = await this.invalidateCoverageForOperatorRetry({
			...input,
			collectionSlug: collection.slug,
			observed,
		});
		if (!invalidated) return this.operatorRetryLost(input);

		const reopened = observed
			? await this.reopenObservedWork(observed, collection.slug, invalidated.change_epoch)
			: await this.createOperatorWork({
					...input,
					collectionSlug: collection.slug,
					changeEpoch: invalidated.change_epoch,
				});
		if (reopened) {
			return { outcome: "pending", changed: true, work: rowToOperatorWork(reopened) };
		}
		return this.operatorRetryLost(input);
	}

	private async findActiveOperatorCollection(
		collectionId: string,
	): Promise<{ id: string; slug: string } | null> {
		const row = await this.db
			.selectFrom("_emdash_collections as collection")
			.innerJoin("_emdash_media_usage_index_status as status", (join) =>
				join
					.onRef("status.collection_id", "=", "collection.id")
					.onRef("status.scope_key", "=", "collection.slug"),
			)
			.select(["collection.id", "collection.slug"])
			.where("collection.id", "=", collectionId)
			.where("status.adapter_id", "=", "content-media")
			.where("status.scope_type", "=", "collection")
			.where("status.capture_state", "=", "active")
			.executeTakeFirst();
		return row ?? null;
	}

	private async findWorkByIdentity(
		collectionId: string,
		contentId: string,
	): Promise<Selectable<MediaUsageWorkTable> | null> {
		return (
			(await this.db
				.selectFrom("_emdash_media_usage_work")
				.selectAll()
				.where("collection_id", "=", collectionId)
				.where("content_id", "=", contentId)
				.executeTakeFirst()) ?? null
		);
	}

	private async invalidateCoverageForOperatorRetry(input: {
		collectionId: string;
		collectionSlug: string;
		contentId: string;
		observed: Selectable<MediaUsageWorkTable> | null;
	}): Promise<{ change_epoch: number | string } | null> {
		let query = this.db
			.updateTable("_emdash_media_usage_index_status as status")
			.set({
				change_epoch: sql<number>`change_epoch + 1`,
				status: sql<string>`CASE WHEN status IN ('complete', 'partial', 'failed') THEN 'stale' ELSE status END`,
				completed_at: sql<
					string | null
				>`CASE WHEN status IN ('complete', 'partial', 'failed') THEN NULL ELSE completed_at END`,
				last_error_code: null,
				updated_at: this.timestampOffset(0),
			})
			.where("status.adapter_id", "=", "content-media")
			.where("status.scope_type", "=", "collection")
			.where("status.scope_key", "=", input.collectionSlug)
			.where("status.collection_id", "=", input.collectionId)
			.where("status.capture_state", "=", "active")
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_collections as collection")
						.select("collection.id")
						.whereRef("collection.id", "=", "status.collection_id")
						.whereRef("collection.slug", "=", "status.scope_key"),
				),
			);

		const observed = input.observed;
		if (observed) {
			query = query.where((eb) => {
				let work = eb
					.selectFrom("_emdash_media_usage_work as work")
					.select("work.content_id")
					.whereRef("work.collection_id", "=", "status.collection_id")
					.where("work.content_id", "=", input.contentId)
					.where("work.work_version", "=", observed.work_version)
					.where("work.state", "=", observed.state);
				if (observed.state === "leased") {
					work = work
						.where("work.lease_expires_at", "is not", null)
						.where(this.timestampIsDue("work.lease_expires_at"));
				}
				return eb.exists(work);
			});
		} else {
			query = query.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_work as work")
							.select("work.content_id")
							.whereRef("work.collection_id", "=", "status.collection_id")
							.where("work.content_id", "=", input.contentId),
					),
				),
			);
		}

		return (await query.returning("change_epoch").executeTakeFirst()) ?? null;
	}

	private async reopenObservedWork(
		observed: Selectable<MediaUsageWorkTable>,
		collectionSlug: string,
		changeEpoch: number | string,
	): Promise<Selectable<MediaUsageWorkTable> | null> {
		let query = this.db
			.updateTable("_emdash_media_usage_work")
			.set({
				collection_slug: collectionSlug,
				change_epoch: changeEpoch,
				work_version: sql<number>`work_version + 1`,
				state: "pending",
				attempt_count: 0,
				next_attempt_at: this.timestampOffset(0),
				lease_token: null,
				lease_expires_at: null,
				last_attempted_at: null,
				last_error_code: null,
				updated_at: this.timestampOffset(0),
			})
			.where("collection_id", "=", observed.collection_id)
			.where("content_id", "=", observed.content_id)
			.where("work_version", "=", observed.work_version)
			.where("state", "=", observed.state)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_collections as collection")
						.innerJoin("_emdash_media_usage_index_status as status", (join) =>
							join
								.onRef("status.collection_id", "=", "collection.id")
								.onRef("status.scope_key", "=", "collection.slug"),
						)
						.select("collection.id")
						.where("collection.id", "=", observed.collection_id)
						.where("collection.slug", "=", collectionSlug)
						.where("status.adapter_id", "=", "content-media")
						.where("status.scope_type", "=", "collection")
						.where("status.capture_state", "=", "active")
						.where("status.change_epoch", "=", changeEpoch),
				),
			);
		if (observed.state === "leased") {
			query = query
				.where("lease_expires_at", "is not", null)
				.where(this.timestampIsDue("lease_expires_at"));
		}
		return (await query.returningAll().executeTakeFirst()) ?? null;
	}

	private async createOperatorWork(input: {
		collectionId: string;
		collectionSlug: string;
		contentId: string;
		changeEpoch: number | string;
	}): Promise<Selectable<MediaUsageWorkTable> | null> {
		const now = this.timestampOffset(0);
		return (
			(await this.db
				.insertInto("_emdash_media_usage_work")
				.columns([
					"collection_id",
					"collection_slug",
					"content_id",
					"change_epoch",
					"work_version",
					"state",
					"attempt_count",
					"next_attempt_at",
					"lease_token",
					"lease_expires_at",
					"last_attempted_at",
					"last_error_code",
					"created_at",
					"updated_at",
				])
				.expression((insert) =>
					insert
						.selectFrom("_emdash_media_usage_index_status as status")
						.innerJoin("_emdash_collections as collection", (join) =>
							join
								.onRef("collection.id", "=", "status.collection_id")
								.onRef("collection.slug", "=", "status.scope_key"),
						)
						.select((select) => [
							select.val(input.collectionId).as("collection_id"),
							"collection.slug as collection_slug",
							select.val(input.contentId).as("content_id"),
							"status.change_epoch as change_epoch",
							select.val(1).as("work_version"),
							select.val("pending").as("state"),
							select.val(0).as("attempt_count"),
							now.as("next_attempt_at"),
							sql<null>`NULL`.as("lease_token"),
							sql<null>`NULL`.as("lease_expires_at"),
							sql<null>`NULL`.as("last_attempted_at"),
							sql<null>`NULL`.as("last_error_code"),
							now.as("created_at"),
							now.as("updated_at"),
						])
						.where("status.adapter_id", "=", "content-media")
						.where("status.scope_type", "=", "collection")
						.where("status.scope_key", "=", input.collectionSlug)
						.where("status.collection_id", "=", input.collectionId)
						.where("status.capture_state", "=", "active")
						.where("status.change_epoch", "=", input.changeEpoch),
				)
				.onConflict((conflict) => conflict.columns(["collection_id", "content_id"]).doNothing())
				.returningAll()
				.executeTakeFirst()) ?? null
		);
	}

	private async operatorRetryLost(input: {
		collectionId: string;
		contentId: string;
	}): Promise<MediaUsageOperatorRetryResult> {
		if (!(await this.findActiveOperatorCollection(input.collectionId))) {
			return { outcome: "collection_not_found" };
		}
		const current = await this.findWorkByIdentity(input.collectionId, input.contentId);
		if (current?.state === "pending") {
			return { outcome: "pending", changed: false, work: rowToOperatorWork(current) };
		}
		const liveLease = await this.findLiveLeaseExpiry(input.collectionId, input.contentId);
		if (liveLease) return { outcome: "lease_active", leaseExpiresAt: liveLease };
		return { outcome: "conflict" };
	}

	private async findLiveLeaseExpiry(
		collectionId: string,
		contentId: string,
	): Promise<string | null> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_work")
			.select("lease_expires_at")
			.where("collection_id", "=", collectionId)
			.where("content_id", "=", contentId)
			.where("state", "=", "leased")
			.where("lease_expires_at", "is not", null)
			.where(this.leaseIsLive())
			.executeTakeFirst();
		return row?.lease_expires_at ?? null;
	}

	async claimDueWorkBatch(input: {
		limit: number;
		leaseDurationSeconds: number;
	}): Promise<MediaUsageWorkRecord[]> {
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > MAX_WORK_SELECTION_LIMIT
		) {
			throw new Error(
				`Media usage due-work limit must be a whole number from 1 to ${MAX_WORK_SELECTION_LIMIT}`,
			);
		}
		const leaseDurationSeconds = durationSeconds(
			input.leaseDurationSeconds,
			"lease duration",
			false,
		);
		const leaseToken = ulid();
		const now = this.timestampOffset(0);
		let candidates = this.db
			.selectFrom("_emdash_media_usage_work as due")
			.select(["due.collection_id", "due.content_id", "due.work_version"])
			.where((eb) =>
				eb.or([
					eb.and([
						eb("due.state", "in", ["pending", "retry"]),
						this.timestampIsDue("due.next_attempt_at"),
					]),
					eb.and([
						eb("due.state", "=", "leased"),
						eb("due.lease_expires_at", "is not", null),
						this.timestampIsDue("due.lease_expires_at"),
					]),
				]),
			)
			.orderBy(
				sql<string>`CASE
					WHEN due.state = 'leased' THEN due.lease_expires_at
					ELSE due.next_attempt_at
				END`,
				"asc",
			)
			.orderBy("due.updated_at", "asc")
			.orderBy("due.collection_id", "asc")
			.orderBy("due.content_id", "asc")
			.limit(input.limit);
		if (isPostgres(this.db)) candidates = candidates.forUpdate().skipLocked();
		const rows = await this.db
			.with("due_media_usage_work", () => candidates)
			.updateTable("_emdash_media_usage_work")
			.set({
				state: "leased",
				lease_token: leaseToken,
				lease_expires_at: this.timestampOffset(leaseDurationSeconds),
				last_attempted_at: now,
				updated_at: now,
			})
			.where((eb) =>
				eb.and([
					eb.exists(
						eb
							.selectFrom("due_media_usage_work as due")
							.select("due.content_id")
							.whereRef("due.collection_id", "=", "_emdash_media_usage_work.collection_id")
							.whereRef("due.content_id", "=", "_emdash_media_usage_work.content_id")
							.whereRef("due.work_version", "=", "_emdash_media_usage_work.work_version"),
					),
					eb.or([
						eb.and([
							eb("state", "in", ["pending", "retry"]),
							this.timestampIsDue("next_attempt_at"),
						]),
						eb.and([
							eb("state", "=", "leased"),
							eb("lease_expires_at", "is not", null),
							this.timestampIsDue("lease_expires_at"),
						]),
					]),
				]),
			)
			.returningAll()
			.execute();

		return rows.map(rowToWork);
	}

	async hasNonterminalWork(): Promise<boolean> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_work")
			.select("content_id")
			.where("state", "in", ["pending", "retry", "leased"])
			.limit(1)
			.executeTakeFirst();
		return row !== undefined;
	}

	async findWorkForContent(
		collectionSlug: string,
		contentId: string,
	): Promise<MediaUsageWorkRecord | null> {
		if (!collectionSlug || !contentId) {
			throw new Error("Media usage work lookup requires collection and content identity");
		}
		const row = await this.db
			.selectFrom("_emdash_media_usage_work")
			.innerJoin("_emdash_collections as current_collection", (join) =>
				join
					.onRef("current_collection.id", "=", "_emdash_media_usage_work.collection_id")
					.onRef("current_collection.slug", "=", "_emdash_media_usage_work.collection_slug"),
			)
			.selectAll("_emdash_media_usage_work")
			.where("_emdash_media_usage_work.collection_slug", "=", collectionSlug)
			.where("_emdash_media_usage_work.content_id", "=", contentId)
			.executeTakeFirst();
		return row ? rowToWork(row) : null;
	}

	async claimWork(
		input: MediaUsageWorkIdentity & {
			leaseDurationSeconds: number;
		},
	): Promise<MediaUsageWorkRecord | null> {
		assertIdentity(input);
		const leaseDurationSeconds = durationSeconds(
			input.leaseDurationSeconds,
			"lease duration",
			false,
		);
		const leaseToken = ulid();
		const now = this.timestampOffset(0);
		const row = await this.db
			.updateTable("_emdash_media_usage_work")
			.set({
				state: "leased",
				lease_token: leaseToken,
				lease_expires_at: this.timestampOffset(leaseDurationSeconds),
				last_attempted_at: now,
				updated_at: now,
			})
			.where("collection_id", "=", input.collectionId)
			.where("content_id", "=", input.contentId)
			.where("work_version", "=", input.workVersion)
			.where((eb) =>
				eb.or([
					eb.and([eb("state", "in", ["pending", "retry"]), this.timestampIsDue("next_attempt_at")]),
					eb.and([
						eb("state", "=", "leased"),
						eb("lease_expires_at", "is not", null),
						this.timestampIsDue("lease_expires_at"),
					]),
				]),
			)
			.returningAll()
			.executeTakeFirst();

		return row ? rowToWork(row) : null;
	}

	async completeWorkBatch(inputs: readonly MediaUsageWorkLease[]): Promise<Set<string>> {
		const unique = [
			...new Map(
				inputs.map((input) => {
					assertLease(input);
					return [workIdentityKey(input), input] as const;
				}),
			).values(),
		];
		const completed = new Set<string>();
		if (unique.length === 0) return completed;
		const payload = JSON.stringify(
			unique.map((input) => ({
				collection_id: input.collectionId,
				content_id: input.contentId,
				work_version: String(input.workVersion),
				lease_token: input.leaseToken,
			})),
		);
		const claimed = this.claimedWorkBatchInput(payload);
		const result = await sql<{
			collection_id: string;
			content_id: string;
			work_version: MediaUsageWorkVersion;
		}>`
			WITH claimed AS (${claimed})
			DELETE FROM _emdash_media_usage_work AS work
			WHERE work.state = 'leased'
				AND ${this.qualifiedLeaseIsLive("work.lease_expires_at")}
				AND EXISTS (
					SELECT 1
					FROM claimed
					WHERE claimed.collection_id = work.collection_id
						AND claimed.content_id = work.content_id
						AND claimed.work_version = work.work_version
						AND claimed.lease_token = work.lease_token
				)
			RETURNING collection_id, content_id, work_version
		`.execute(this.db);
		for (const row of result.rows) {
			completed.add(
				workIdentityKey({
					collectionId: row.collection_id,
					contentId: row.content_id,
					workVersion: row.work_version,
				}),
			);
		}
		return completed;
	}

	async lockClaimedWorkBatch(inputs: readonly MediaUsageWorkLease[]): Promise<Set<string>> {
		const unique = [
			...new Map(
				inputs.map((input) => {
					assertLease(input);
					return [workIdentityKey(input), input] as const;
				}),
			).values(),
		].toSorted((left, right) => workIdentityKey(left).localeCompare(workIdentityKey(right)));
		if (!isPostgres(this.db)) return new Set(unique.map(workIdentityKey));
		if (unique.length === 0) return new Set();
		const payload = JSON.stringify(
			unique.map((input) => ({
				collection_id: input.collectionId,
				content_id: input.contentId,
				work_version: String(input.workVersion),
				lease_token: input.leaseToken,
			})),
		);
		const claimed = this.claimedWorkBatchInput(payload);
		const result = await sql<{
			collection_id: string;
			content_id: string;
			work_version: MediaUsageWorkVersion;
		}>`
			WITH claimed AS (${claimed})
			SELECT work.collection_id, work.content_id, work.work_version
			FROM _emdash_media_usage_work AS work
			INNER JOIN claimed
				ON claimed.collection_id = work.collection_id
				AND claimed.content_id = work.content_id
				AND claimed.work_version = work.work_version
				AND claimed.lease_token = work.lease_token
			WHERE work.state = 'leased'
				AND ${this.qualifiedLeaseIsLive("work.lease_expires_at")}
			ORDER BY work.collection_id, work.content_id
			FOR UPDATE
		`.execute(this.db);
		return new Set(
			result.rows.map((row) =>
				workIdentityKey({
					collectionId: row.collection_id,
					contentId: row.content_id,
					workVersion: row.work_version,
				}),
			),
		);
	}

	async retryClaimedWorkBatch(input: {
		work: readonly MediaUsageWorkLease[];
		errorCode: string;
		retryDelaySeconds: number;
		maxAttempts: number;
	}): Promise<Map<string, "retry" | "failed">> {
		assertErrorCode(input.errorCode);
		const retryDelaySeconds = durationSeconds(input.retryDelaySeconds, "retry delay", true);
		if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
			throw new Error("Media usage work max attempts must be a positive whole number");
		}
		const unique = [
			...new Map(
				input.work.map((work) => {
					assertLease(work);
					return [workIdentityKey(work), work] as const;
				}),
			).values(),
		];
		const transitioned = new Map<string, "retry" | "failed">();
		if (unique.length === 0) return transitioned;
		const payload = JSON.stringify(
			unique.map((work) => ({
				collection_id: work.collectionId,
				content_id: work.contentId,
				work_version: String(work.workVersion),
				lease_token: work.leaseToken,
			})),
		);
		const claimed = this.claimedWorkBatchInput(payload);
		const result = await sql<{
			collection_id: string;
			content_id: string;
			work_version: MediaUsageWorkVersion;
			state: "retry" | "failed";
		}>`
			WITH claimed AS (${claimed})
			UPDATE _emdash_media_usage_work AS work
			SET state = CASE WHEN work.attempt_count + 1 >= ${input.maxAttempts} THEN 'failed' ELSE 'retry' END,
				attempt_count = work.attempt_count + 1,
				next_attempt_at = ${this.timestampOffset(retryDelaySeconds)},
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = ${input.errorCode},
				updated_at = ${this.timestampOffset(0)}
			WHERE work.state = 'leased'
				AND ${this.qualifiedLeaseIsLive("work.lease_expires_at")}
				AND EXISTS (
					SELECT 1
					FROM claimed
					WHERE claimed.collection_id = work.collection_id
						AND claimed.content_id = work.content_id
						AND claimed.work_version = work.work_version
						AND claimed.lease_token = work.lease_token
				)
			RETURNING collection_id, content_id, work_version, state
		`.execute(this.db);
		for (const row of result.rows) {
			transitioned.set(
				workIdentityKey({
					collectionId: row.collection_id,
					contentId: row.content_id,
					workVersion: row.work_version,
				}),
				row.state,
			);
		}
		return transitioned;
	}

	async releaseClaimedWorkBatch(inputs: readonly MediaUsageWorkLease[]): Promise<Set<string>> {
		const unique = [
			...new Map(
				inputs.map((input) => {
					assertLease(input);
					return [workIdentityKey(input), input] as const;
				}),
			).values(),
		];
		const released = new Set<string>();
		if (unique.length === 0) return released;
		const payload = JSON.stringify(
			unique.map((input) => ({
				collection_id: input.collectionId,
				content_id: input.contentId,
				work_version: String(input.workVersion),
				lease_token: input.leaseToken,
			})),
		);
		const claimed = this.claimedWorkBatchInput(payload);
		const result = await sql<{
			collection_id: string;
			content_id: string;
			work_version: MediaUsageWorkVersion;
		}>`
			WITH claimed AS (${claimed})
			UPDATE _emdash_media_usage_work AS work
			SET state = 'pending',
				next_attempt_at = ${this.timestampOffset(0)},
				lease_token = NULL,
				lease_expires_at = NULL,
				updated_at = ${this.timestampOffset(0)}
			WHERE work.state = 'leased'
				AND ${this.qualifiedLeaseIsLive("work.lease_expires_at")}
				AND EXISTS (
					SELECT 1
					FROM claimed
					WHERE claimed.collection_id = work.collection_id
						AND claimed.content_id = work.content_id
						AND claimed.work_version = work.work_version
						AND claimed.lease_token = work.lease_token
				)
			RETURNING collection_id, content_id, work_version
		`.execute(this.db);
		for (const row of result.rows) {
			released.add(
				workIdentityKey({
					collectionId: row.collection_id,
					contentId: row.content_id,
					workVersion: row.work_version,
				}),
			);
		}
		return released;
	}

	async deleteWorkThroughEpoch(
		collectionId: string,
		maxChangeEpoch: number | string,
	): Promise<number> {
		if (!collectionId) throw new Error("Media usage work cleanup requires a collection ID");
		assertNonNegativeDecimal(maxChangeEpoch, "change epoch");
		const result = await this.db
			.deleteFrom("_emdash_media_usage_work")
			.where("collection_id", "=", collectionId)
			.where("change_epoch", "<=", maxChangeEpoch)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	async deleteObsoleteReconciliationWork(input: {
		collectionId: string;
		collectionSlug: string;
		runToken: string;
		leaseToken: string;
		targetEpoch: number | string;
	}): Promise<number> {
		assertNonNegativeDecimal(input.targetEpoch, "target epoch");
		const result = await this.db
			.deleteFrom("_emdash_media_usage_work as work")
			.where("work.collection_id", "=", input.collectionId)
			.where("work.change_epoch", "<", input.targetEpoch)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_reconciliations as reconciliation")
						.innerJoin("_emdash_media_usage_index_status as status", (join) =>
							join
								.onRef("status.collection_id", "=", "reconciliation.collection_id")
								.onRef("status.scope_key", "=", "reconciliation.collection_slug"),
						)
						.innerJoin("_emdash_collections as collection", (join) =>
							join
								.onRef("collection.id", "=", "reconciliation.collection_id")
								.onRef("collection.slug", "=", "reconciliation.collection_slug"),
						)
						.select("reconciliation.collection_id")
						.where("reconciliation.collection_id", "=", input.collectionId)
						.where("reconciliation.collection_slug", "=", input.collectionSlug)
						.where("reconciliation.run_token", "=", input.runToken)
						.where("reconciliation.target_epoch", "=", input.targetEpoch)
						.where("reconciliation.state", "=", "leased")
						.where("reconciliation.lease_token", "=", input.leaseToken)
						.where(this.qualifiedLeaseIsLive("reconciliation.lease_expires_at"))
						.where("status.capture_state", "=", "active")
						.where("status.reconciliation_required", "=", 1)
						.where("status.status", "=", "running")
						.where("status.cursor", "=", input.runToken)
						.where("status.change_epoch", "=", input.targetEpoch),
				),
			)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	private leaseIsLive(): RawBuilder<boolean> {
		return isPostgres(this.db)
			? sql<boolean>`lease_expires_at::timestamptz > clock_timestamp()`
			: sql<boolean>`lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private qualifiedLeaseIsLive(column: string): RawBuilder<boolean> {
		const expiry = sql.ref(column);
		return isPostgres(this.db)
			? sql<boolean>`${expiry} > to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
			: sql<boolean>`${expiry} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private timestampIsDue(
		column:
			| "next_attempt_at"
			| "lease_expires_at"
			| "work.lease_expires_at"
			| "work.next_attempt_at"
			| "due.next_attempt_at"
			| "due.lease_expires_at",
	): RawBuilder<boolean> {
		return isPostgres(this.db)
			? sql<boolean>`${sql.ref(column)} <= to_char(
				statement_timestamp() AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
			)`
			: sql<boolean>`${sql.ref(column)} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private timestampOffset(offsetSeconds: number): RawBuilder<string> {
		if (isPostgres(this.db)) {
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

	private claimedWorkBatchInput(payload: string): RawBuilder<unknown> {
		if (isPostgres(this.db)) {
			return sql`
				SELECT
					entry.value ->> 'collection_id' AS collection_id,
					entry.value ->> 'content_id' AS content_id,
					CAST(entry.value ->> 'work_version' AS bigint) AS work_version,
					entry.value ->> 'lease_token' AS lease_token
				FROM jsonb_array_elements(${payload}::jsonb) AS entry(value)
			`;
		}
		return sql`
			SELECT
				json_extract(entry.value, '$.collection_id') AS collection_id,
				json_extract(entry.value, '$.content_id') AS content_id,
				CAST(json_extract(entry.value, '$.work_version') AS integer) AS work_version,
				json_extract(entry.value, '$.lease_token') AS lease_token
			FROM json_each(${payload}) AS entry
		`;
	}
}

function workIdentityKey(input: MediaUsageWorkIdentity): string {
	return `${input.collectionId}\u0000${input.contentId}\u0000${String(input.workVersion)}`;
}

function operatorLimit(value: number | undefined): number {
	if (value === undefined) return MEDIA_USAGE_WORK_OPERATOR_DEFAULT_LIMIT;
	if (!Number.isSafeInteger(value) || value < 1 || value > MEDIA_USAGE_WORK_OPERATOR_MAX_LIMIT) {
		throw new Error(
			`Media usage operator limit must be a whole number from 1 to ${MEDIA_USAGE_WORK_OPERATOR_MAX_LIMIT}`,
		);
	}
	return value;
}

function durationSeconds(value: number, label: string, allowZero: boolean): number {
	if (
		!Number.isSafeInteger(value) ||
		value < (allowZero ? 0 : 1) ||
		value > MAX_PORTABLE_DURATION_SECONDS
	) {
		throw new Error(
			`Media usage work ${label} must be ${allowZero ? "a non-negative" : "a positive"} whole number of seconds no greater than one year`,
		);
	}
	return value;
}

function assertIdentity(input: MediaUsageWorkIdentity): void {
	if (!input.collectionId || !input.contentId) {
		throw new Error("Media usage work identity must include collection and content IDs");
	}
	const validVersion =
		(typeof input.workVersion === "number" &&
			Number.isSafeInteger(input.workVersion) &&
			input.workVersion > 0) ||
		(typeof input.workVersion === "string" && POSITIVE_DECIMAL_PATTERN.test(input.workVersion));
	if (!validVersion) {
		throw new Error("Media usage work identity must include a work version");
	}
}

function assertNonNegativeDecimal(value: number | string, label: string): void {
	const valid =
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
		(typeof value === "string" && NON_NEGATIVE_DECIMAL_PATTERN.test(value));
	if (!valid) throw new Error(`Media usage work ${label} must be a non-negative whole number`);
}

function assertToken(value: string): void {
	if (!value) throw new Error("Media usage work lease token must not be empty");
}

function assertLease(input: MediaUsageWorkLease): void {
	assertIdentity(input);
	assertToken(input.leaseToken);
}

function assertErrorCode(value: string): void {
	if (!STABLE_ERROR_CODE_PATTERN.test(value)) {
		throw new Error("Media usage work error code must use a stable SCREAMING_SNAKE_CASE value");
	}
}

function rowToWork(row: Selectable<MediaUsageWorkTable>): MediaUsageWorkRecord {
	if (!isMediaUsageWorkState(row.state)) {
		throw new Error(`Invalid media usage work state: ${row.state}`);
	}
	return {
		collectionId: row.collection_id,
		collectionSlug: row.collection_slug,
		contentId: row.content_id,
		changeEpoch: row.change_epoch,
		workVersion: row.work_version,
		state: row.state,
		attemptCount: row.attempt_count,
		nextAttemptAt: row.next_attempt_at,
		leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at,
		lastAttemptedAt: row.last_attempted_at,
		lastErrorCode: row.last_error_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowToOperatorWork(
	row: Selectable<MediaUsageWorkTable> | MediaUsageWorkRecord,
): MediaUsageOperatorWorkItem {
	const work = "collection_id" in row ? rowToWork(row) : row;
	return {
		collectionId: work.collectionId,
		collectionSlug: work.collectionSlug,
		contentId: work.contentId,
		state: work.state,
		attemptCount: work.attemptCount,
		nextAttemptAt: work.nextAttemptAt,
		leaseExpiresAt: work.leaseExpiresAt,
		lastAttemptedAt: work.lastAttemptedAt,
		lastErrorCode: work.lastErrorCode,
		updatedAt: work.updatedAt,
	};
}

function isMediaUsageWorkState(value: string): value is MediaUsageWorkState {
	return value === "pending" || value === "retry" || value === "leased" || value === "failed";
}

function compareOperatorWork(a: MediaUsageOperatorWorkItem, b: MediaUsageOperatorWorkItem): number {
	const updated = b.updatedAt.localeCompare(a.updatedAt);
	return updated !== 0 ? updated : b.contentId.localeCompare(a.contentId);
}
