import type { Kysely, Selectable, Transaction } from "kysely";
import { ulid } from "ulidx";

import type { MediaKind, MediaUsageReferenceType } from "../../media/usage/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { withTransaction } from "../transaction.js";
import type { Database, MediaUsageSourceTable, MediaUsageTable } from "../types.js";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

const OCCURRENCE_BIND_COLUMNS = 12;
const OCCURRENCE_INSERT_BATCH_SIZE = Math.max(
	1,
	Math.floor(SQL_BATCH_SIZE / OCCURRENCE_BIND_COLUMNS),
);

export interface MediaUsageSourceInput {
	sourceKey: string;
	sourceType: string;
	collectionSlug?: string | null;
	contentId?: string | null;
	sourceVariant: string;
	locale?: string | null;
	translationGroup?: string | null;
	contentSlug?: string | null;
	contentTitle?: string | null;
	contentStatus?: string | null;
	contentScheduledAt?: string | null;
	contentDeletedAt?: string | null;
	revisionId?: string | null;
	schemaVersion?: number;
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
	indexedAt: string;
	createdAt: string;
	updatedAt: string;
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
	indexed_at: string;
	source_created_at: string;
	source_updated_at: string;
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
			await this.insertOccurrences(trx, source.sourceKey, generation, occurrences);
			await this.upsertSource(trx, source, generation, now);

			try {
				await this.deleteStaleGenerations(trx, source.sourceKey, generation);
			} catch (error) {
				console.error("[media-usage] failed to delete stale generations:", error);
			}
		});

		const replaced = await this.findSource(source.sourceKey);
		if (!replaced) {
			throw new Error(`Media usage source ${source.sourceKey} was not persisted`);
		}
		return replaced;
	}

	async findSource(sourceKey: string): Promise<MediaUsageSource | null> {
		const row = await this.db
			.selectFrom("_emdash_media_usage_sources")
			.selectAll()
			.where("source_key", "=", sourceKey)
			.executeTakeFirst();

		return row ? rowToSource(row) : null;
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

	async deleteSource(sourceKey: string): Promise<number> {
		return withTransaction(this.db, async (trx) => {
			await trx.deleteFrom("_emdash_media_usage").where("source_key", "=", sourceKey).execute();
			const result = await trx
				.deleteFrom("_emdash_media_usage_sources")
				.where("source_key", "=", sourceKey)
				.executeTakeFirst();
			return Number(result.numDeletedRows ?? 0);
		});
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
		if (sourceKeys.length === 0) return 0;

		return withTransaction(this.db, async (trx) => {
			let deleted = 0;
			for (const sourceKeyBatch of chunks(sourceKeys, SQL_BATCH_SIZE)) {
				await trx
					.deleteFrom("_emdash_media_usage")
					.where("source_key", "in", sourceKeyBatch)
					.execute();
				const result = await trx
					.deleteFrom("_emdash_media_usage_sources")
					.where("source_key", "in", sourceKeyBatch)
					.executeTakeFirst();
				deleted += Number(result.numDeletedRows ?? 0);
			}
			return deleted;
		});
	}

	private async insertOccurrences(
		db: DatabaseExecutor,
		sourceKey: string,
		generation: string,
		occurrences: readonly MediaUsageOccurrenceInput[],
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
			current_generation: generation,
			schema_version: source.schemaVersion ?? 1,
			indexed_at: now,
			updated_at: now,
		};

		await db
			.insertInto("_emdash_media_usage_sources")
			.values(row)
			.onConflict((oc) =>
				oc.column("source_key").doUpdateSet({
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
					indexed_at: row.indexed_at,
					updated_at: row.updated_at,
				}),
			)
			.execute();
	}

	private async deleteStaleGenerations(
		db: DatabaseExecutor,
		sourceKey: string,
		currentGeneration: string,
	): Promise<void> {
		await db
			.deleteFrom("_emdash_media_usage")
			.where("source_key", "=", sourceKey)
			.where("generation", "!=", currentGeneration)
			.execute();
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
	"s.indexed_at as indexed_at",
	"s.created_at as source_created_at",
	"s.updated_at as source_updated_at",
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

function rowToSource(row: Selectable<MediaUsageSourceTable>): MediaUsageSource {
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
			indexed_at: row.indexed_at,
			created_at: row.source_created_at,
			updated_at: row.source_updated_at,
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
