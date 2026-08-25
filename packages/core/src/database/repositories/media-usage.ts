import {
	sql,
	type ExpressionBuilder,
	type Kysely,
	type RawBuilder,
	type Selectable,
	type Transaction,
	type Updateable,
} from "kysely";
import { ulid } from "ulidx";

import { isMediaUsageProjectionFingerprint } from "../../media/usage/projection-fingerprint.js";
import type { MediaUsageContentSourceVariant } from "../../media/usage/source-key.js";
import type { MediaKind, MediaUsageReferenceType } from "../../media/usage/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { isPostgres } from "../dialect-helpers.js";
import { withTransaction } from "../transaction.js";
import type {
	Database,
	MediaUsageIndexStatusTable,
	MediaUsageSourceTable,
	MediaUsageTable,
} from "../types.js";
import { validateIdentifier } from "../validate.js";
import { decodeCursor, encodeCursor, InvalidCursorError, type FindManyResult } from "./types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;
type MediaUsageSourceNullableStringColumn =
	| "collection_id"
	| "source_fingerprint"
	| "source_updated_at"
	| "revision_id"
	| "updated_at"
	| "last_attempted_at"
	| "last_error_code";
const OCCURRENCE_BIND_COLUMNS = 13;
export const MEDIA_USAGE_GENERATION_WRITE_LEASE_MS = 60 * 60 * 1000;
const OCCURRENCE_INSERT_BATCH_SIZE = Math.max(
	1,
	Math.floor(SQL_BATCH_SIZE / OCCURRENCE_BIND_COLUMNS),
);

function cleanupDeleteBatchSize(cleanupLease: MediaUsageCleanupLease | undefined): number {
	return cleanupLease ? SQL_BATCH_SIZE - 3 : SQL_BATCH_SIZE;
}

function canIssueCleanupStatement(canIssueStatement: (() => boolean) | undefined): boolean {
	return canIssueStatement?.() ?? true;
}

function cleanupDurationSeconds(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("Media usage cleanup duration must be a non-negative whole number of seconds");
	}
	return value;
}

const CONTENT_SOURCE_ELIGIBILITY = sql<boolean>`(
	s.source_variant = 'draft_overlay'
	OR (
		s.source_variant = 'columns'
		AND (
			s.content_status = 'published'
			OR NOT EXISTS (
				SELECT 1
				FROM _emdash_media_usage_sources AS overlay
				WHERE overlay.source_type = 'content'
					AND overlay.collection_slug = s.collection_slug
					AND overlay.content_id = s.content_id
					AND overlay.source_variant = 'draft_overlay'
					AND ${contentSourceMatchesActiveCollection("overlay", "s.collection_id")}
			)
		)
	)
)`;

type ContentSourceAlias = "deleted_source" | "overlay" | "s" | "state";
type CurrentCollectionIdReference = "collection.id" | "page.collection_id" | "s.collection_id";

function contentSourceMatchesActiveCollection(
	source: ContentSourceAlias,
	currentCollectionId: CurrentCollectionIdReference,
): RawBuilder<boolean> {
	return sql<boolean>`(
		NOT EXISTS (
			SELECT 1
			FROM _emdash_media_usage_activation AS activation
			WHERE activation.task_key = 'incremental_capture'
				AND activation.state = 'active'
		)
		OR (
			${sql.ref(`${source}.collection_id`)} = ${sql.ref(currentCollectionId)}
			AND ${sql.ref(`${source}.identity_version`)} = 1
		)
	)`;
}

export interface MediaUsageSourceInput {
	sourceKey: string;
	sourceType: string;
	collectionId?: string | null;
	collectionSlug?: string | null;
	contentId?: string | null;
	sourceVariant: MediaUsageContentSourceVariant;
	locale?: string | null;
	translationGroup?: string | null;
	contentSlug?: string | null;
	contentTitle?: string | null;
	contentStatus?: string | null;
	contentScheduledAt?: string | null;
	contentDeletedAt?: string | null;
	revisionId?: string | null;
	schemaVersion?: number;
	sourceUpdatedAt?: string | null;
	sourceVersion?: number | null;
	sourceFingerprint?: string | null;
	identityVersion?: number | null;
	sourceCompleteness?: MediaUsageSourceCompleteness;
	lastAttemptedAt?: string | null;
	lastErrorCode?: string | null;
}

export interface MediaUsageOccurrenceInput {
	fieldSlug: string;
	fieldPath: string;
	occurrenceIndex?: number;
	referenceType: MediaUsageReferenceType;
	mediaId: string | null;
	provider: string;
	providerAssetId: string;
	mediaKind?: MediaKind | null;
	mimeType?: string | null;
}

export interface MediaUsageSource {
	sourceKey: string;
	sourceType: string;
	collectionId: string | null;
	collectionSlug: string | null;
	contentId: string | null;
	sourceVariant: string;
	locale: string | null;
	translationGroup: string | null;
	contentSlug: string | null;
	contentTitle: string | null;
	contentStatus: string | null;
	contentScheduledAt: string | null;
	contentDeletedAt: string | null;
	revisionId: string | null;
	currentGeneration: string;
	schemaVersion: number;
	sourceUpdatedAt: string | null;
	sourceVersion: number | null;
	sourceFingerprint: string | null;
	identityVersion: number | null;
	sourceCompleteness: string;
	lastAttemptedAt: string | null;
	lastErrorCode: string | null;
	indexedAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface MediaUsageGuardedReplaceResult {
	replaced: boolean;
	unchanged: boolean;
	/** Populated only when a guarded replacement did not win the current source row. */
	source: MediaUsageSource | null;
}

export interface MediaUsageGuardedDeleteResult {
	deleted: boolean;
	source: MediaUsageSource | null;
}

export interface MediaUsageGuardedAbsentDeleteResult extends MediaUsageGuardedDeleteResult {
	contentPresent: boolean;
}

export interface MediaUsageGuardedAttemptResult {
	attempted: boolean;
	/** Populated only when a guarded attempted mark did not win the current source row. */
	source: MediaUsageSource | null;
}

export interface MediaUsageSourceGenerationDeletionMeasurement {
	occurrenceCount: number;
	occurrenceBytes: number;
	exceedsOccurrenceLimit: boolean;
}

export interface MediaUsageCleanupCursor {
	createdAt: string;
	id: string;
}

export interface MediaUsageCleanupClaim {
	leaseToken: string;
	cursor: MediaUsageCleanupCursor | null;
	claimedAt: string;
	scanBeforeAt: string;
	consecutiveFailures: number;
}

export interface MediaUsageCleanupCandidate {
	id: string;
	sourceKey: string;
	generation: string;
	createdAt: string;
	currentGeneration: string | null;
	indexedAt: string | null;
	writeLeaseExpiresAt: string | null;
}

export interface MediaUsageCleanupLease {
	leaseToken: string;
}

export interface MediaUsageCleanupDeleteOptions {
	candidateIds?: readonly string[];
	cleanupLease?: MediaUsageCleanupLease;
	canIssueStatement?: () => boolean;
}

export interface MediaUsageCleanupCompletion {
	leaseToken: string;
	nextCursor: MediaUsageCleanupCursor | null;
	sweepComplete: boolean;
	candidateCount: number;
	deletedOrphans: number;
	deletedStale: number;
	deletedAbandoned: number;
	deletedWriteLeases: number;
	backlogLowerBound: number;
	scanHasMore: boolean;
	durationMs: number;
}

export interface MediaUsageIndexStatusRepairInput extends MediaUsageIndexStatusIdentity {
	runToken: string;
	schemaVersion?: number;
	startedAt: string;
	updatedAt?: string;
}

export interface MediaUsageIndexStatusFinalizeInput extends MediaUsageIndexStatusIdentity {
	runToken: string;
	status: Exclude<MediaUsageIndexStatusValue, "never" | "running" | "stale">;
	schemaVersion?: number;
	completedAt: string;
	indexedSourceCount?: number;
	failedSourceCount?: number;
	lastErrorCode?: string | null;
	updatedAt?: string;
}

export interface MediaUsageIndexStatusEpochRepairInput extends MediaUsageIndexStatusIdentity {
	collectionId: string;
	runToken: string;
	schemaVersion: number;
}

export interface MediaUsageIndexStatusEpochRepairRun {
	changeEpoch: number | string;
	startedAt: string;
}

export interface MediaUsageIndexStatusEpochFinalizeInput extends MediaUsageIndexStatusEpochRepairInput {
	startingEpoch: number | string;
	status: Exclude<MediaUsageIndexStatusValue, "never" | "running" | "stale">;
	indexedSourceCount: number;
	failedSourceCount: number;
	lastErrorCode: string | null;
}

export interface MediaUsageIncrementalStatusIdentity {
	collectionId: string;
	collectionSlug: string;
}

export interface MediaUsageGuardedIndexStatusResult {
	finalized: boolean;
	status: MediaUsageIndexStatus | null;
}

export type MediaUsageSourceCompleteness =
	| "unknown"
	| "complete"
	| "partial"
	| "failed"
	| "unsupported";

export type MediaUsageIndexStatusValue =
	| "never"
	| "running"
	| "complete"
	| "partial"
	| "failed"
	| "stale";

export interface MediaUsageIndexStatusIdentity {
	adapterId: string;
	scopeType: string;
	scopeKey: string;
}

export interface MediaUsageIndexStatusInput extends MediaUsageIndexStatusIdentity {
	status: MediaUsageIndexStatusValue;
	schemaVersion?: number;
	startedAt?: string | null;
	completedAt?: string | null;
	cursor?: string | null;
	indexedSourceCount?: number;
	failedSourceCount?: number;
	lastErrorCode?: string | null;
	updatedAt?: string;
}

export interface MediaUsageIndexStatus extends MediaUsageIndexStatusIdentity {
	status: string;
	schemaVersion: number;
	startedAt: string | null;
	completedAt: string | null;
	cursor: string | null;
	indexedSourceCount: number;
	failedSourceCount: number;
	lastErrorCode: string | null;
	updatedAt: string;
}

export interface FindMediaUsageOptions {
	limit?: number;
	cursor?: string;
}

export interface MediaUsageCollectionIndexStatusScope {
	collectionSlug: string;
	status: string | null;
	schemaVersion: number | null;
	reconciliationRequired: boolean;
}

export interface MediaUsageEntrySource {
	source: MediaUsageSource;
	occurrences: MediaUsageOccurrence[];
}

export interface MediaUsageEntryGroup {
	collectionSlug: string;
	contentId: string;
	contentDeletedAt: string | null;
	sources: MediaUsageEntrySource[];
}

interface MediaUsageSourceRow {
	source_key: string;
	source_type: string;
	collection_id: string | null;
	collection_slug: string | null;
	content_id: string | null;
	source_variant: string;
	locale: string | null;
	translation_group: string | null;
	content_slug: string | null;
	content_title: string | null;
	content_status: string | null;
	content_scheduled_at: string | null;
	content_deleted_at: string | null;
	revision_id: string | null;
	current_generation: string;
	schema_version: number;
	source_updated_at: string | null;
	source_version: number | null;
	source_fingerprint: string | null;
	identity_version: number | null;
	source_completeness: string;
	last_attempted_at: string | null;
	last_error_code: string | null;
	indexed_at: string;
	created_at: string;
	updated_at: string;
}

export interface MediaUsageOccurrence {
	id: string;
	sourceKey: string;
	generation: string;
	fieldSlug: string;
	fieldPath: string;
	occurrenceIndex: number;
	referenceType: string;
	mediaId: string | null;
	provider: string;
	providerAssetId: string;
	mediaKind: string | null;
	mimeType: string | null;
	createdAt: string;
}

export interface MediaUsageRecord {
	source: MediaUsageSource;
	occurrence: MediaUsageOccurrence;
}

interface JoinedUsageRow {
	source_key: string;
	source_type: string;
	collection_id: string | null;
	collection_slug: string | null;
	content_id: string | null;
	source_variant: string;
	locale: string | null;
	translation_group: string | null;
	content_slug: string | null;
	content_title: string | null;
	content_status: string | null;
	content_scheduled_at: string | null;
	content_deleted_at: string | null;
	revision_id: string | null;
	current_generation: string;
	schema_version: number;
	source_updated_at: string | null;
	source_version: number | null;
	source_fingerprint: string | null;
	identity_version: number | null;
	source_completeness: string;
	last_attempted_at: string | null;
	last_error_code: string | null;
	indexed_at: string;
	source_created_at: string;
	source_row_updated_at: string;
	occurrence_id: string;
	generation: string;
	field_slug: string;
	field_path: string;
	occurrence_index: number;
	reference_type: string;
	media_id: string | null;
	provider: string;
	provider_asset_id: string;
	media_kind: string | null;
	mime_type: string | null;
	occurrence_created_at: string;
}

interface GroupedUsageRow extends JoinedUsageRow {
	entry_deleted_at: string | null;
	has_more: number;
}

/** Persistence-only repository for the internal media usage projection tables. */
export class MediaUsageRepository {
	constructor(private db: Kysely<Database>) {}

	async replaceSource(
		source: MediaUsageSourceInput,
		occurrences: readonly MediaUsageOccurrenceInput[],
	): Promise<MediaUsageSource> {
		const generation = ulid();

		const admitted = await this.withGenerationWriteLease(
			source,
			generation,
			async (leaseToken, now) => {
				await withTransaction(this.db, async (trx) => {
					if (!(await this.lockCanonicalSourceCollection(trx, source))) {
						throw new Error(`Media usage collection is no longer current for ${source.sourceKey}`);
					}
					await this.insertOccurrences(trx, source.sourceKey, generation, occurrences, now);
					const promoted = await this.upsertSource(trx, source, generation, now, leaseToken);
					if (!promoted) {
						throw new Error(`Media usage generation lease expired for ${source.sourceKey}`);
					}
				});
			},
		);
		if (!admitted) {
			throw new Error(`Media usage collection is no longer current for ${source.sourceKey}`);
		}

		const replaced = await this.findSource(source.sourceKey);
		if (!replaced) {
			throw new Error(`Media usage source ${source.sourceKey} was not persisted`);
		}
		return replaced;
	}
	async replaceSourceIfCurrent(
		source: MediaUsageSourceInput,
		occurrences: readonly MediaUsageOccurrenceInput[],
		expectedCurrentGeneration: string | null,
	): Promise<MediaUsageGuardedReplaceResult> {
		if (
			expectedCurrentGeneration !== null &&
			(await this.projectionMatchesCurrentGeneration(source, expectedCurrentGeneration))
		) {
			return { replaced: false, unchanged: true, source: null };
		}
		const generation = ulid();
		let replaced = false;

		await this.withGenerationWriteLease(source, generation, async (leaseToken, now) => {
			const row = this.buildSourceRow(source, generation, now);
			await withTransaction(this.db, async (trx) => {
				if (!(await this.lockCanonicalSourceCollection(trx, source))) return;
				await this.insertOccurrences(trx, source.sourceKey, generation, occurrences, now);
				if (expectedCurrentGeneration === null) {
					replaced = await this.insertSourceIfAbsent(trx, row, leaseToken);
					return;
				}
				replaced = await this.updateSourceIfGeneration(
					trx,
					row,
					expectedCurrentGeneration,
					leaseToken,
				);
			});
		});

		return {
			replaced,
			unchanged: false,
			source: replaced ? null : await this.findSource(source.sourceKey),
		};
	}

	async findSource(sourceKey: string): Promise<MediaUsageSource | null> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_sources")
			.selectAll()
			.where("source_key", "=", sourceKey)
			.executeTakeFirst();

		return row ? rowToSource(row) : null;
	}

	async findSources(sourceKeys: readonly string[]): Promise<Map<string, MediaUsageSource>> {
		const uniqueSourceKeys = [...new Set(sourceKeys)];
		const sources = new Map<string, MediaUsageSource>();
		if (uniqueSourceKeys.length === 0) return sources;

		for (const sourceKeyBatch of chunks(uniqueSourceKeys, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_media_usage_sources")
				.selectAll()
				.where("source_key", "in", sourceKeyBatch)
				.execute();
			for (const row of rows) {
				const source = rowToSource(row);
				sources.set(source.sourceKey, source);
			}
		}

		return sources;
	}

	async measureSourceGenerationDeletion(
		sourceKey: string,
		generation: string,
		maxOccurrences: number,
	): Promise<MediaUsageSourceGenerationDeletionMeasurement> {
		if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences < 0) {
			throw new Error("Media usage deletion measurement requires a non-negative row limit");
		}
		const payload = sql<string>`
			COALESCE(field_slug, '') || COALESCE(field_path, '') ||
			COALESCE(reference_type, '') || COALESCE(media_id, '') ||
			COALESCE(provider, '') || COALESCE(provider_asset_id, '') ||
			COALESCE(media_kind, '') || COALESCE(mime_type, '')
		`;
		const occurrenceBytes = isPostgres(this.db)
			? sql<number>`octet_length(${payload})`
			: sql<number>`length(CAST(${payload} AS BLOB))`;
		const rows = await this.db
			.selectFrom("_emdash_media_usage")
			.select(occurrenceBytes.as("occurrence_bytes"))
			.where("source_key", "=", sourceKey)
			.where("generation", "=", generation)
			.limit(maxOccurrences + 1)
			.execute();

		return {
			occurrenceCount: rows.length,
			occurrenceBytes: rows.reduce((total, row) => total + Number(row.occurrence_bytes), 0),
			exceedsOccurrenceLimit: rows.length > maxOccurrences,
		};
	}

	async replaceSourceIfMatching(
		source: MediaUsageSourceInput,
		occurrences: readonly MediaUsageOccurrenceInput[],
		expectedSource: MediaUsageSource | null,
	): Promise<MediaUsageGuardedReplaceResult> {
		if (
			expectedSource !== null &&
			(await this.projectionMatchesExpectedSource(source, expectedSource))
		) {
			return { replaced: false, unchanged: true, source: null };
		}
		const generation = ulid();
		let replaced = false;

		await this.withGenerationWriteLease(source, generation, async (leaseToken, now) => {
			const row = this.buildSourceRow(source, generation, now);
			await withTransaction(this.db, async (trx) => {
				if (!(await this.lockCanonicalSourceCollection(trx, source))) return;
				await this.insertOccurrences(trx, source.sourceKey, generation, occurrences, now);
				if (expectedSource === null) {
					replaced = await this.insertSourceIfAbsent(trx, row, leaseToken);
					return;
				}
				replaced = await this.updateSourceIfMatching(trx, row, expectedSource, leaseToken);
			});
		});

		return {
			replaced,
			unchanged: false,
			source: replaced ? null : await this.findSource(source.sourceKey),
		};
	}

	async markSourceAttempted(source: MediaUsageSourceInput): Promise<MediaUsageSource> {
		if (source.collectionId !== undefined && source.collectionId !== null) {
			const expectedSource = await this.findSource(source.sourceKey);
			const result = await this.markSourceAttemptedIfMatching(source, expectedSource);
			if (!result.attempted) {
				throw new Error(`Canonical media usage source ${source.sourceKey} is no longer current`);
			}
			const attempted = await this.findSource(source.sourceKey);
			if (!attempted) {
				throw new Error(`Media usage source ${source.sourceKey} was not persisted`);
			}
			return attempted;
		}

		const generation = ulid();
		await this.withGenerationWriteLease(source, generation, async (leaseToken, now) => {
			const row = this.buildAttemptedSourceRow(source, generation, now);
			const updates = this.attemptedSourceUpdateSet(source, row);
			const result = await this.db
				.insertInto("_emdash_media_usage_sources")
				.values(row)
				.onConflict((oc) => oc.column("source_key").doUpdateSet(updates))
				.executeTakeFirst();
			if ((result.numInsertedOrUpdatedRows ?? 0n) <= 0n) {
				throw new Error(`Media usage generation lease expired for ${source.sourceKey}`);
			}
		});

		const attempted = await this.findSource(source.sourceKey);
		if (!attempted) {
			throw new Error(`Media usage source ${source.sourceKey} was not persisted`);
		}
		return attempted;
	}

	async markSourceAttemptedIfMatching(
		source: MediaUsageSourceInput,
		expectedSource: MediaUsageSource | null,
	): Promise<MediaUsageGuardedAttemptResult> {
		const generation = ulid();
		let attempted = false;

		if (expectedSource === null) {
			await this.withGenerationWriteLease(source, generation, async (leaseToken, now) => {
				const row = this.buildAttemptedSourceRow(source, generation, now);
				await withTransaction(this.db, async (trx) => {
					if (!(await this.lockCanonicalSourceCollection(trx, source))) return;
					attempted = await this.persistSourceIfWriteLease(
						trx,
						row,
						leaseToken,
						sql`ON CONFLICT (source_key) DO NOTHING`,
					);
				});
			});
		} else {
			const row = this.buildAttemptedSourceRow(source, generation, new Date().toISOString());
			await withTransaction(this.db, async (trx) => {
				if (!(await this.lockCanonicalSourceCollection(trx, source))) return;
				attempted = await this.updateAttemptedSourceIfMatching(trx, source, row, expectedSource);
			});
		}

		return {
			attempted,
			source: attempted ? null : await this.findSource(source.sourceKey),
		};
	}

	async findActiveEntryCountsByMediaIds(mediaIds: readonly string[]): Promise<Map<string, number>> {
		const uniqueMediaIds = [...new Set(mediaIds)];
		const counts = new Map(uniqueMediaIds.map((mediaId) => [mediaId, 0]));

		for (const mediaIdBatch of chunks(uniqueMediaIds, SQL_BATCH_SIZE)) {
			const visibleEntries = this.currentContentMediaUsageBaseQuery()
				.select([
					"u.media_id as media_id",
					"s.collection_slug as collection_slug",
					"s.content_id as content_id",
				])
				.where("u.media_id", "in", mediaIdBatch)
				.where((eb) =>
					eb.not(
						eb.exists(
							eb
								.selectFrom("_emdash_media_usage_sources as deleted_source")
								.select("deleted_source.source_key")
								.where("deleted_source.source_type", "=", "content")
								.whereRef("deleted_source.collection_slug", "=", "s.collection_slug")
								.whereRef("deleted_source.content_id", "=", "s.content_id")
								.where("deleted_source.source_variant", "in", ["columns", "draft_overlay"])
								.where(contentSourceMatchesActiveCollection("deleted_source", "collection.id"))
								.where("deleted_source.content_deleted_at", "is not", null),
						),
					),
				)
				.distinct()
				.as("visible_entries");

			const rows = await this.db
				.selectFrom(visibleEntries)
				.select("media_id")
				.select((eb) => eb.fn.countAll<number>().as("usage_count"))
				.groupBy("media_id")
				.execute();

			for (const row of rows) {
				if (row.media_id !== null) counts.set(row.media_id, Number(row.usage_count));
			}
		}

		return counts;
	}

	async findCollectionIndexStatusScopes(
		identity: Pick<MediaUsageIndexStatusIdentity, "adapterId" | "scopeType">,
	): Promise<MediaUsageCollectionIndexStatusScope[]> {
		const rows = await this.db
			.selectFrom("_emdash_collections as collection")
			.leftJoin("_emdash_media_usage_index_status as status", (join) =>
				join
					.on("status.adapter_id", "=", identity.adapterId)
					.on("status.scope_type", "=", identity.scopeType)
					.onRef("status.scope_key", "=", "collection.slug"),
			)
			.select([
				"collection.slug as collection_slug",
				"status.status as status",
				"status.schema_version as schema_version",
				"status.reconciliation_required as reconciliation_required",
			])
			.orderBy("collection.slug", "asc")
			.execute();

		return rows.map((row) => ({
			collectionSlug: row.collection_slug,
			status: row.status,
			schemaVersion: row.schema_version === null ? null : Number(row.schema_version),
			reconciliationRequired:
				row.reconciliation_required !== null && Number(row.reconciliation_required) !== 0,
		}));
	}

	async findCurrentEntryUsagePageByMediaId(
		mediaId: string,
		options: FindMediaUsageOptions = {},
	): Promise<FindManyResult<MediaUsageEntryGroup>> {
		const requestedLimit = Math.floor(options.limit ?? 50);
		const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(1, requestedLimit), 100) : 50;
		const cursor = options.cursor ? decodeCursor(options.cursor) : null;
		if (cursor && (cursor.orderValue.length === 0 || cursor.id.length === 0)) {
			throw new InvalidCursorError(options.cursor ?? "");
		}
		let matchedGroups = this.currentContentMediaUsageBaseQuery()
			.select([
				"collection.id as collection_id",
				"s.collection_slug as collection_slug",
				"s.content_id as content_id",
			])
			.where("u.media_id", "=", mediaId)
			.distinct();
		if (cursor) {
			matchedGroups = matchedGroups.where((eb) =>
				eb.or([
					eb("s.collection_slug", ">", cursor.orderValue),
					eb.and([
						eb("s.collection_slug", "=", cursor.orderValue),
						eb("s.content_id", ">", cursor.id),
					]),
				]),
			);
		}
		matchedGroups = matchedGroups
			.orderBy("s.collection_slug", "asc")
			.orderBy("s.content_id", "asc")
			.limit(limit + 1);

		const rows: GroupedUsageRow[] = await this.db
			.with("matched_groups", () => matchedGroups)
			.with("page_groups", (db) =>
				db
					.selectFrom("matched_groups")
					.selectAll()
					.orderBy("collection_slug", "asc")
					.orderBy("content_id", "asc")
					.limit(limit),
			)
			.with("entry_state", (db) =>
				db
					.selectFrom("page_groups as page")
					.crossJoin("_emdash_media_usage_sources as state")
					.select(["page.collection_id", "page.collection_slug", "page.content_id"])
					.select((eb) =>
						eb.fn.max<string | null>("state.content_deleted_at").as("entry_deleted_at"),
					)
					.whereRef("page.collection_slug", "=", "state.collection_slug")
					.whereRef("page.content_id", "=", "state.content_id")
					.where("state.source_type", "=", "content")
					.where("state.source_variant", "in", ["columns", "draft_overlay"])
					.where(contentSourceMatchesActiveCollection("state", "page.collection_id"))
					.groupBy(["page.collection_id", "page.collection_slug", "page.content_id"]),
			)
			.selectFrom("entry_state as page")
			.crossJoin("_emdash_media_usage_sources as s")
			.crossJoin("_emdash_media_usage as u")
			.whereRef("page.collection_slug", "=", "s.collection_slug")
			.whereRef("page.content_id", "=", "s.content_id")
			.where(contentSourceMatchesActiveCollection("s", "page.collection_id"))
			.whereRef("s.source_key", "=", "u.source_key")
			.whereRef("s.current_generation", "=", "u.generation")
			.select(currentUsageSelect)
			.select("page.entry_deleted_at")
			.select(
				sql<number>`CASE
					WHEN (SELECT COUNT(*) FROM matched_groups) > ${limit} THEN 1
					ELSE 0
				END`.as("has_more"),
			)
			.where("u.media_id", "=", mediaId)
			.where("s.source_type", "=", "content")
			.where("s.collection_slug", "is not", null)
			.where("s.content_id", "is not", null)
			.where("s.source_variant", "in", ["columns", "draft_overlay"])
			.where(CONTENT_SOURCE_ELIGIBILITY)
			.orderBy("s.collection_slug", "asc")
			.orderBy("s.content_id", "asc")
			.orderBy("s.source_variant", "asc")
			.orderBy("s.source_key", "asc")
			.orderBy("u.field_path", "asc")
			.orderBy("u.occurrence_index", "asc")
			.orderBy("u.id", "asc")
			.execute();

		const items = groupUsageRows(rows);
		const result: FindManyResult<MediaUsageEntryGroup> = { items };
		if (Number(rows[0]?.has_more ?? 0) === 1 && items.length > 0) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.collectionSlug, last.contentId);
		}
		return result;
	}

	async findCurrentUsageByMediaId(mediaId: string): Promise<MediaUsageRecord[]> {
		const rows = await this.db
			.selectFrom("_emdash_media_usage_sources as s")
			.innerJoin("_emdash_media_usage as u", (join) =>
				join
					.onRef("u.source_key", "=", "s.source_key")
					.onRef("u.generation", "=", "s.current_generation"),
			)
			.select(currentUsageSelect)
			.where("u.media_id", "=", mediaId)
			.orderBy("s.source_key", "asc")
			.orderBy("u.field_path", "asc")
			.orderBy("u.occurrence_index", "asc")
			.execute();

		return rows.map(rowToUsageRecord);
	}

	async findCurrentUsageByProviderAsset(
		provider: string,
		providerAssetId: string,
	): Promise<MediaUsageRecord[]> {
		const rows = await this.db
			.selectFrom("_emdash_media_usage_sources as s")
			.innerJoin("_emdash_media_usage as u", (join) =>
				join
					.onRef("u.source_key", "=", "s.source_key")
					.onRef("u.generation", "=", "s.current_generation"),
			)
			.select(currentUsageSelect)
			.where("u.provider", "=", provider)
			.where("u.provider_asset_id", "=", providerAssetId)
			.orderBy("s.source_key", "asc")
			.orderBy("u.field_path", "asc")
			.orderBy("u.occurrence_index", "asc")
			.execute();

		return rows.map(rowToUsageRecord);
	}

	async findCurrentUsagePageByMediaId(
		mediaId: string,
		options: FindMediaUsageOptions = {},
	): Promise<FindManyResult<MediaUsageRecord>> {
		return this.findCurrentUsagePage((query) => query.where("u.media_id", "=", mediaId), options);
	}

	async findCurrentUsagePageByProviderAsset(
		provider: string,
		providerAssetId: string,
		options: FindMediaUsageOptions = {},
	): Promise<FindManyResult<MediaUsageRecord>> {
		return this.findCurrentUsagePage(
			(query) =>
				query.where("u.provider", "=", provider).where("u.provider_asset_id", "=", providerAssetId),
			options,
		);
	}

	async deleteSource(sourceKey: string): Promise<number> {
		return this.deleteSources([sourceKey]);
	}

	async deleteSourceIfCurrent(
		sourceKey: string,
		expectedCurrentGeneration: string,
	): Promise<MediaUsageGuardedDeleteResult> {
		let deleted = false;
		await withTransaction(this.db, async (trx) => {
			await this.lockCleanupBeforeSourceDelete(trx);
			const result = await trx
				.deleteFrom("_emdash_media_usage_sources")
				.where("source_key", "=", sourceKey)
				.where("current_generation", "=", expectedCurrentGeneration)
				.executeTakeFirst();
			deleted = Number(result.numDeletedRows ?? 0) > 0;
			if (!deleted) return;
			await this.deleteSourceGenerationOccurrences(trx, sourceKey, expectedCurrentGeneration);
		});

		return {
			deleted,
			source: await this.findSource(sourceKey),
		};
	}

	async deleteSourceIfMatching(
		sourceKey: string,
		expectedSource: MediaUsageSource,
	): Promise<MediaUsageGuardedDeleteResult> {
		let deleted = false;
		await withTransaction(this.db, async (trx) => {
			await this.lockCleanupBeforeSourceDelete(trx);
			const result = await trx
				.deleteFrom("_emdash_media_usage_sources")
				.where("source_key", "=", sourceKey)
				.where(this.sourceMatchExpression(expectedSource))
				.where(
					this.currentCollectionExists(expectedSource.collectionId, expectedSource.collectionSlug),
				)
				.executeTakeFirst();
			deleted = Number(result.numDeletedRows ?? 0) > 0;
			if (!deleted) return;
			await this.deleteSourceGenerationOccurrences(
				trx,
				sourceKey,
				expectedSource.currentGeneration,
			);
		});

		return {
			deleted,
			source: await this.findSource(sourceKey),
		};
	}

	async deleteSourceIfMatchingContentAbsent(
		sourceKey: string,
		expectedSource: MediaUsageSource,
		collectionSlug: string,
		contentId: string,
	): Promise<MediaUsageGuardedAbsentDeleteResult> {
		validateIdentifier(collectionSlug, "collection slug");
		const tableName = `ec_${collectionSlug}`;
		let deleted = false;
		await withTransaction(this.db, async (trx) => {
			await this.lockCleanupBeforeSourceDelete(trx);
			const result = await trx
				.deleteFrom("_emdash_media_usage_sources")
				.where("source_key", "=", sourceKey)
				.where(this.sourceMatchExpression(expectedSource))
				.where(
					this.currentCollectionExists(expectedSource.collectionId, expectedSource.collectionSlug),
				)
				.where(
					sql<boolean>`NOT EXISTS (SELECT 1 FROM ${sql.ref(tableName)} WHERE id = ${contentId})`,
				)
				.executeTakeFirst();
			deleted = Number(result.numDeletedRows ?? 0) > 0;
			if (!deleted) return;
			await this.deleteSourceGenerationOccurrences(
				trx,
				sourceKey,
				expectedSource.currentGeneration,
			);
		});
		const contentPresent = deleted ? false : await this.contentRowExists(tableName, contentId);

		return {
			deleted,
			contentPresent,
			source: deleted || contentPresent ? null : await this.findSource(sourceKey),
		};
	}

	async deleteSources(sourceKeys: readonly string[]): Promise<number> {
		return this.deleteSourceKeys(sourceKeys);
	}

	async deleteContentSources(collectionSlug: string, contentId: string): Promise<number> {
		const sourceRows = await this.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("source_type", "=", "content")
			.where("collection_slug", "=", collectionSlug)
			.where("content_id", "=", contentId)
			.execute();
		const sourceKeys = sourceRows.map((row) => row.source_key);
		return this.deleteSourceKeys(sourceKeys);
	}

	async deleteCollectionSources(collectionSlug: string): Promise<number> {
		let deleted = 0;
		while (true) {
			const sourceRows = await this.db
				.selectFrom("_emdash_media_usage_sources")
				.select("source_key")
				.where("source_type", "=", "content")
				.where("collection_slug", "=", collectionSlug)
				.orderBy("source_key", "asc")
				.limit(SQL_BATCH_SIZE)
				.execute();
			if (sourceRows.length === 0) break;

			deleted += await this.deleteSourceKeys(sourceRows.map((row) => row.source_key));
		}
		return deleted;
	}

	async findCollectionContentSources(
		collectionSlug: string,
		collectionId?: string,
	): Promise<MediaUsageSource[]> {
		let query = this.db
			.selectFrom("_emdash_media_usage_sources")
			.selectAll()
			.where("source_type", "=", "content")
			.where("collection_slug", "=", collectionSlug)
			.orderBy("source_key", "asc");
		if (collectionId !== undefined) query = query.where("collection_id", "=", collectionId);
		const rows = await query.execute();
		return rows.map((row) => rowToSource(row));
	}

	async claimMediaUsageCleanup(input: {
		leaseToken: string;
		leaseDurationSeconds: number;
		nextEligibleDelaySeconds: number;
		sweepSafetyWindowSeconds: number;
	}): Promise<MediaUsageCleanupClaim | null> {
		const leaseDurationSeconds = cleanupDurationSeconds(input.leaseDurationSeconds);
		const nextEligibleDelaySeconds = cleanupDurationSeconds(input.nextEligibleDelaySeconds);
		const sweepSafetyWindowSeconds = cleanupDurationSeconds(input.sweepSafetyWindowSeconds);
		const claimedAt = this.cleanupTimestampOffset(0);
		const leaseExpiresAt = this.cleanupTimestampOffset(leaseDurationSeconds);
		const nextEligibleAt = this.cleanupTimestampOffset(nextEligibleDelaySeconds);
		const sweepBeforeAt = this.cleanupTimestampOffset(-sweepSafetyWindowSeconds);
		const row = await this.db
			.updateTable("_emdash_media_usage_cleanup")
			.set({
				lease_token: input.leaseToken,
				lease_expires_at: leaseExpiresAt,
				next_eligible_at: nextEligibleAt,
				last_started_at: claimedAt,
				updated_at: claimedAt,
				scan_before_at: sql<string>`CASE
					WHEN scan_before_at IS NULL THEN ${sweepBeforeAt}
					ELSE scan_before_at
				END`,
			})
			.where("task_key", "=", "projection_gc")
			.where(this.cleanupTimestampIsDue("next_eligible_at"))
			.where((eb) =>
				eb.or([eb("lease_token", "is", null), this.cleanupTimestampIsDue("lease_expires_at")]),
			)
			.returning([
				"cursor_created_at",
				"cursor_id",
				"last_started_at",
				"scan_before_at",
				"consecutive_failures",
			])
			.executeTakeFirst();
		if (!row) return null;
		if (!row.last_started_at || !row.scan_before_at) {
			throw new Error("Media usage cleanup claim did not persist its database timestamps");
		}
		return {
			leaseToken: input.leaseToken,
			cursor:
				row.cursor_created_at && row.cursor_id
					? { createdAt: row.cursor_created_at, id: row.cursor_id }
					: null,
			claimedAt: row.last_started_at,
			scanBeforeAt: row.scan_before_at,
			consecutiveFailures: row.consecutive_failures,
		};
	}

	async findMediaUsageCleanupCandidates(input: {
		cutoff: string;
		cursor: MediaUsageCleanupCursor | null;
		limit: number;
		cleanupLease?: MediaUsageCleanupLease;
	}): Promise<MediaUsageCleanupCandidate[]> {
		let query = this.db
			.selectFrom("_emdash_media_usage as u")
			.leftJoin("_emdash_media_usage_sources as s", "s.source_key", "u.source_key")
			.leftJoin("_emdash_media_usage_generation_writes as writer", (join) =>
				join
					.onRef("writer.source_key", "=", "u.source_key")
					.onRef("writer.generation", "=", "u.generation"),
			)
			.select([
				"u.id as id",
				"u.source_key as source_key",
				"u.generation as generation",
				"u.created_at as created_at",
				"s.current_generation as current_generation",
				"s.indexed_at as indexed_at",
				"writer.expires_at as write_lease_expires_at",
			])
			.where("u.created_at", "<", input.cutoff)
			.orderBy("u.created_at", "asc")
			.orderBy("u.id", "asc")
			.limit(Math.max(0, Math.floor(input.limit)));
		if (input.cleanupLease) {
			query = query.where(this.activeCleanupLeaseExpression(input.cleanupLease));
		}

		if (input.cursor) {
			query = query.where((eb) =>
				eb.or([
					eb("u.created_at", ">", input.cursor!.createdAt),
					eb.and([
						eb("u.created_at", "=", input.cursor!.createdAt),
						eb("u.id", ">", input.cursor!.id),
					]),
				]),
			);
		}

		const rows = await query.execute();
		return rows.map((row) => ({
			id: row.id,
			sourceKey: row.source_key,
			generation: row.generation,
			createdAt: row.created_at,
			currentGeneration: row.current_generation,
			indexedAt: row.indexed_at,
			writeLeaseExpiresAt: row.write_lease_expires_at,
		}));
	}

	async completeMediaUsageCleanup(input: MediaUsageCleanupCompletion): Promise<boolean> {
		const updates = {
			lease_token: null,
			lease_expires_at: null,
			cursor_created_at: input.sweepComplete ? null : (input.nextCursor?.createdAt ?? null),
			cursor_id: input.sweepComplete ? null : (input.nextCursor?.id ?? null),
			...(input.sweepComplete ? { scan_before_at: null } : {}),
			consecutive_failures: 0,
			last_completed_at: this.cleanupTimestampOffset(0),
			last_candidate_count: input.candidateCount,
			last_deleted_orphans: input.deletedOrphans,
			last_deleted_stale: input.deletedStale,
			last_deleted_abandoned: input.deletedAbandoned,
			last_deleted_write_leases: input.deletedWriteLeases,
			last_backlog_lower_bound: input.backlogLowerBound,
			last_scan_has_more: input.scanHasMore ? 1 : 0,
			last_duration_ms: input.durationMs,
			last_error_code: null,
			updated_at: this.cleanupTimestampOffset(0),
		};
		const result = await this.db
			.updateTable("_emdash_media_usage_cleanup")
			.set(updates)
			.where("task_key", "=", "projection_gc")
			.where("lease_token", "=", input.leaseToken)
			.where(this.cleanupLeaseExpiryIsInFuture("_emdash_media_usage_cleanup.lease_expires_at"))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	async failMediaUsageCleanup(input: {
		leaseToken: string;
		retryDelaySeconds: number;
		consecutiveFailures: number;
		durationMs: number;
		errorCode: string;
	}): Promise<boolean> {
		const retryDelaySeconds = cleanupDurationSeconds(input.retryDelaySeconds);
		const result = await this.db
			.updateTable("_emdash_media_usage_cleanup")
			.set({
				lease_token: null,
				lease_expires_at: null,
				next_eligible_at: this.cleanupTimestampOffset(retryDelaySeconds),
				consecutive_failures: input.consecutiveFailures,
				last_completed_at: this.cleanupTimestampOffset(0),
				last_duration_ms: input.durationMs,
				last_error_code: input.errorCode,
				updated_at: this.cleanupTimestampOffset(0),
			})
			.where("task_key", "=", "projection_gc")
			.where("lease_token", "=", input.leaseToken)
			.where(this.cleanupLeaseExpiryIsInFuture("_emdash_media_usage_cleanup.lease_expires_at"))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	async deleteOrphanOccurrencesOlderThan(
		cutoff: string,
		limit: number,
		options: MediaUsageCleanupDeleteOptions = {},
	): Promise<number> {
		const batchLimit = Math.floor(limit);
		if (batchLimit <= 0) return 0;
		if (options.candidateIds) {
			return this.deleteOrphanCandidateIds(
				options.candidateIds.slice(0, batchLimit),
				cutoff,
				options.cleanupLease,
				options.canIssueStatement,
			);
		}
		if (!canIssueCleanupStatement(options.canIssueStatement)) return 0;

		let query = this.db
			.selectFrom("_emdash_media_usage as u")
			.leftJoin("_emdash_media_usage_sources as s", (join) =>
				join.onRef("s.source_key", "=", "u.source_key"),
			)
			.leftJoin("_emdash_media_usage_generation_writes as writer", (join) =>
				join
					.onRef("writer.source_key", "=", "u.source_key")
					.onRef("writer.generation", "=", "u.generation"),
			)
			.select("u.id")
			.where("s.source_key", "is", null)
			.where("u.created_at", "<", cutoff)
			.where(this.noActiveGenerationWriteExpression("u"))
			.orderBy("u.created_at", "asc")
			.orderBy("u.id", "asc")
			.limit(batchLimit);
		if (options.cleanupLease) {
			query = query.where(this.activeCleanupLeaseExpression(options.cleanupLease));
		}
		const rows = await query.execute();

		return this.deleteOrphanCandidateIds(
			rows.map((row) => row.id),
			cutoff,
			options.cleanupLease,
			options.canIssueStatement,
		);
	}

	async deleteStaleGenerationsOlderThan(
		cutoff: string,
		limit: number,
		options: MediaUsageCleanupDeleteOptions = {},
	): Promise<number> {
		const batchLimit = Math.floor(limit);
		if (batchLimit <= 0) return 0;
		if (options.candidateIds) {
			return this.deleteStaleCandidateIds(
				options.candidateIds.slice(0, batchLimit),
				cutoff,
				options.cleanupLease,
				options.canIssueStatement,
			);
		}
		if (!canIssueCleanupStatement(options.canIssueStatement)) return 0;

		let query = this.db
			.selectFrom("_emdash_media_usage as u")
			.innerJoin("_emdash_media_usage_sources as s", (join) =>
				join.onRef("s.source_key", "=", "u.source_key"),
			)
			.leftJoin("_emdash_media_usage_generation_writes as writer", (join) =>
				join
					.onRef("writer.source_key", "=", "u.source_key")
					.onRef("writer.generation", "=", "u.generation"),
			)
			.select("u.id")
			.where("u.created_at", "<", cutoff)
			.whereRef("u.generation", "!=", "s.current_generation")
			.whereRef("u.created_at", "<", "s.indexed_at")
			.where(this.noActiveGenerationWriteExpression("u"))
			.orderBy("u.created_at", "asc")
			.orderBy("u.id", "asc")
			.limit(batchLimit);
		if (options.cleanupLease) {
			query = query.where(this.activeCleanupLeaseExpression(options.cleanupLease));
		}
		const rows = await query.execute();

		return this.deleteStaleCandidateIds(
			rows.map((row) => row.id),
			cutoff,
			options.cleanupLease,
			options.canIssueStatement,
		);
	}

	async deleteAbandonedGenerationsOlderThan(
		cutoff: string,
		limit: number,
		options: MediaUsageCleanupDeleteOptions = {},
	): Promise<number> {
		const batchLimit = Math.floor(limit);
		if (batchLimit <= 0) return 0;
		if (options.candidateIds) {
			return this.deleteAbandonedCandidateIds(
				options.candidateIds.slice(0, batchLimit),
				cutoff,
				options.cleanupLease,
				options.canIssueStatement,
			);
		}
		if (!canIssueCleanupStatement(options.canIssueStatement)) return 0;

		let query = this.db
			.selectFrom("_emdash_media_usage as u")
			.innerJoin("_emdash_media_usage_sources as s", (join) =>
				join.onRef("s.source_key", "=", "u.source_key"),
			)
			.leftJoin("_emdash_media_usage_generation_writes as writer", (join) =>
				join
					.onRef("writer.source_key", "=", "u.source_key")
					.onRef("writer.generation", "=", "u.generation"),
			)
			.select("u.id")
			.where("u.created_at", "<", cutoff)
			.whereRef("u.generation", "!=", "s.current_generation")
			.whereRef("u.created_at", ">=", "s.indexed_at")
			.where(this.noActiveGenerationWriteExpression("u"))
			.orderBy("u.created_at", "asc")
			.orderBy("u.id", "asc")
			.limit(batchLimit);
		if (options.cleanupLease) {
			query = query.where(this.activeCleanupLeaseExpression(options.cleanupLease));
		}
		const rows = await query.execute();

		return this.deleteAbandonedCandidateIds(
			rows.map((row) => row.id),
			cutoff,
			options.cleanupLease,
			options.canIssueStatement,
		);
	}

	async deleteExpiredGenerationWriteLeases(
		limit: number,
		cleanupLease?: MediaUsageCleanupLease,
		canIssueStatement?: () => boolean,
	): Promise<number> {
		const batchLimit = Math.floor(limit);
		if (batchLimit <= 0 || !canIssueCleanupStatement(canIssueStatement)) return 0;
		let query = this.db
			.selectFrom("_emdash_media_usage_generation_writes")
			.select("lease_token")
			.where(this.generationWriteLeaseHasExpired("expires_at"))
			.orderBy("expires_at", "asc")
			.orderBy("lease_token", "asc")
			.limit(batchLimit);
		if (cleanupLease) query = query.where(this.activeCleanupLeaseExpression(cleanupLease));
		const rows = await query.execute();
		if (rows.length === 0 || !canIssueCleanupStatement(canIssueStatement)) return 0;
		let deleteQuery = this.db
			.deleteFrom("_emdash_media_usage_generation_writes")
			.where(
				"lease_token",
				"in",
				rows.map((row) => row.lease_token),
			)
			.where(this.generationWriteLeaseHasExpired("expires_at"));
		if (cleanupLease)
			deleteQuery = deleteQuery.where(this.activeCleanupLeaseExpression(cleanupLease));
		const result = await deleteQuery.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	async upsertIndexStatus(input: MediaUsageIndexStatusInput): Promise<MediaUsageIndexStatus> {
		const now = input.updatedAt ?? new Date().toISOString();
		const row = {
			adapter_id: input.adapterId,
			scope_type: input.scopeType,
			scope_key: input.scopeKey,
			status: input.status,
			schema_version: input.schemaVersion ?? 1,
			started_at: input.startedAt ?? null,
			completed_at: input.completedAt ?? null,
			cursor: input.cursor ?? null,
			indexed_source_count: input.indexedSourceCount ?? 0,
			failed_source_count: input.failedSourceCount ?? 0,
			last_error_code: input.lastErrorCode ?? null,
			updated_at: now,
		};

		await this.db
			.insertInto("_emdash_media_usage_index_status")
			.values(row)
			.onConflict((oc) =>
				oc.columns(["adapter_id", "scope_type", "scope_key"]).doUpdateSet({
					status: row.status,
					schema_version: row.schema_version,
					started_at: row.started_at,
					completed_at: row.completed_at,
					cursor: row.cursor,
					indexed_source_count: row.indexed_source_count,
					failed_source_count: row.failed_source_count,
					last_error_code: row.last_error_code,
					updated_at: row.updated_at,
				}),
			)
			.execute();

		const status = await this.findIndexStatus(input);
		if (!status) {
			throw new Error(
				`Media usage index status ${input.adapterId}:${input.scopeType}:${input.scopeKey} was not persisted`,
			);
		}
		return status;
	}

	async invalidateIndexStatusForSchemaChange(collectionSlug: string): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_media_usage_index_status as status")
			.set({
				change_epoch: sql<number>`change_epoch + 1`,
				status: "stale",
				completed_at: null,
				cursor: null,
				last_error_code: "CONTENT_USAGE_STALE",
				reconciliation_required: 1,
				updated_at: this.sortableUtcTimestamp(),
			})
			.where("status.adapter_id", "=", "content-media")
			.where("status.scope_type", "=", "collection")
			.where("status.scope_key", "=", collectionSlug)
			.where("status.capture_state", "=", "active")
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_collections as collection")
						.select("collection.id")
						.whereRef("collection.id", "=", "status.collection_id")
						.whereRef("collection.slug", "=", "status.scope_key"),
				),
			)
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_media_usage_activation AS activation
					WHERE activation.task_key = 'incremental_capture'
						AND activation.state = 'active'
				)`,
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) === 1;
	}

	async beginIndexStatusRepair(
		input: MediaUsageIndexStatusRepairInput,
	): Promise<MediaUsageIndexStatus> {
		return this.upsertIndexStatus({
			adapterId: input.adapterId,
			scopeType: input.scopeType,
			scopeKey: input.scopeKey,
			status: "running",
			schemaVersion: input.schemaVersion,
			startedAt: input.startedAt,
			completedAt: null,
			cursor: input.runToken,
			indexedSourceCount: 0,
			failedSourceCount: 0,
			lastErrorCode: null,
			updatedAt: input.updatedAt,
		});
	}

	async finalizeIndexStatusRepairIfRunning(
		input: MediaUsageIndexStatusFinalizeInput,
	): Promise<MediaUsageGuardedIndexStatusResult> {
		const updates: Updateable<MediaUsageIndexStatusTable> = {
			status: input.status,
			completed_at: input.completedAt,
			cursor: null,
			indexed_source_count: input.indexedSourceCount ?? 0,
			failed_source_count: input.failedSourceCount ?? 0,
			last_error_code: input.lastErrorCode ?? null,
			updated_at: input.updatedAt ?? new Date().toISOString(),
		};
		if (input.schemaVersion !== undefined) updates.schema_version = input.schemaVersion;

		const result = await this.db
			.updateTable("_emdash_media_usage_index_status")
			.set(updates)
			.where("adapter_id", "=", input.adapterId)
			.where("scope_type", "=", input.scopeType)
			.where("scope_key", "=", input.scopeKey)
			.where("status", "=", "running")
			.where("cursor", "=", input.runToken)
			.executeTakeFirst();
		const finalized = Number(result.numUpdatedRows ?? 0) > 0;

		return {
			finalized,
			status: await this.findIndexStatus(input),
		};
	}

	async beginIndexStatusRepairAtCurrentEpoch(
		input: MediaUsageIndexStatusEpochRepairInput,
	): Promise<MediaUsageIndexStatusEpochRepairRun | null> {
		const now = this.sortableUtcTimestamp();
		const row = await this.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				status: "running",
				schema_version: input.schemaVersion,
				started_at: now,
				completed_at: null,
				cursor: input.runToken,
				indexed_source_count: 0,
				failed_source_count: 0,
				last_error_code: null,
				reconciliation_required: 1,
				updated_at: now,
			})
			.where("adapter_id", "=", input.adapterId)
			.where("scope_type", "=", input.scopeType)
			.where("scope_key", "=", input.scopeKey)
			.where("collection_id", "=", input.collectionId)
			.where("capture_state", "=", "active")
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_collections AS collection
					WHERE collection.id = ${input.collectionId}
						AND collection.slug = ${input.scopeKey}
				)`,
			)
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_media_usage_activation AS activation
					WHERE activation.task_key = 'incremental_capture'
						AND activation.state = 'active'
				)`,
			)
			.returning(["change_epoch", "started_at"])
			.executeTakeFirst();
		if (!row?.started_at) return null;
		return { changeEpoch: row.change_epoch, startedAt: row.started_at };
	}

	async finalizeIndexStatusRepairAtEpoch(
		input: MediaUsageIndexStatusEpochFinalizeInput,
	): Promise<MediaUsageGuardedIndexStatusResult> {
		const now = this.sortableUtcTimestamp();
		const updates = {
			status: input.status,
			schema_version: input.schemaVersion,
			completed_at: now,
			cursor: null,
			indexed_source_count: input.indexedSourceCount,
			failed_source_count: input.failedSourceCount,
			last_error_code: input.lastErrorCode,
			reconciliation_required: input.status === "complete" ? 0 : 1,
			updated_at: now,
		};

		let query = this.db
			.updateTable("_emdash_media_usage_index_status")
			.set(updates)
			.where("adapter_id", "=", input.adapterId)
			.where("scope_type", "=", input.scopeType)
			.where("scope_key", "=", input.scopeKey)
			.where("collection_id", "=", input.collectionId)
			.where("status", "=", "running")
			.where("cursor", "=", input.runToken)
			.where("change_epoch", "=", input.startingEpoch)
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_collections AS collection
					WHERE collection.id = ${input.collectionId}
						AND collection.slug = ${input.scopeKey}
				)`,
			);
		if (input.status === "complete") {
			query = query.where(
				sql<boolean>`NOT EXISTS (
					SELECT 1
					FROM _emdash_media_usage_work AS work
					WHERE work.collection_id = ${input.collectionId}
				)`,
			);
		}
		const result = await query.executeTakeFirst();
		const finalized = Number(result.numUpdatedRows ?? 0) > 0;

		if (!finalized) {
			await this.db
				.updateTable("_emdash_media_usage_index_status")
				.set({
					status: "stale",
					completed_at: null,
					cursor: null,
					last_error_code: "CONTENT_USAGE_REPAIR_CONFLICT",
					reconciliation_required: 1,
					updated_at: this.sortableUtcTimestamp(),
				})
				.where("adapter_id", "=", input.adapterId)
				.where("scope_type", "=", input.scopeType)
				.where("scope_key", "=", input.scopeKey)
				.where("collection_id", "=", input.collectionId)
				.where("status", "=", "running")
				.where("cursor", "=", input.runToken)
				.execute();
		}

		return {
			finalized,
			status: await this.findIndexStatusForCollection(input, input.collectionId),
		};
	}

	async recordIncrementalSuccess(input: MediaUsageIncrementalStatusIdentity): Promise<boolean> {
		const observed = await this.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("change_epoch")
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", input.collectionSlug)
			.where("collection_id", "=", input.collectionId)
			.where("capture_state", "=", "active")
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_collections AS collection
					WHERE collection.id = ${input.collectionId}
						AND collection.slug = ${input.collectionSlug}
				)`,
			)
			.executeTakeFirst();
		if (!observed) return false;

		const canComplete = sql<boolean>`(
			reconciliation_required = 0
			AND status IN ('complete', 'stale', 'partial')
			AND NOT EXISTS (
				SELECT 1
				FROM _emdash_media_usage_work AS work
				WHERE work.collection_id = ${input.collectionId}
			)
		)`;
		const now = this.sortableUtcTimestamp();
		const result = await this.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				status: sql<string>`CASE WHEN ${canComplete} THEN 'complete' ELSE status END`,
				completed_at: sql<
					string | null
				>`CASE WHEN ${canComplete} THEN ${now} ELSE completed_at END`,
				last_error_code: sql<
					string | null
				>`CASE WHEN ${canComplete} THEN NULL ELSE last_error_code END`,
				last_incremental_success_at: now,
				updated_at: now,
			})
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", input.collectionSlug)
			.where("collection_id", "=", input.collectionId)
			.where("change_epoch", "=", observed.change_epoch)
			.where("capture_state", "=", "active")
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_collections AS collection
					WHERE collection.id = ${input.collectionId}
						AND collection.slug = ${input.collectionSlug}
				)`,
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	async recordIncrementalFailure(
		input: MediaUsageIncrementalStatusIdentity & {
			contentId: string;
			workVersion: number | string;
			errorCode: string;
		},
	): Promise<boolean> {
		const now = this.sortableUtcTimestamp();
		const automaticRunOwnsCoverage = sql<boolean>`EXISTS (
			SELECT 1
			FROM _emdash_media_usage_reconciliations AS reconciliation
			WHERE reconciliation.collection_id = ${input.collectionId}
				AND reconciliation.run_token = cursor
		)`;
		const result = await this.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				status: sql<string>`CASE
					WHEN ${automaticRunOwnsCoverage} THEN status
					WHEN reconciliation_required = 0 THEN 'partial'
					WHEN status = 'running' THEN 'stale'
					ELSE status
				END`,
				completed_at: sql<string | null>`CASE
					WHEN ${automaticRunOwnsCoverage} THEN completed_at
					WHEN reconciliation_required = 0 OR status = 'running' THEN NULL
					ELSE completed_at
				END`,
				cursor: sql<string | null>`CASE
					WHEN ${automaticRunOwnsCoverage} THEN cursor
					WHEN status = 'running' THEN NULL
					ELSE cursor
				END`,
				last_error_code: input.errorCode,
				updated_at: now,
			})
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", input.collectionSlug)
			.where("collection_id", "=", input.collectionId)
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_media_usage_work AS work
					WHERE work.collection_id = ${input.collectionId}
						AND work.content_id = ${input.contentId}
						AND work.work_version = ${input.workVersion}
						AND work.state = 'failed'
						AND work.last_error_code = ${input.errorCode}
				)`,
			)
			.where(
				sql<boolean>`EXISTS (
					SELECT 1
					FROM _emdash_collections AS collection
					WHERE collection.id = ${input.collectionId}
						AND collection.slug = ${input.collectionSlug}
				)`,
			)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	async findIndexStatus(
		identity: MediaUsageIndexStatusIdentity,
	): Promise<MediaUsageIndexStatus | null> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_index_status")
			.selectAll()
			.where("adapter_id", "=", identity.adapterId)
			.where("scope_type", "=", identity.scopeType)
			.where("scope_key", "=", identity.scopeKey)
			.executeTakeFirst();

		return row ? rowToIndexStatus(row) : null;
	}

	private async findIndexStatusForCollection(
		identity: MediaUsageIndexStatusIdentity,
		collectionId: string,
	): Promise<MediaUsageIndexStatus | null> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_index_status")
			.selectAll()
			.where("adapter_id", "=", identity.adapterId)
			.where("scope_type", "=", identity.scopeType)
			.where("scope_key", "=", identity.scopeKey)
			.where("collection_id", "=", collectionId)
			.executeTakeFirst();
		return row ? rowToIndexStatus(row) : null;
	}

	async deleteIndexStatus(
		identity: MediaUsageIndexStatusIdentity,
		collectionId?: string,
	): Promise<number> {
		let query = this.db
			.deleteFrom("_emdash_media_usage_index_status")
			.where("adapter_id", "=", identity.adapterId)
			.where("scope_type", "=", identity.scopeType)
			.where("scope_key", "=", identity.scopeKey);
		if (collectionId !== undefined) query = query.where("collection_id", "=", collectionId);
		const result = await query.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
	}

	private sortableUtcTimestamp(): RawBuilder<string> {
		return isPostgres(this.db)
			? sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
			: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private async findCurrentUsagePage(
		applyFilter: (
			query: ReturnType<MediaUsageRepository["currentUsageBaseQuery"]>,
		) => ReturnType<MediaUsageRepository["currentUsageBaseQuery"]>,
		options: FindMediaUsageOptions,
	): Promise<FindManyResult<MediaUsageRecord>> {
		const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
		let query = applyFilter(this.currentUsageBaseQuery())
			.orderBy("u.id", "asc")
			.limit(limit + 1);

		if (options.cursor) {
			const { id } = decodeCursor(options.cursor);
			query = query.where("u.id", ">", id);
		}

		const rows = await query.execute();
		const items = rows.slice(0, limit).map(rowToUsageRecord);
		const result: FindManyResult<MediaUsageRecord> = { items };

		if (rows.length > limit && items.length > 0) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.occurrence.id, last.occurrence.id);
		}

		return result;
	}

	private currentUsageBaseQuery() {
		return this.db
			.selectFrom("_emdash_media_usage_sources as s")
			.innerJoin("_emdash_media_usage as u", (join) =>
				join
					.onRef("u.source_key", "=", "s.source_key")
					.onRef("u.generation", "=", "s.current_generation"),
			)
			.select(currentUsageSelect);
	}

	private currentContentMediaUsageBaseQuery() {
		return this.db
			.selectFrom("_emdash_media_usage as u")
			.crossJoin("_emdash_media_usage_sources as s")
			.innerJoin("_emdash_collections as collection", "collection.slug", "s.collection_slug")
			.whereRef("s.source_key", "=", "u.source_key")
			.whereRef("s.current_generation", "=", "u.generation")
			.where("s.source_type", "=", "content")
			.where("s.collection_slug", "is not", null)
			.where("s.content_id", "is not", null)
			.where("s.source_variant", "in", ["columns", "draft_overlay"])
			.where(contentSourceMatchesActiveCollection("s", "collection.id"))
			.where(CONTENT_SOURCE_ELIGIBILITY);
	}

	private async deleteOrphanCandidateIds(
		ids: readonly string[],
		cutoff: string,
		cleanupLease?: MediaUsageCleanupLease,
		canIssueStatement?: () => boolean,
	): Promise<number> {
		let deleted = 0;
		for (const idBatch of chunks([...ids], cleanupDeleteBatchSize(cleanupLease))) {
			if (!canIssueCleanupStatement(canIssueStatement)) break;
			if (cleanupLease) {
				await this.markOrphanCandidatesForCleanup(idBatch, cutoff, cleanupLease);
				if (!canIssueCleanupStatement(canIssueStatement)) break;
			}
			let query = this.db
				.deleteFrom("_emdash_media_usage")
				.where("id", "in", idBatch)
				.where("created_at", "<", cutoff)
				.where(
					sql<boolean>`NOT EXISTS (SELECT 1 FROM _emdash_media_usage_sources source WHERE source.source_key = _emdash_media_usage.source_key)`,
				)
				.where(this.noActiveGenerationWriteExpression());
			if (cleanupLease) {
				query = query
					.where("cleanup_lease_token", "=", cleanupLease.leaseToken)
					.where(this.activeCleanupLeaseExpression(cleanupLease));
			}
			const result = await query.executeTakeFirst();
			deleted += Number(result.numDeletedRows ?? 0);
		}
		return deleted;
	}

	private async deleteStaleCandidateIds(
		ids: readonly string[],
		cutoff: string,
		cleanupLease?: MediaUsageCleanupLease,
		canIssueStatement?: () => boolean,
	): Promise<number> {
		let deleted = 0;
		for (const idBatch of chunks([...ids], cleanupDeleteBatchSize(cleanupLease))) {
			if (!canIssueCleanupStatement(canIssueStatement)) break;
			if (cleanupLease) {
				await this.markStaleCandidatesForCleanup(idBatch, cutoff, cleanupLease);
				if (!canIssueCleanupStatement(canIssueStatement)) break;
			}
			let query = this.db
				.deleteFrom("_emdash_media_usage")
				.where("id", "in", idBatch)
				.where("created_at", "<", cutoff)
				.where((eb) =>
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_sources as source")
							.select("source.source_key")
							.whereRef("source.source_key", "=", "_emdash_media_usage.source_key")
							.whereRef("source.current_generation", "!=", "_emdash_media_usage.generation")
							.whereRef("_emdash_media_usage.created_at", "<", "source.indexed_at"),
					),
				)
				.where(this.noActiveGenerationWriteExpression());
			if (cleanupLease) {
				query = query
					.where("cleanup_lease_token", "=", cleanupLease.leaseToken)
					.where(this.activeCleanupLeaseExpression(cleanupLease));
			}
			const result = await query.executeTakeFirst();
			deleted += Number(result.numDeletedRows ?? 0);
		}
		return deleted;
	}

	private async deleteAbandonedCandidateIds(
		ids: readonly string[],
		cutoff: string,
		cleanupLease?: MediaUsageCleanupLease,
		canIssueStatement?: () => boolean,
	): Promise<number> {
		let deleted = 0;
		for (const idBatch of chunks([...ids], cleanupDeleteBatchSize(cleanupLease))) {
			if (!canIssueCleanupStatement(canIssueStatement)) break;
			if (cleanupLease) {
				await this.markAbandonedCandidatesForCleanup(idBatch, cutoff, cleanupLease);
				if (!canIssueCleanupStatement(canIssueStatement)) break;
			}
			let query = this.db
				.deleteFrom("_emdash_media_usage")
				.where("id", "in", idBatch)
				.where("created_at", "<", cutoff)
				.where((eb) =>
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_sources as source")
							.select("source.source_key")
							.whereRef("source.source_key", "=", "_emdash_media_usage.source_key")
							.whereRef("source.current_generation", "!=", "_emdash_media_usage.generation")
							.whereRef("_emdash_media_usage.created_at", ">=", "source.indexed_at"),
					),
				)
				.where(this.noActiveGenerationWriteExpression());
			if (cleanupLease) {
				query = query
					.where("cleanup_lease_token", "=", cleanupLease.leaseToken)
					.where(this.activeCleanupLeaseExpression(cleanupLease));
			}
			const result = await query.executeTakeFirst();
			deleted += Number(result.numDeletedRows ?? 0);
		}
		return deleted;
	}

	private async markOrphanCandidatesForCleanup(
		ids: readonly string[],
		cutoff: string,
		cleanupLease: MediaUsageCleanupLease,
	): Promise<void> {
		await this.db
			.updateTable("_emdash_media_usage")
			.set({ cleanup_lease_token: cleanupLease.leaseToken })
			.where("id", "in", ids)
			.where("created_at", "<", cutoff)
			.where(
				sql<boolean>`NOT EXISTS (SELECT 1 FROM _emdash_media_usage_sources source WHERE source.source_key = _emdash_media_usage.source_key)`,
			)
			.where(this.noActiveGenerationWriteExpression())
			.where(this.activeCleanupLeaseExpression(cleanupLease))
			.execute();
	}

	private async markStaleCandidatesForCleanup(
		ids: readonly string[],
		cutoff: string,
		cleanupLease: MediaUsageCleanupLease,
	): Promise<void> {
		await this.db
			.updateTable("_emdash_media_usage")
			.set({ cleanup_lease_token: cleanupLease.leaseToken })
			.where("id", "in", ids)
			.where("created_at", "<", cutoff)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_sources as source")
						.select("source.source_key")
						.whereRef("source.source_key", "=", "_emdash_media_usage.source_key")
						.whereRef("source.current_generation", "!=", "_emdash_media_usage.generation")
						.whereRef("_emdash_media_usage.created_at", "<", "source.indexed_at"),
				),
			)
			.where(this.noActiveGenerationWriteExpression())
			.where(this.activeCleanupLeaseExpression(cleanupLease))
			.execute();
	}

	private async markAbandonedCandidatesForCleanup(
		ids: readonly string[],
		cutoff: string,
		cleanupLease: MediaUsageCleanupLease,
	): Promise<void> {
		await this.db
			.updateTable("_emdash_media_usage")
			.set({ cleanup_lease_token: cleanupLease.leaseToken })
			.where("id", "in", ids)
			.where("created_at", "<", cutoff)
			.where((eb) =>
				eb.exists(
					eb
						.selectFrom("_emdash_media_usage_sources as source")
						.select("source.source_key")
						.whereRef("source.source_key", "=", "_emdash_media_usage.source_key")
						.whereRef("source.current_generation", "!=", "_emdash_media_usage.generation")
						.whereRef("_emdash_media_usage.created_at", ">=", "source.indexed_at"),
				),
			)
			.where(this.noActiveGenerationWriteExpression())
			.where(this.activeCleanupLeaseExpression(cleanupLease))
			.execute();
	}

	private noActiveGenerationWriteExpression(usageTable = "_emdash_media_usage") {
		const sourceKey = sql.ref(`${usageTable}.source_key`);
		const generation = sql.ref(`${usageTable}.generation`);
		return sql<boolean>`NOT EXISTS (
				SELECT 1
				FROM _emdash_media_usage_generation_writes AS writer
				WHERE writer.source_key = ${sourceKey}
					AND writer.generation = ${generation}
					AND ${this.generationWriteLeaseExpiryIsInFuture("writer.expires_at")}
			)`;
	}

	private activeCleanupLeaseExpression(cleanupLease: MediaUsageCleanupLease) {
		const rowLock = isPostgres(this.db) ? sql` FOR UPDATE` : sql``;
		return sql<boolean>`EXISTS (
				SELECT 1
				FROM _emdash_media_usage_cleanup AS cleanup
				WHERE cleanup.task_key = 'projection_gc'
					AND cleanup.lease_token = ${cleanupLease.leaseToken}
					AND ${this.cleanupLeaseExpiryIsInFuture("cleanup.lease_expires_at")}
				${rowLock}
			)`;
	}

	private cleanupLeaseExpiryIsInFuture(column: string) {
		const leaseExpiresAt = sql.ref(column);
		return isPostgres(this.db)
			? sql<boolean>`${leaseExpiresAt}::timestamptz > clock_timestamp()`
			: sql<boolean>`${leaseExpiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private cleanupTimestampIsDue(column: string) {
		const timestamp = sql.ref(column);
		return isPostgres(this.db)
			? sql<boolean>`${timestamp}::timestamptz <= clock_timestamp()`
			: sql<boolean>`${timestamp} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private cleanupTimestampOffset(offsetSeconds: number): RawBuilder<string> {
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

	private generationWriteLeaseHasExpired(column: string) {
		const leaseExpiresAt = sql.ref(column);
		return isPostgres(this.db)
			? sql<boolean>`${leaseExpiresAt}::timestamptz <= clock_timestamp()`
			: sql<boolean>`${leaseExpiresAt} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private async deleteSourceKeys(sourceKeys: readonly string[]): Promise<number> {
		const uniqueSourceKeys = [...new Set(sourceKeys)];
		if (uniqueSourceKeys.length === 0) return 0;

		return withTransaction(this.db, async (trx) => {
			await this.lockCleanupBeforeSourceDelete(trx);
			let deleted = 0;
			for (const sourceKeyBatch of chunks(uniqueSourceKeys, SQL_BATCH_SIZE)) {
				const result = await trx
					.deleteFrom("_emdash_media_usage_sources")
					.where("source_key", "in", sourceKeyBatch)
					.executeTakeFirst();
				deleted += Number(result.numDeletedRows ?? 0);

				await trx
					.updateTable("_emdash_media_usage")
					.set({ cleanup_lease_token: null })
					.where("source_key", "in", sourceKeyBatch)
					.execute();
				await trx
					.deleteFrom("_emdash_media_usage")
					.where("source_key", "in", sourceKeyBatch)
					.execute();
			}
			return deleted;
		});
	}

	private async deleteSourceGenerationOccurrences(
		db: DatabaseExecutor,
		sourceKey: string,
		generation: string,
	): Promise<void> {
		await db
			.updateTable("_emdash_media_usage")
			.set({ cleanup_lease_token: null })
			.where("source_key", "=", sourceKey)
			.where("generation", "=", generation)
			.execute();
		await db
			.deleteFrom("_emdash_media_usage")
			.where("source_key", "=", sourceKey)
			.where("generation", "=", generation)
			.execute();
	}

	private async lockCleanupBeforeSourceDelete(db: DatabaseExecutor): Promise<void> {
		if (!isPostgres(this.db)) return;
		await sql`
			SELECT 1
			FROM _emdash_media_usage_cleanup
			WHERE task_key = 'projection_gc'
			FOR SHARE
		`.execute(db);
	}

	private async insertOccurrences(
		db: DatabaseExecutor,
		sourceKey: string,
		generation: string,
		occurrences: readonly MediaUsageOccurrenceInput[],
		now: string,
	): Promise<void> {
		if (occurrences.length === 0) return;

		const rows = occurrences.map((occurrence) => ({
			id: ulid(),
			source_key: sourceKey,
			generation,
			field_slug: occurrence.fieldSlug,
			field_path: occurrence.fieldPath,
			occurrence_index: occurrence.occurrenceIndex ?? 0,
			reference_type: occurrence.referenceType,
			media_id: occurrence.mediaId,
			provider: occurrence.provider,
			provider_asset_id: occurrence.providerAssetId,
			media_kind: occurrence.mediaKind ?? null,
			mime_type: occurrence.mimeType ?? null,
			created_at: now,
		}));

		for (const rowBatch of chunks(rows, OCCURRENCE_INSERT_BATCH_SIZE)) {
			await db.insertInto("_emdash_media_usage").values(rowBatch).execute();
		}
	}

	private async lockCanonicalSourceCollection(
		db: DatabaseExecutor,
		source: MediaUsageSourceInput,
	): Promise<boolean> {
		if (source.collectionId === undefined || source.collectionId === null) return true;
		if (!source.collectionSlug) return false;
		if (!isPostgres(this.db)) return true;
		const collection = await db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("id", "=", source.collectionId)
			.where("slug", "=", source.collectionSlug)
			.forKeyShare()
			.executeTakeFirst();
		return collection !== undefined;
	}

	private async upsertSource(
		db: DatabaseExecutor,
		source: MediaUsageSourceInput,
		generation: string,
		now: string,
		leaseToken: string,
	): Promise<boolean> {
		const row = this.buildSourceRow(source, generation, now);
		return this.persistSourceIfWriteLease(
			db,
			row,
			leaseToken,
			sql`
				ON CONFLICT (source_key) DO UPDATE SET
					source_type = excluded.source_type,
					collection_id = excluded.collection_id,
					collection_slug = excluded.collection_slug,
					content_id = excluded.content_id,
					source_variant = excluded.source_variant,
					locale = excluded.locale,
					translation_group = excluded.translation_group,
					content_slug = excluded.content_slug,
					content_title = excluded.content_title,
					content_status = excluded.content_status,
					content_scheduled_at = excluded.content_scheduled_at,
					content_deleted_at = excluded.content_deleted_at,
					revision_id = excluded.revision_id,
					current_generation = excluded.current_generation,
					schema_version = excluded.schema_version,
					source_updated_at = excluded.source_updated_at,
					source_version = excluded.source_version,
					source_fingerprint = excluded.source_fingerprint,
					identity_version = excluded.identity_version,
					source_completeness = excluded.source_completeness,
					last_attempted_at = excluded.last_attempted_at,
					last_error_code = excluded.last_error_code,
					indexed_at = excluded.indexed_at,
					updated_at = excluded.updated_at
			`,
		);
	}

	private async insertSourceIfAbsent(
		db: DatabaseExecutor,
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
		leaseToken: string,
	): Promise<boolean> {
		return this.persistSourceIfWriteLease(
			db,
			row,
			leaseToken,
			sql`ON CONFLICT (source_key) DO NOTHING`,
		);
	}

	private async persistSourceIfWriteLease(
		db: DatabaseExecutor,
		row:
			| ReturnType<MediaUsageRepository["buildSourceRow"]>
			| ReturnType<MediaUsageRepository["buildAttemptedSourceRow"]>,
		leaseToken: string,
		conflict: RawBuilder<unknown>,
	): Promise<boolean> {
		const result = await sql`
			INSERT INTO _emdash_media_usage_sources (
				source_key,
				source_type,
				collection_id,
				collection_slug,
				content_id,
				source_variant,
				locale,
				translation_group,
				content_slug,
				content_title,
				content_status,
				content_scheduled_at,
				content_deleted_at,
				revision_id,
				current_generation,
				schema_version,
				source_updated_at,
				source_version,
				source_fingerprint,
				identity_version,
				source_completeness,
				last_attempted_at,
				last_error_code,
				indexed_at,
				updated_at
			)
			SELECT
				${row.source_key},
				${row.source_type},
				${row.collection_id},
				${row.collection_slug},
				${row.content_id},
				${row.source_variant},
				${row.locale},
				${row.translation_group},
				${row.content_slug},
				${row.content_title},
				${row.content_status},
				${row.content_scheduled_at},
				${row.content_deleted_at},
				${row.revision_id},
				${row.current_generation},
				${row.schema_version},
				${row.source_updated_at},
				${row.source_version},
				${row.source_fingerprint},
				${row.identity_version},
				${row.source_completeness},
				${row.last_attempted_at},
				${row.last_error_code},
				${row.indexed_at},
				${row.updated_at}
			WHERE EXISTS (
				SELECT 1
				FROM _emdash_media_usage_generation_writes
				WHERE source_key = ${row.source_key}
					AND generation = ${row.current_generation}
					AND lease_token = ${leaseToken}
					AND ${this.generationWriteLeaseExpiryIsInFuture("expires_at")}
			)
			AND ${this.currentCollectionExists(row.collection_id, row.collection_slug)}
			AND ${this.currentCanonicalContentExists(row)}
			${conflict}
		`.execute(db);
		return Number(result.numAffectedRows ?? 0) > 0;
	}

	private generationWriteLeaseExpression(
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
		leaseToken: string,
	) {
		return (eb: ExpressionBuilder<Database, "_emdash_media_usage_sources">) =>
			eb.exists(
				eb
					.selectFrom("_emdash_media_usage_generation_writes")
					.select("source_key")
					.where("source_key", "=", row.source_key)
					.where("generation", "=", row.current_generation)
					.where("lease_token", "=", leaseToken)
					.where(
						this.generationWriteLeaseExpiryIsInFuture(
							"_emdash_media_usage_generation_writes.expires_at",
						),
					),
			);
	}

	private generationWriteLeaseExpiryIsInFuture(column: string) {
		const leaseExpiresAt = sql.ref(column);
		return isPostgres(this.db)
			? sql<boolean>`${leaseExpiresAt}::timestamptz > clock_timestamp()`
			: sql<boolean>`${leaseExpiresAt} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
	}

	private async withGenerationWriteLease(
		source: Pick<MediaUsageSourceInput, "sourceKey" | "collectionId" | "collectionSlug">,
		generation: string,
		write: (leaseToken: string, startedAt: string) => Promise<void>,
	): Promise<boolean> {
		const leaseToken = ulid();
		const lease = await sql<{ created_at: string }>`
			INSERT INTO _emdash_media_usage_generation_writes (
				source_key, generation, lease_token, expires_at, created_at
			)
			SELECT
				${source.sourceKey},
				${generation},
				${leaseToken},
				${this.generationWriteLeaseTimestampOffset(MEDIA_USAGE_GENERATION_WRITE_LEASE_MS / 1000)},
				${this.generationWriteLeaseTimestampOffset(0)}
			WHERE ${this.currentCollectionExists(
				source.collectionId ?? null,
				source.collectionSlug ?? null,
			)}
			RETURNING created_at
		`.execute(this.db);
		const owner = lease.rows[0];
		if (!owner) return false;

		try {
			await write(leaseToken, owner.created_at);
			return true;
		} finally {
			try {
				await this.db
					.deleteFrom("_emdash_media_usage_generation_writes")
					.where("source_key", "=", source.sourceKey)
					.where("generation", "=", generation)
					.where("lease_token", "=", leaseToken)
					.execute();
			} catch (error) {
				console.error("[media-usage] Failed to release generation write lease:", error);
			}
		}
	}

	private generationWriteLeaseTimestampOffset(offsetSeconds: number): RawBuilder<string> {
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

	private async updateSourceIfGeneration(
		db: DatabaseExecutor,
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
		expectedCurrentGeneration: string,
		leaseToken: string,
	): Promise<boolean> {
		const result = await db
			.updateTable("_emdash_media_usage_sources")
			.set(this.sourceUpdateSet(row))
			.where("source_key", "=", row.source_key)
			.where("current_generation", "=", expectedCurrentGeneration)
			.where(this.generationWriteLeaseExpression(row, leaseToken))
			.where(this.currentCollectionExists(row.collection_id, row.collection_slug))
			.where(this.currentCanonicalContentExists(row))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	private async updateSourceIfMatching(
		db: DatabaseExecutor,
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
		expectedSource: MediaUsageSource,
		leaseToken: string,
	): Promise<boolean> {
		const result = await db
			.updateTable("_emdash_media_usage_sources")
			.set(this.sourceUpdateSet(row))
			.where("source_key", "=", row.source_key)
			.where(this.sourceMatchExpression(expectedSource))
			.where(this.generationWriteLeaseExpression(row, leaseToken))
			.where(this.currentCollectionExists(row.collection_id, row.collection_slug))
			.where(this.currentCanonicalContentExists(row))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	private async updateAttemptedSourceIfMatching(
		db: DatabaseExecutor,
		source: MediaUsageSourceInput,
		row: ReturnType<MediaUsageRepository["buildAttemptedSourceRow"]>,
		expectedSource: MediaUsageSource,
	): Promise<boolean> {
		const result = await db
			.updateTable("_emdash_media_usage_sources")
			.set(this.attemptedSourceUpdateSet(source, row))
			.where("source_key", "=", row.source_key)
			.where(this.sourceMatchExpression(expectedSource))
			.where(this.currentCollectionExists(row.collection_id, row.collection_slug))
			.where(this.currentCanonicalContentExists(row))
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	private sourceMatchExpression(expectedSource: MediaUsageSource) {
		return (eb: ExpressionBuilder<Database, "_emdash_media_usage_sources">) =>
			eb.and([
				eb("current_generation", "=", expectedSource.currentGeneration),
				eb("source_completeness", "=", expectedSource.sourceCompleteness),
				this.nullableStringExpression(eb, "collection_id", expectedSource.collectionId),
				this.nullableStringExpression(eb, "updated_at", expectedSource.updatedAt),
				this.nullableStringExpression(eb, "source_fingerprint", expectedSource.sourceFingerprint),
				this.nullableStringExpression(eb, "source_updated_at", expectedSource.sourceUpdatedAt),
				this.nullableNumberExpression(eb, "source_version", expectedSource.sourceVersion),
				this.nullableNumberExpression(eb, "identity_version", expectedSource.identityVersion),
				this.nullableStringExpression(eb, "revision_id", expectedSource.revisionId),
				this.nullableStringExpression(eb, "last_attempted_at", expectedSource.lastAttemptedAt),
				this.nullableStringExpression(eb, "last_error_code", expectedSource.lastErrorCode),
			]);
	}

	private async projectionMatchesCurrentGeneration(
		source: MediaUsageSourceInput,
		expectedCurrentGeneration: string,
	): Promise<boolean> {
		const fingerprint = source.sourceFingerprint;
		if (!isMediaUsageProjectionFingerprint(fingerprint)) return false;
		const row = await this.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("source_key", "=", source.sourceKey)
			.where("current_generation", "=", expectedCurrentGeneration)
			.where("source_fingerprint", "=", fingerprint!)
			.where("source_completeness", "=", source.sourceCompleteness ?? "complete")
			.where("last_error_code", "is", null)
			.where(
				this.currentCollectionExists(source.collectionId ?? null, source.collectionSlug ?? null),
			)
			.executeTakeFirst();
		return row !== undefined;
	}

	async projectionMatchesExpectedSource(
		source: MediaUsageSourceInput,
		expectedSource: MediaUsageSource,
	): Promise<boolean> {
		const fingerprint = source.sourceFingerprint;
		if (
			!isMediaUsageProjectionFingerprint(fingerprint) ||
			expectedSource.sourceFingerprint !== fingerprint ||
			expectedSource.sourceCompleteness !== (source.sourceCompleteness ?? "complete") ||
			expectedSource.lastErrorCode !== null
		) {
			return false;
		}
		const row = await this.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("source_key", "=", source.sourceKey)
			.where(this.sourceMatchExpression(expectedSource))
			.where(
				this.currentCollectionExists(source.collectionId ?? null, source.collectionSlug ?? null),
			)
			.executeTakeFirst();
		return row !== undefined;
	}

	private nullableStringExpression(
		eb: ExpressionBuilder<Database, "_emdash_media_usage_sources">,
		column: MediaUsageSourceNullableStringColumn,
		value: string | null,
	) {
		return value === null ? eb(column, "is", null) : eb(column, "=", value);
	}

	private currentCollectionExists(
		collectionId: string | null,
		collectionSlug: string | null,
	): RawBuilder<boolean> {
		if (collectionId === null) return sql<boolean>`1 = 1`;
		return sql<boolean>`EXISTS (
			SELECT 1
			FROM _emdash_collections
			WHERE id = ${collectionId}
				AND slug = ${collectionSlug}
		)`;
	}

	private currentCanonicalContentExists(
		row:
			| ReturnType<MediaUsageRepository["buildSourceRow"]>
			| ReturnType<MediaUsageRepository["buildAttemptedSourceRow"]>,
	): RawBuilder<boolean> {
		if (row.collection_id === null || row.identity_version !== 1 || row.source_type !== "content") {
			return sql<boolean>`1 = 1`;
		}
		if (
			!row.collection_slug ||
			!row.content_id ||
			row.source_version === null ||
			row.source_updated_at === null
		) {
			return sql<boolean>`1 = 0`;
		}
		validateIdentifier(row.collection_slug, "collection slug");
		const tableName = `ec_${row.collection_slug}`;
		validateIdentifier(tableName, "content table");
		const revisionColumn =
			row.source_variant === "columns"
				? "live_revision_id"
				: row.source_variant === "draft_overlay"
					? "draft_revision_id"
					: null;
		if (!revisionColumn) return sql<boolean>`1 = 0`;
		const revision = sql.ref(`content.${revisionColumn}`);
		const revisionMatches =
			row.revision_id === null
				? sql<boolean>`${revision} IS NULL`
				: sql<boolean>`${revision} = ${row.revision_id}`;
		return sql<boolean>`EXISTS (
			SELECT 1
			FROM ${sql.ref(tableName)} AS content
			WHERE content.id = ${row.content_id}
				AND content.version = ${row.source_version}
				AND content.updated_at = ${row.source_updated_at}
				AND ${revisionMatches}
		)`;
	}

	private nullableNumberExpression(
		eb: ExpressionBuilder<Database, "_emdash_media_usage_sources">,
		column: "source_version" | "identity_version",
		value: number | null,
	) {
		return value === null ? eb(column, "is", null) : eb(column, "=", value);
	}

	private async contentRowExists(tableName: string, contentId: string): Promise<boolean> {
		const result = await sql<{ id: string }>`
			SELECT id
			FROM ${sql.ref(tableName)}
			WHERE id = ${contentId}
			LIMIT 1
		`.execute(this.db);
		return result.rows.length > 0;
	}

	private buildSourceRow(source: MediaUsageSourceInput, generation: string, now: string) {
		return {
			source_key: source.sourceKey,
			source_type: source.sourceType,
			collection_id: source.collectionId ?? null,
			collection_slug: source.collectionSlug ?? null,
			content_id: source.contentId ?? null,
			source_variant: source.sourceVariant,
			locale: source.locale ?? null,
			translation_group: source.translationGroup ?? null,
			content_slug: source.contentSlug ?? null,
			content_title: source.contentTitle ?? null,
			content_status: source.contentStatus ?? null,
			content_scheduled_at: source.contentScheduledAt ?? null,
			content_deleted_at: source.contentDeletedAt ?? null,
			revision_id: source.revisionId ?? null,
			current_generation: generation,
			schema_version: source.schemaVersion ?? 1,
			source_updated_at: source.sourceUpdatedAt ?? null,
			source_version: source.sourceVersion ?? null,
			source_fingerprint: source.sourceFingerprint ?? null,
			identity_version: source.identityVersion ?? null,
			// Complete means this source was fully refreshed for the extractor's current
			// schema/version coverage, not that every possible reference shape is known.
			source_completeness: source.sourceCompleteness ?? "complete",
			last_attempted_at: source.lastAttemptedAt ?? now,
			last_error_code: null,
			indexed_at: now,
			updated_at: now,
		};
	}

	private buildAttemptedSourceRow(source: MediaUsageSourceInput, generation: string, now: string) {
		return {
			source_key: source.sourceKey,
			source_type: source.sourceType,
			collection_id: source.collectionId ?? null,
			collection_slug: source.collectionSlug ?? null,
			content_id: source.contentId ?? null,
			source_variant: source.sourceVariant,
			locale: source.locale ?? null,
			translation_group: source.translationGroup ?? null,
			content_slug: source.contentSlug ?? null,
			content_title: source.contentTitle ?? null,
			content_status: source.contentStatus ?? null,
			content_scheduled_at: source.contentScheduledAt ?? null,
			content_deleted_at: source.contentDeletedAt ?? null,
			revision_id: source.revisionId ?? null,
			current_generation: generation,
			schema_version: source.schemaVersion ?? 1,
			source_updated_at: source.sourceUpdatedAt ?? null,
			source_version: source.sourceVersion ?? null,
			source_fingerprint: source.sourceFingerprint ?? null,
			identity_version: source.identityVersion ?? null,
			source_completeness:
				source.sourceCompleteness ?? (source.lastErrorCode ? "failed" : "unknown"),
			last_attempted_at: source.lastAttemptedAt ?? now,
			last_error_code: source.lastErrorCode ?? null,
			indexed_at: now,
			updated_at: now,
		};
	}

	private attemptedSourceUpdateSet(
		source: MediaUsageSourceInput,
		row: ReturnType<MediaUsageRepository["buildAttemptedSourceRow"]>,
	): Updateable<MediaUsageSourceTable> {
		const updates: Updateable<MediaUsageSourceTable> = {
			source_type: row.source_type,
			source_variant: row.source_variant,
			source_completeness: row.source_completeness,
			last_attempted_at: row.last_attempted_at,
			last_error_code: row.last_error_code,
			updated_at: row.updated_at,
		};

		if (source.collectionSlug !== undefined) updates.collection_slug = row.collection_slug;
		if (source.collectionId !== undefined) updates.collection_id = row.collection_id;
		if (source.contentId !== undefined) updates.content_id = row.content_id;
		if (source.locale !== undefined) updates.locale = row.locale;
		if (source.translationGroup !== undefined) updates.translation_group = row.translation_group;
		if (source.contentSlug !== undefined) updates.content_slug = row.content_slug;
		if (source.contentTitle !== undefined) updates.content_title = row.content_title;
		if (source.contentStatus !== undefined) updates.content_status = row.content_status;
		if (source.contentScheduledAt !== undefined) {
			updates.content_scheduled_at = row.content_scheduled_at;
		}
		if (source.contentDeletedAt !== undefined) updates.content_deleted_at = row.content_deleted_at;
		if (source.revisionId !== undefined) updates.revision_id = row.revision_id;
		if (source.schemaVersion !== undefined) updates.schema_version = row.schema_version;
		if (source.sourceUpdatedAt !== undefined) updates.source_updated_at = row.source_updated_at;
		if (source.sourceVersion !== undefined) updates.source_version = row.source_version;
		if (source.sourceFingerprint !== undefined) {
			updates.source_fingerprint = row.source_fingerprint;
		}
		if (source.identityVersion !== undefined) updates.identity_version = row.identity_version;

		return updates;
	}

	private sourceUpdateSet(
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
	): Updateable<MediaUsageSourceTable> {
		return {
			source_type: row.source_type,
			collection_id: row.collection_id,
			collection_slug: row.collection_slug,
			content_id: row.content_id,
			source_variant: row.source_variant,
			locale: row.locale,
			translation_group: row.translation_group,
			content_slug: row.content_slug,
			content_title: row.content_title,
			content_status: row.content_status,
			content_scheduled_at: row.content_scheduled_at,
			content_deleted_at: row.content_deleted_at,
			revision_id: row.revision_id,
			current_generation: row.current_generation,
			schema_version: row.schema_version,
			source_updated_at: row.source_updated_at,
			source_version: row.source_version,
			source_fingerprint: row.source_fingerprint,
			identity_version: row.identity_version,
			source_completeness: row.source_completeness,
			last_attempted_at: row.last_attempted_at,
			last_error_code: row.last_error_code,
			indexed_at: row.indexed_at,
			updated_at: row.updated_at,
		};
	}
}

const currentUsageSelect = [
	"s.source_key as source_key",
	"s.source_type as source_type",
	"s.collection_id as collection_id",
	"s.collection_slug as collection_slug",
	"s.content_id as content_id",
	"s.source_variant as source_variant",
	"s.locale as locale",
	"s.translation_group as translation_group",
	"s.content_slug as content_slug",
	"s.content_title as content_title",
	"s.content_status as content_status",
	"s.content_scheduled_at as content_scheduled_at",
	"s.content_deleted_at as content_deleted_at",
	"s.revision_id as revision_id",
	"s.current_generation as current_generation",
	"s.schema_version as schema_version",
	"s.source_updated_at as source_updated_at",
	"s.source_version as source_version",
	"s.source_fingerprint as source_fingerprint",
	"s.identity_version as identity_version",
	"s.source_completeness as source_completeness",
	"s.last_attempted_at as last_attempted_at",
	"s.last_error_code as last_error_code",
	"s.indexed_at as indexed_at",
	"s.created_at as source_created_at",
	"s.updated_at as source_row_updated_at",
	"u.id as occurrence_id",
	"u.generation as generation",
	"u.field_slug as field_slug",
	"u.field_path as field_path",
	"u.occurrence_index as occurrence_index",
	"u.reference_type as reference_type",
	"u.media_id as media_id",
	"u.provider as provider",
	"u.provider_asset_id as provider_asset_id",
	"u.media_kind as media_kind",
	"u.mime_type as mime_type",
	"u.created_at as occurrence_created_at",
] as const;

function groupUsageRows(rows: readonly GroupedUsageRow[]): MediaUsageEntryGroup[] {
	const groups: MediaUsageEntryGroup[] = [];

	for (const row of rows) {
		if (row.collection_slug === null || row.content_id === null) continue;
		const record = rowToUsageRecord(row);
		let group = groups.at(-1);
		if (
			!group ||
			group.collectionSlug !== row.collection_slug ||
			group.contentId !== row.content_id
		) {
			group = {
				collectionSlug: row.collection_slug,
				contentId: row.content_id,
				contentDeletedAt: row.entry_deleted_at,
				sources: [],
			};
			groups.push(group);
		}

		let source = group.sources.at(-1);
		if (!source || source.source.sourceKey !== record.source.sourceKey) {
			source = { source: record.source, occurrences: [] };
			group.sources.push(source);
		}
		source.occurrences.push(record.occurrence);
	}

	return groups;
}

function rowToSource(row: MediaUsageSourceRow): MediaUsageSource {
	return {
		sourceKey: row.source_key,
		sourceType: row.source_type,
		collectionId: row.collection_id,
		collectionSlug: row.collection_slug,
		contentId: row.content_id,
		sourceVariant: row.source_variant,
		locale: row.locale,
		translationGroup: row.translation_group,
		contentSlug: row.content_slug,
		contentTitle: row.content_title,
		contentStatus: row.content_status,
		contentScheduledAt: row.content_scheduled_at,
		contentDeletedAt: row.content_deleted_at,
		revisionId: row.revision_id,
		currentGeneration: row.current_generation,
		schemaVersion: Number(row.schema_version),
		sourceUpdatedAt: row.source_updated_at,
		sourceVersion: row.source_version === null ? null : Number(row.source_version),
		sourceFingerprint: row.source_fingerprint,
		identityVersion: row.identity_version === null ? null : Number(row.identity_version),
		sourceCompleteness: row.source_completeness,
		lastAttemptedAt: row.last_attempted_at,
		lastErrorCode: row.last_error_code,
		indexedAt: row.indexed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowToOccurrence(row: Selectable<MediaUsageTable>): MediaUsageOccurrence {
	return {
		id: row.id,
		sourceKey: row.source_key,
		generation: row.generation,
		fieldSlug: row.field_slug,
		fieldPath: row.field_path,
		occurrenceIndex: Number(row.occurrence_index),
		referenceType: row.reference_type,
		mediaId: row.media_id,
		provider: row.provider,
		providerAssetId: row.provider_asset_id,
		mediaKind: row.media_kind,
		mimeType: row.mime_type,
		createdAt: row.created_at,
	};
}

function rowToUsageRecord(row: JoinedUsageRow): MediaUsageRecord {
	return {
		source: rowToSource({
			source_key: row.source_key,
			source_type: row.source_type,
			collection_id: row.collection_id,
			collection_slug: row.collection_slug,
			content_id: row.content_id,
			source_variant: row.source_variant,
			locale: row.locale,
			translation_group: row.translation_group,
			content_slug: row.content_slug,
			content_title: row.content_title,
			content_status: row.content_status,
			content_scheduled_at: row.content_scheduled_at,
			content_deleted_at: row.content_deleted_at,
			revision_id: row.revision_id,
			current_generation: row.current_generation,
			schema_version: row.schema_version,
			source_updated_at: row.source_updated_at,
			source_version: row.source_version,
			source_fingerprint: row.source_fingerprint,
			identity_version: row.identity_version,
			source_completeness: row.source_completeness,
			last_attempted_at: row.last_attempted_at,
			last_error_code: row.last_error_code,
			indexed_at: row.indexed_at,
			created_at: row.source_created_at,
			updated_at: row.source_row_updated_at,
		}),
		occurrence: rowToOccurrence({
			id: row.occurrence_id,
			source_key: row.source_key,
			generation: row.generation,
			field_slug: row.field_slug,
			field_path: row.field_path,
			occurrence_index: row.occurrence_index,
			reference_type: row.reference_type,
			media_id: row.media_id,
			provider: row.provider,
			provider_asset_id: row.provider_asset_id,
			media_kind: row.media_kind,
			mime_type: row.mime_type,
			created_at: row.occurrence_created_at,
			cleanup_lease_token: null,
		}),
	};
}

function rowToIndexStatus(row: Selectable<MediaUsageIndexStatusTable>): MediaUsageIndexStatus {
	return {
		adapterId: row.adapter_id,
		scopeType: row.scope_type,
		scopeKey: row.scope_key,
		status: row.status,
		schemaVersion: Number(row.schema_version),
		startedAt: row.started_at,
		completedAt: row.completed_at,
		cursor: row.cursor,
		indexedSourceCount: Number(row.indexed_source_count),
		failedSourceCount: Number(row.failed_source_count),
		lastErrorCode: row.last_error_code,
		updatedAt: row.updated_at,
	};
}
