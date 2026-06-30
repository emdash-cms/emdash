import { sql, type Kysely } from "kysely";

import {
	MediaUsageRepository,
	type MediaUsageState,
} from "../database/repositories/media-usage.js";
import { RevisionRepository } from "../database/repositories/revision.js";
import type { ContentItem } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import type { FieldType, FieldValidation } from "../schema/types.js";
import { extractContentMediaUsage, type MediaUsageIndexedField } from "./usage-extractor.js";

const INDEXED_FIELD_TYPES = ["image", "file", "repeater", "portableText"] as const;
const CONTENT_SYSTEM_COLUMNS = new Set([
	"id",
	"slug",
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"locale",
	"translation_group",
]);

export async function replaceContentMediaUsage(
	db: Kysely<Database>,
	collection: string,
	item: ContentItem,
	state: MediaUsageState,
	data: Record<string, unknown> = item.data,
	revisionId?: string | null,
	contentDeletedAt?: string | null,
): Promise<void> {
	const fields = await getMediaUsageFields(db, collection);
	const repo = new MediaUsageRepository(db);
	await replaceContentMediaUsageWithFields(
		repo,
		fields,
		collection,
		item,
		state,
		data,
		revisionId,
		contentDeletedAt,
	);
}

export async function replaceCollectionMediaUsage(
	db: Kysely<Database>,
	collection: string,
): Promise<void> {
	validateIdentifier(collection, "collection slug");
	const fields = await getMediaUsageFields(db, collection);
	const repo = new MediaUsageRepository(db);

	if (fields.length === 0) {
		await repo.deleteCollectionUsage(collection);
		return;
	}

	const tableName = `ec_${collection}`;
	const result = await sql<Record<string, unknown>>`
		SELECT * FROM ${sql.ref(tableName)}
	`.execute(db);
	const revisionRepo = new RevisionRepository(db);

	for (const row of result.rows) {
		const item = rowToContentItem(collection, row);
		const contentDeletedAt = stringOrNull(row.deleted_at);

		if (item.status === "published") {
			await replaceContentMediaUsageWithFields(
				repo,
				fields,
				collection,
				item,
				"live",
				item.data,
				item.liveRevisionId,
				contentDeletedAt,
			);

			if (item.draftRevisionId) {
				const draft = await revisionRepo.findById(item.draftRevisionId);
				if (draft) {
					await replaceContentMediaUsageWithFields(
						repo,
						fields,
						collection,
						item,
						"draft",
						draft.data,
						draft.id,
						contentDeletedAt,
					);
				} else {
					await repo.deleteContentUsage(collection, item.id, "draft");
				}
			} else {
				await repo.deleteContentUsage(collection, item.id, "draft");
			}
			continue;
		}

		const draft = item.draftRevisionId ? await revisionRepo.findById(item.draftRevisionId) : null;
		await replaceContentMediaUsageWithFields(
			repo,
			fields,
			collection,
			item,
			"draft",
			draft?.data ?? item.data,
			draft?.id ?? null,
			contentDeletedAt,
		);
		await repo.deleteContentUsage(collection, item.id, "live");
	}
}

async function replaceContentMediaUsageWithFields(
	repo: MediaUsageRepository,
	fields: readonly MediaUsageIndexedField[],
	collection: string,
	item: ContentItem,
	state: MediaUsageState,
	data: Record<string, unknown>,
	revisionId?: string | null,
	contentDeletedAt?: string | null,
): Promise<void> {
	if (fields.length === 0) {
		await repo.deleteContentUsage(collection, item.id, state);
		return;
	}

	await repo.replaceContentUsage({
		collection,
		contentId: item.id,
		contentSlug: item.slug,
		locale: item.locale,
		translationGroup: item.translationGroup,
		contentStatus: item.status,
		contentDeletedAt: contentDeletedAt ?? null,
		state,
		revisionId,
		references: extractContentMediaUsage(fields, data),
	});
}

export async function deleteContentMediaUsage(
	db: Kysely<Database>,
	collection: string,
	contentId: string,
	state?: MediaUsageState,
): Promise<void> {
	await new MediaUsageRepository(db).deleteContentUsage(collection, contentId, state);
}

async function getMediaUsageFields(
	db: Kysely<Database>,
	collection: string,
): Promise<MediaUsageIndexedField[]> {
	const rows = await db
		.selectFrom("_emdash_fields")
		.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
		.select(["_emdash_fields.slug", "_emdash_fields.type", "_emdash_fields.validation"])
		.where("_emdash_collections.slug", "=", collection)
		.where("_emdash_fields.type", "in", INDEXED_FIELD_TYPES)
		.orderBy("_emdash_fields.sort_order", "asc")
		.execute();

	return rows.flatMap((row) => {
		if (!isIndexedFieldType(row.type)) return [];
		return [
			{
				slug: row.slug,
				type: row.type,
				validation: parseFieldValidation(row.validation),
			},
		];
	});
}

function isIndexedFieldType(value: string): value is FieldType {
	switch (value) {
		case "image":
		case "file":
		case "repeater":
		case "portableText":
			return true;
		default:
			return false;
	}
}

function parseFieldValidation(value: string | null): FieldValidation | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null ? (parsed as FieldValidation) : null;
	} catch {
		return null;
	}
}

function rowToContentItem(collection: string, row: Record<string, unknown>): ContentItem {
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (!CONTENT_SYSTEM_COLUMNS.has(key) && value !== null) {
			data[key] = deserializeContentValue(value);
		}
	}

	return {
		id: stringOrEmpty(row.id),
		type: collection,
		slug: stringOrNull(row.slug),
		status: stringOrEmpty(row.status) || "draft",
		data,
		authorId: stringOrNull(row.author_id),
		primaryBylineId: stringOrNull(row.primary_byline_id),
		createdAt: stringOrEmpty(row.created_at),
		updatedAt: stringOrEmpty(row.updated_at),
		publishedAt: stringOrNull(row.published_at),
		scheduledAt: stringOrNull(row.scheduled_at),
		liveRevisionId: stringOrNull(row.live_revision_id),
		draftRevisionId: stringOrNull(row.draft_revision_id),
		version: numberOrDefault(row.version, 1),
		locale: stringOrNull(row.locale),
		translationGroup: stringOrNull(row.translation_group),
	};
}

function deserializeContentValue(value: unknown): unknown {
	if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

function stringOrEmpty(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
	return typeof value === "number" ? value : fallback;
}
