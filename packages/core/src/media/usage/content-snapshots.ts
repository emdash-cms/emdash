import { sql, type Kysely } from "kysely";

import type { MediaUsageOccurrenceInput, MediaUsageSourceInput } from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { extractMediaUsageOccurrences } from "./extractor.js";
import {
	loadContentMediaUsageFields,
	type ContentMediaUsageField,
} from "./content-fields.js";
import { buildContentMediaUsageSourceKey } from "./source-key.js";

const CONTENT_SOURCE_SCHEMA_VERSION = 1;

const CONTENT_SYSTEM_COLUMNS = [
	"id",
	"slug",
	"status",
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
] as const;

export type LoadContentMediaUsageSnapshotsResult =
	| { success: true; snapshots: ContentMediaUsageSnapshot[] }
	| {
			success: false;
			error: "CONTENT_NOT_FOUND" | "DRAFT_REVISION_NOT_FOUND" | "DRAFT_REVISION_MISMATCH";
			source?: MediaUsageSourceInput;
		};

export interface ContentMediaUsageSnapshot {
	source: MediaUsageSourceInput;
	occurrences: MediaUsageOccurrenceInput[];
	fields: readonly ContentMediaUsageField[];
}

export async function loadContentMediaUsageSnapshots(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
): Promise<LoadContentMediaUsageSnapshotsResult> {
	validateIdentifier(collectionSlug, "collection slug");
	const discovery = await loadContentMediaUsageFields(db, collectionSlug);
	const row = await loadContentRow(db, collectionSlug, contentId, [
		...discovery.extractionFields.map((field) => field.slug),
		...discovery.displayFieldSlugs,
	]);

	if (!row) return { success: false, error: "CONTENT_NOT_FOUND" };

	const columnsData = projectData(row, discovery.extractionFields.map((field) => field.slug));
	const displayData = projectData(row, discovery.displayFieldSlugs);
	const occurrences = extractMediaUsageOccurrences({
		fields: discovery.extractionFields,
		data: columnsData,
	});

	return {
		success: true,
		snapshots: [
			{
				source: buildColumnsSource(collectionSlug, row, displayData),
				occurrences,
				fields: discovery.extractionFields,
			},
		],
	};
}

async function loadContentRow(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
	fieldSlugs: readonly string[],
): Promise<Record<string, unknown> | null> {
	const tableName = getContentTableName(collectionSlug);
	const columns = uniqueColumns([...CONTENT_SYSTEM_COLUMNS, ...fieldSlugs]);
	const columnRefs = columns.map((column) => sql.ref(column));
	const result = await sql<Record<string, unknown>>`
		SELECT ${sql.join(columnRefs, sql`, `)}
		FROM ${sql.ref(tableName)}
		WHERE id = ${contentId}
		LIMIT 1
	`.execute(db);

	return result.rows[0] ?? null;
}

function buildColumnsSource(
	collectionSlug: string,
	row: Record<string, unknown>,
	displayData: Record<string, unknown>,
): MediaUsageSourceInput {
	const contentId = readString(row.id) ?? "";
	const contentSlug = readNullableString(row.slug);
	return {
		sourceKey: buildContentMediaUsageSourceKey({
			collectionSlug,
			contentId,
			sourceVariant: "columns",
		}),
		sourceType: "content",
		collectionSlug,
		contentId,
		sourceVariant: "columns",
		locale: readNullableString(row.locale),
		translationGroup: readNullableString(row.translation_group),
		contentSlug,
		contentTitle: deriveContentTitle(displayData, contentSlug, contentId),
		contentStatus: readNullableString(row.status),
		contentScheduledAt: readNullableString(row.scheduled_at),
		contentDeletedAt: readNullableString(row.deleted_at),
		revisionId: readNullableString(row.live_revision_id),
		schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		sourceUpdatedAt: readNullableString(row.updated_at),
		sourceVersion: readNumber(row.version),
	};
}

function projectData(row: Record<string, unknown>, fieldSlugs: readonly string[]): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const fieldSlug of fieldSlugs) {
		data[fieldSlug] = deserializeValue(row[fieldSlug] ?? null);
	}
	return data;
}

function uniqueColumns(columns: readonly string[]): string[] {
	const unique = [...new Set(columns)];
	for (const column of unique) validateIdentifier(column, "content media usage column");
	return unique;
}

function getContentTableName(collectionSlug: string): string {
	validateIdentifier(collectionSlug, "collection slug");
	return `ec_${collectionSlug}`;
}

function deserializeValue(value: unknown): unknown {
	if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

function deriveContentTitle(
	displayData: Record<string, unknown>,
	contentSlug: string | null,
	contentId: string,
): string | null {
	for (const fieldSlug of ["title", "name"] as const) {
		const value = displayData[fieldSlug];
		if (typeof value === "string" && value.trim()) return value;
	}
	return contentSlug ?? contentId;
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readNullableString(value: unknown): string | null {
	return value === null || value === undefined ? null : readString(value);
}

function readNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string" && value) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
