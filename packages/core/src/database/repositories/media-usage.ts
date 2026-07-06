import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from "kysely";
import { ulid } from "ulidx";

import type { MediaUsageContentSourceVariant } from "../../media/usage/source-key.js";
import type { MediaKind, MediaUsageReferenceType } from "../../media/usage/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { withTransaction } from "../transaction.js";
import type {
	Database,
	MediaUsageIndexStatusTable,
	MediaUsageSourceTable,
	MediaUsageTable,
} from "../types.js";
import { decodeCursor, encodeCursor, type FindManyResult } from "./types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

const OCCURRENCE_BIND_COLUMNS = 13;
const OCCURRENCE_INSERT_BATCH_SIZE = Math.max(
	1,
	Math.floor(SQL_BATCH_SIZE / OCCURRENCE_BIND_COLUMNS),
);

export interface MediaUsageSourceInput {
	sourceKey: string;
	sourceType: string;
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
	sourceCompleteness: string;
	lastAttemptedAt: string | null;
	lastErrorCode: string | null;
	indexedAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface MediaUsageGuardedReplaceResult {
	replaced: boolean;
	/** Populated only when a guarded replacement did not win the current source row. */
	source: MediaUsageSource | null;
}

export interface MediaUsageGuardedDeleteResult {
	deleted: boolean;
	source: MediaUsageSource | null;
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

interface MediaUsageSourceRow {
	source_key: string;
	source_type: string;
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

/** Persistence-only repository for the internal media usage projection tables. */
export class MediaUsageRepository {
	constructor(private db: Kysely<Database>) {}

	async replaceSource(
		source: MediaUsageSourceInput,
		occurrences: readonly MediaUsageOccurrenceInput[],
	): Promise<MediaUsageSource> {
		const generation = ulid();
		const now = new Date().toISOString();

		await withTransaction(this.db, async (trx) => {
			await this.insertOccurrences(trx, source.sourceKey, generation, occurrences, now);
			await this.upsertSource(trx, source, generation, now);
		});

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
		const generation = ulid();
		const now = new Date().toISOString();
		const row = this.buildSourceRow(source, generation, now);
		let replaced = false;

		await withTransaction(this.db, async (trx) => {
			await this.insertOccurrences(trx, source.sourceKey, generation, occurrences, now);
			if (expectedCurrentGeneration === null) {
				replaced = await this.insertSourceIfAbsent(trx, row);
				return;
			}
			replaced = await this.updateSourceIfGeneration(trx, row, expectedCurrentGeneration);
		});

		return {
			replaced,
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

	async markSourceAttempted(source: MediaUsageSourceInput): Promise<MediaUsageSource> {
		const now = new Date().toISOString();
		const attemptedAt = source.lastAttemptedAt ?? now;
		const row = {
			source_key: source.sourceKey,
			source_type: source.sourceType,
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
			current_generation: ulid(),
			schema_version: source.schemaVersion ?? 1,
			source_updated_at: source.sourceUpdatedAt ?? null,
			source_version: source.sourceVersion ?? null,
			source_fingerprint: source.sourceFingerprint ?? null,
			source_completeness:
				source.sourceCompleteness ?? (source.lastErrorCode ? "failed" : "unknown"),
			last_attempted_at: attemptedAt,
			last_error_code: source.lastErrorCode ?? null,
			indexed_at: now,
			updated_at: now,
		};
		const updates: Updateable<MediaUsageSourceTable> = {
			source_type: row.source_type,
			source_variant: row.source_variant,
			source_completeness: row.source_completeness,
			last_attempted_at: row.last_attempted_at,
			last_error_code: row.last_error_code,
			updated_at: row.updated_at,
		};

		if (source.collectionSlug !== undefined) updates.collection_slug = row.collection_slug;
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

		await this.db
			.insertInto("_emdash_media_usage_sources")
			.values(row)
			.onConflict((oc) => oc.column("source_key").doUpdateSet(updates))
			.execute();

		const attempted = await this.findSource(source.sourceKey);
		if (!attempted) {
			throw new Error(`Media usage source ${source.sourceKey} was not persisted`);
		}
		return attempted;
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
			const result = await trx
				.deleteFrom("_emdash_media_usage_sources")
				.where("source_key", "=", sourceKey)
				.where("current_generation", "=", expectedCurrentGeneration)
				.executeTakeFirst();
			deleted = Number(result.numDeletedRows ?? 0) > 0;
			if (!deleted) return;
			await trx.deleteFrom("_emdash_media_usage").where("source_key", "=", sourceKey).execute();
		});

		return {
			deleted,
			source: await this.findSource(sourceKey),
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

	async deleteOrphanOccurrencesOlderThan(cutoff: string, limit: number): Promise<number> {
		const batchLimit = Math.floor(limit);
		if (batchLimit <= 0) return 0;

		const rows = await this.db
			.selectFrom("_emdash_media_usage as u")
			.leftJoin("_emdash_media_usage_sources as s", (join) =>
				join.onRef("s.source_key", "=", "u.source_key"),
			)
			.select("u.id")
			.where("s.source_key", "is", null)
			.where("u.created_at", "<", cutoff)
			.orderBy("u.created_at", "asc")
			.orderBy("u.id", "asc")
			.limit(batchLimit)
			.execute();

		let deleted = 0;
		for (const idBatch of chunks(
			rows.map((row) => row.id),
			SQL_BATCH_SIZE,
		)) {
			const result = await this.db
				.deleteFrom("_emdash_media_usage")
				.where("id", "in", idBatch)
				.where("created_at", "<", cutoff)
				.where(
					sql<boolean>`NOT EXISTS (SELECT 1 FROM _emdash_media_usage_sources s WHERE s.source_key = _emdash_media_usage.source_key)`,
				)
				.executeTakeFirst();
			deleted += Number(result.numDeletedRows ?? 0);
		}
		return deleted;
	}

	async deleteStaleGenerationsOlderThan(cutoff: string, limit: number): Promise<number> {
		const batchLimit = Math.floor(limit);
		if (batchLimit <= 0) return 0;

		const rows = await this.db
			.selectFrom("_emdash_media_usage as u")
			.innerJoin("_emdash_media_usage_sources as s", (join) =>
				join.onRef("s.source_key", "=", "u.source_key"),
			)
			.select("u.id")
			.where("u.created_at", "<", cutoff)
			.whereRef("u.generation", "!=", "s.current_generation")
			.whereRef("u.created_at", "<", "s.indexed_at")
			.orderBy("u.created_at", "asc")
			.orderBy("u.id", "asc")
			.limit(batchLimit)
			.execute();

		const ids = rows.map((row) => row.id);
		if (ids.length === 0) return 0;

		let deleted = 0;
		for (const idBatch of chunks(ids, SQL_BATCH_SIZE)) {
			const result = await this.db
				.deleteFrom("_emdash_media_usage")
				.where("id", "in", idBatch)
				.where("created_at", "<", cutoff)
				.where((eb) =>
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_sources as s")
							.select("s.source_key")
							.whereRef("s.source_key", "=", "_emdash_media_usage.source_key")
							.whereRef("s.current_generation", "!=", "_emdash_media_usage.generation")
							.whereRef("_emdash_media_usage.created_at", "<", "s.indexed_at"),
					),
				)
				.executeTakeFirst();
			deleted += Number(result.numDeletedRows ?? 0);
		}
		return deleted;
	}

	async deleteAbandonedGenerationsOlderThan(cutoff: string, limit: number): Promise<number> {
		const batchLimit = Math.floor(limit);
		if (batchLimit <= 0) return 0;

		const rows = await this.db
			.selectFrom("_emdash_media_usage as u")
			.innerJoin("_emdash_media_usage_sources as s", (join) =>
				join.onRef("s.source_key", "=", "u.source_key"),
			)
			.select("u.id")
			.where("u.created_at", "<", cutoff)
			.whereRef("u.generation", "!=", "s.current_generation")
			.whereRef("u.created_at", ">=", "s.indexed_at")
			.orderBy("u.created_at", "asc")
			.orderBy("u.id", "asc")
			.limit(batchLimit)
			.execute();

		let deleted = 0;
		for (const idBatch of chunks(
			rows.map((row) => row.id),
			SQL_BATCH_SIZE,
		)) {
			const result = await this.db
				.deleteFrom("_emdash_media_usage")
				.where("id", "in", idBatch)
				.where("created_at", "<", cutoff)
				.where((eb) =>
					eb.exists(
						eb
							.selectFrom("_emdash_media_usage_sources as s")
							.select("s.source_key")
							.whereRef("s.source_key", "=", "_emdash_media_usage.source_key")
							.whereRef("s.current_generation", "!=", "_emdash_media_usage.generation")
							.whereRef("_emdash_media_usage.created_at", ">=", "s.indexed_at"),
					),
				)
				.executeTakeFirst();
			deleted += Number(result.numDeletedRows ?? 0);
		}
		return deleted;
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

	async deleteIndexStatus(identity: MediaUsageIndexStatusIdentity): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_media_usage_index_status")
			.where("adapter_id", "=", identity.adapterId)
			.where("scope_type", "=", identity.scopeType)
			.where("scope_key", "=", identity.scopeKey)
			.executeTakeFirst();
		return Number(result.numDeletedRows ?? 0);
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

	private async deleteSourceKeys(sourceKeys: readonly string[]): Promise<number> {
		const uniqueSourceKeys = [...new Set(sourceKeys)];
		if (uniqueSourceKeys.length === 0) return 0;

		return withTransaction(this.db, async (trx) => {
			let deleted = 0;
			for (const sourceKeyBatch of chunks(uniqueSourceKeys, SQL_BATCH_SIZE)) {
				const result = await trx
					.deleteFrom("_emdash_media_usage_sources")
					.where("source_key", "in", sourceKeyBatch)
					.executeTakeFirst();
				deleted += Number(result.numDeletedRows ?? 0);

				await trx
					.deleteFrom("_emdash_media_usage")
					.where("source_key", "in", sourceKeyBatch)
					.execute();
			}
			return deleted;
		});
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

	private async upsertSource(
		db: DatabaseExecutor,
		source: MediaUsageSourceInput,
		generation: string,
		now: string,
	): Promise<void> {
		const row = this.buildSourceRow(source, generation, now);

		await db
			.insertInto("_emdash_media_usage_sources")
			.values(row)
			.onConflict((oc) => oc.column("source_key").doUpdateSet(this.sourceUpdateSet(row)))
			.execute();
	}

	private async insertSourceIfAbsent(
		db: DatabaseExecutor,
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
	): Promise<boolean> {
		const result = await db
			.insertInto("_emdash_media_usage_sources")
			.values(row)
			.onConflict((oc) => oc.column("source_key").doNothing())
			.executeTakeFirst();
		return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
	}

	private async updateSourceIfGeneration(
		db: DatabaseExecutor,
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
		expectedCurrentGeneration: string,
	): Promise<boolean> {
		const result = await db
			.updateTable("_emdash_media_usage_sources")
			.set(this.sourceUpdateSet(row))
			.where("source_key", "=", row.source_key)
			.where("current_generation", "=", expectedCurrentGeneration)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	private buildSourceRow(source: MediaUsageSourceInput, generation: string, now: string) {
		return {
			source_key: source.sourceKey,
			source_type: source.sourceType,
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
			// Complete means this source was fully refreshed for the extractor's current
			// schema/version coverage, not that every possible reference shape is known.
			source_completeness: source.sourceCompleteness ?? "complete",
			last_attempted_at: source.lastAttemptedAt ?? now,
			last_error_code: null,
			indexed_at: now,
			updated_at: now,
		};
	}

	private sourceUpdateSet(
		row: ReturnType<MediaUsageRepository["buildSourceRow"]>,
	): Updateable<MediaUsageSourceTable> {
		return {
			source_type: row.source_type,
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

function rowToSource(row: MediaUsageSourceRow): MediaUsageSource {
	return {
		sourceKey: row.source_key,
		sourceType: row.source_type,
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
