import { sql, type Kysely, type RawBuilder, type Selectable } from "kysely";
import { ulid } from "ulidx";

import { isPostgres } from "../dialect-helpers.js";
import type { Database, MediaUsageWorkTable } from "../types.js";

export type MediaUsageWorkState = "pending" | "retry" | "leased" | "failed";
export type MediaUsageWorkVersion = number | string;
const MAX_PORTABLE_DURATION_SECONDS = 365 * 24 * 60 * 60;
const MAX_WORK_SELECTION_LIMIT = 100;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

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

export class MediaUsageWorkRepository {
	constructor(private db: Kysely<Database>) {}

	async findDueWork(limit: number): Promise<MediaUsageWorkRecord[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORK_SELECTION_LIMIT) {
			throw new Error(
				`Media usage due-work limit must be a whole number from 1 to ${MAX_WORK_SELECTION_LIMIT}`,
			);
		}

		const pendingRows = await this.findDueRows("pending", "next_attempt_at", limit);
		const retryRows = await this.findDueRows("retry", "next_attempt_at", limit);
		const leasedRows = await this.findDueRows("leased", "lease_expires_at", limit);

		return [...pendingRows, ...retryRows, ...leasedRows]
			.map(rowToWork)
			.toSorted(compareDueWork)
			.slice(0, limit);
	}

	private async findDueRows(
		state: "pending" | "retry" | "leased",
		timestampColumn: "next_attempt_at" | "lease_expires_at",
		limit: number,
	): Promise<Selectable<MediaUsageWorkTable>[]> {
		let query = this.db
			.selectFrom("_emdash_media_usage_work")
			.selectAll()
			.where("state", "=", state)
			.where(this.timestampIsDue(timestampColumn))
			.orderBy(timestampColumn, "asc");
		if (timestampColumn === "next_attempt_at") {
			query = query.orderBy("updated_at", "asc");
		}
		return query
			.orderBy("collection_id", "asc")
			.orderBy("content_id", "asc")
			.limit(limit)
			.execute();
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

	async completeWork(input: MediaUsageWorkLease): Promise<boolean> {
		assertLease(input);
		const result = await this.db
			.deleteFrom("_emdash_media_usage_work")
			.where("collection_id", "=", input.collectionId)
			.where("content_id", "=", input.contentId)
			.where("work_version", "=", input.workVersion)
			.where("state", "=", "leased")
			.where("lease_token", "=", input.leaseToken)
			.where(this.leaseIsLive())
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0) > 0;
	}

	async retryWork(
		input: MediaUsageWorkLease & {
			retryDelaySeconds: number;
			errorCode: string;
		},
	): Promise<boolean> {
		const retryDelaySeconds = durationSeconds(input.retryDelaySeconds, "retry delay", true);
		assertErrorCode(input.errorCode);
		return this.transitionFailure(input, "retry", {
			next_attempt_at: this.timestampOffset(retryDelaySeconds),
		});
	}

	async failWork(
		input: MediaUsageWorkLease & {
			errorCode: string;
		},
	): Promise<boolean> {
		assertErrorCode(input.errorCode);
		return this.transitionFailure(input, "failed");
	}

	private async transitionFailure(
		input: MediaUsageWorkLease & { errorCode: string },
		state: "retry" | "failed",
		extra: { next_attempt_at?: RawBuilder<string> } = {},
	): Promise<boolean> {
		assertLease(input);
		const result = await this.db
			.updateTable("_emdash_media_usage_work")
			.set({
				state,
				attempt_count: sql<number>`attempt_count + 1`,
				lease_token: null,
				lease_expires_at: null,
				last_error_code: input.errorCode,
				updated_at: this.timestampOffset(0),
				...extra,
			})
			.where("collection_id", "=", input.collectionId)
			.where("content_id", "=", input.contentId)
			.where("work_version", "=", input.workVersion)
			.where("state", "=", "leased")
			.where("lease_token", "=", input.leaseToken)
			.where(this.leaseIsLive())
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	private leaseIsLive(): RawBuilder<boolean> {
		return isPostgres(this.db)
			? sql<boolean>`lease_expires_at::timestamptz > clock_timestamp()`
			: sql<boolean>`lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private timestampIsDue(column: "next_attempt_at" | "lease_expires_at"): RawBuilder<boolean> {
		return isPostgres(this.db)
			? sql<boolean>`${sql.ref(column)}::timestamptz <= clock_timestamp()`
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

function isMediaUsageWorkState(value: string): value is MediaUsageWorkState {
	return value === "pending" || value === "retry" || value === "leased" || value === "failed";
}

function compareDueWork(a: MediaUsageWorkRecord, b: MediaUsageWorkRecord): number {
	const eligibility = dueTimestamp(a).localeCompare(dueTimestamp(b));
	if (eligibility !== 0) return eligibility;
	const updated = a.updatedAt.localeCompare(b.updatedAt);
	if (updated !== 0) return updated;
	const collection = a.collectionId.localeCompare(b.collectionId);
	return collection !== 0 ? collection : a.contentId.localeCompare(b.contentId);
}

function dueTimestamp(work: MediaUsageWorkRecord): string {
	if (work.state !== "leased") return work.nextAttemptAt;
	if (!work.leaseExpiresAt) throw new Error("Due leased media usage work must have a lease expiry");
	return work.leaseExpiresAt;
}
