import { sql, type Kysely, type Selectable } from "kysely";
import { ulid } from "ulidx";

import type { ExtractedMediaUsage } from "../../media/usage-extractor.js";
import { chunks } from "../../utils/chunks.js";
import type { Database, MediaUsageSourceTable, MediaUsageTable } from "../types.js";
import { validateIdentifier } from "../validate.js";

const INSERT_CHUNK_SIZE = 10;

export type MediaUsageState = "live" | "draft";

export interface ReplaceContentMediaUsageInput {
	collection: string;
	contentId: string;
	contentSlug?: string | null;
	locale?: string | null;
	translationGroup?: string | null;
	contentStatus?: string | null;
	contentDeletedAt?: string | null;
	state: MediaUsageState;
	revisionId?: string | null;
	references: readonly ExtractedMediaUsage[];
}

export interface CurrentMediaUsage {
	mediaId: string | null;
	provider: string;
	providerAssetId: string;
	mediaKind: string | null;
	mimeType: string | null;
	referenceType: string;
	fieldPath: string;
	sortOrder: number;
	collection: string | null;
	contentId: string | null;
	contentSlug: string | null;
	locale: string | null;
	translationGroup: string | null;
	contentStatus: string | null;
	contentDeletedAt: string | null;
	state: string;
	revisionId: string | null;
}

export class MediaUsageRepository {
	constructor(private db: Kysely<Database>) {}

	static contentSourceKey(collection: string, contentId: string, state: MediaUsageState): string {
		return `content:${collection}:${contentId}:${state}`;
	}

	async replaceContentUsage(input: ReplaceContentMediaUsageInput): Promise<void> {
		const sourceKey = MediaUsageRepository.contentSourceKey(
			input.collection,
			input.contentId,
			input.state,
		);
		const generation = ulid();
		const now = new Date().toISOString();
		const references = dedupeReferences(input.references);
		const usageRows = references.map((ref, index) => ({
			id: ulid(),
			source_key: sourceKey,
			generation,
			media_id: ref.mediaId ?? null,
			provider: ref.provider,
			provider_asset_id: ref.providerAssetId,
			media_kind: ref.mediaKind ?? null,
			mime_type: ref.mimeType ?? null,
			reference_type: ref.referenceType,
			field_path: ref.fieldPath,
			sort_order: index,
		}));

		if (usageRows.length > 0) {
			for (const batch of chunks(usageRows, INSERT_CHUNK_SIZE)) {
				await this.db.insertInto("_emdash_media_usage").values(batch).execute();
			}
		}

		await this.db
			.insertInto("_emdash_media_usage_sources")
			.values({
				source_key: sourceKey,
				source_type: "content",
				collection: input.collection,
				content_id: input.contentId,
				content_slug: input.contentSlug ?? null,
				locale: input.locale ?? null,
				translation_group: input.translationGroup ?? null,
				content_status: input.contentStatus ?? null,
				content_deleted_at: input.contentDeletedAt ?? null,
				state: input.state,
				revision_id: input.revisionId ?? null,
				current_generation: generation,
				updated_at: now,
			})
			.onConflict((oc) =>
				oc.column("source_key").doUpdateSet({
					source_type: "content",
					collection: input.collection,
					content_id: input.contentId,
					content_slug: input.contentSlug ?? null,
					locale: input.locale ?? null,
					translation_group: input.translationGroup ?? null,
					content_status: input.contentStatus ?? null,
					content_deleted_at: input.contentDeletedAt ?? null,
					state: input.state,
					revision_id: input.revisionId ?? null,
					current_generation: generation,
					updated_at: now,
				}),
			)
			.execute();

		await this.deleteStaleGenerationsForSource(sourceKey);
	}

	async deleteStaleGenerationsForSource(sourceKey: string): Promise<void> {
		await sql`
			DELETE FROM _emdash_media_usage
			WHERE source_key = ${sourceKey}
			AND generation != (
				SELECT current_generation
				FROM _emdash_media_usage_sources
				WHERE source_key = ${sourceKey}
			)
		`.execute(this.db);
	}

	async deleteContentUsage(
		collection: string,
		contentId: string,
		state?: MediaUsageState,
	): Promise<void> {
		const sourceKeys = state
			? [MediaUsageRepository.contentSourceKey(collection, contentId, state)]
			: [
					MediaUsageRepository.contentSourceKey(collection, contentId, "live"),
					MediaUsageRepository.contentSourceKey(collection, contentId, "draft"),
				];

		await this.db.deleteFrom("_emdash_media_usage").where("source_key", "in", sourceKeys).execute();
		await this.db
			.deleteFrom("_emdash_media_usage_sources")
			.where("source_key", "in", sourceKeys)
			.execute();
	}

	async deleteCollectionUsage(collection: string): Promise<void> {
		validateIdentifier(collection, "collection slug");
		const sourceKeys = this.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_key")
			.where("source_type", "=", "content")
			.where("collection", "=", collection);

		await this.db.deleteFrom("_emdash_media_usage").where("source_key", "in", sourceKeys).execute();
		await this.db
			.deleteFrom("_emdash_media_usage_sources")
			.where("source_type", "=", "content")
			.where("collection", "=", collection)
			.execute();
	}

	async findCurrentByMediaId(mediaId: string): Promise<CurrentMediaUsage[]> {
		const rows = await this.db
			.selectFrom("_emdash_media_usage as usage")
			.innerJoin("_emdash_media_usage_sources as source", (join) =>
				join
					.onRef("source.source_key", "=", "usage.source_key")
					.onRef("source.current_generation", "=", "usage.generation"),
			)
			.select([
				"usage.media_id as media_id",
				"usage.provider as provider",
				"usage.provider_asset_id as provider_asset_id",
				"usage.media_kind as media_kind",
				"usage.mime_type as mime_type",
				"usage.reference_type as reference_type",
				"usage.field_path as field_path",
				"usage.sort_order as sort_order",
				"source.collection as collection",
				"source.content_id as content_id",
				"source.content_slug as content_slug",
				"source.locale as locale",
				"source.translation_group as translation_group",
				"source.content_status as content_status",
				"source.content_deleted_at as content_deleted_at",
				"source.state as state",
				"source.revision_id as revision_id",
			])
			.where("usage.media_id", "=", mediaId)
			.orderBy("source.updated_at", "desc")
			.orderBy("usage.sort_order", "asc")
			.orderBy("usage.id", "asc")
			.execute();

		return rows.map(rowToCurrentUsage);
	}

	async findCurrentByProviderAsset(
		provider: string,
		providerAssetId: string,
	): Promise<CurrentMediaUsage[]> {
		const rows = await this.db
			.selectFrom("_emdash_media_usage as usage")
			.innerJoin("_emdash_media_usage_sources as source", (join) =>
				join
					.onRef("source.source_key", "=", "usage.source_key")
					.onRef("source.current_generation", "=", "usage.generation"),
			)
			.select([
				"usage.media_id as media_id",
				"usage.provider as provider",
				"usage.provider_asset_id as provider_asset_id",
				"usage.media_kind as media_kind",
				"usage.mime_type as mime_type",
				"usage.reference_type as reference_type",
				"usage.field_path as field_path",
				"usage.sort_order as sort_order",
				"source.collection as collection",
				"source.content_id as content_id",
				"source.content_slug as content_slug",
				"source.locale as locale",
				"source.translation_group as translation_group",
				"source.content_status as content_status",
				"source.content_deleted_at as content_deleted_at",
				"source.state as state",
				"source.revision_id as revision_id",
			])
			.where("usage.provider", "=", provider)
			.where("usage.provider_asset_id", "=", providerAssetId)
			.orderBy("source.updated_at", "desc")
			.orderBy("usage.sort_order", "asc")
			.orderBy("usage.id", "asc")
			.execute();

		return rows.map(rowToCurrentUsage);
	}
}

function dedupeReferences(refs: readonly ExtractedMediaUsage[]): ExtractedMediaUsage[] {
	const seen = new Set<string>();
	const deduped: ExtractedMediaUsage[] = [];
	for (const ref of refs) {
		const key = `${ref.fieldPath}\0${ref.provider}\0${ref.providerAssetId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(ref);
	}
	return deduped;
}

function rowToCurrentUsage(
	row: Pick<
		Selectable<MediaUsageTable>,
		| "media_id"
		| "provider"
		| "provider_asset_id"
		| "media_kind"
		| "mime_type"
		| "reference_type"
		| "field_path"
		| "sort_order"
	> &
		Pick<
			Selectable<MediaUsageSourceTable>,
			| "collection"
			| "content_id"
			| "content_slug"
			| "locale"
			| "translation_group"
			| "content_status"
			| "content_deleted_at"
			| "state"
			| "revision_id"
		>,
): CurrentMediaUsage {
	return {
		mediaId: row.media_id,
		provider: row.provider,
		providerAssetId: row.provider_asset_id,
		mediaKind: row.media_kind,
		mimeType: row.mime_type,
		referenceType: row.reference_type,
		fieldPath: row.field_path,
		sortOrder: row.sort_order,
		collection: row.collection,
		contentId: row.content_id,
		contentSlug: row.content_slug,
		locale: row.locale,
		translationGroup: row.translation_group,
		contentStatus: row.content_status,
		contentDeletedAt: row.content_deleted_at,
		state: row.state,
		revisionId: row.revision_id,
	};
}
