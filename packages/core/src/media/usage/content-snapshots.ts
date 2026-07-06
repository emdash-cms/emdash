import { sql, type Kysely } from "kysely";

import type {
	MediaUsageOccurrenceInput,
	MediaUsageSourceInput,
} from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { hashString } from "../../utils/hash.js";
import {
	loadContentMediaUsageFields,
	type ContentMediaUsageField,
	type ContentMediaUsageFieldDiscovery,
} from "./content-fields.js";
import { extractMediaUsageOccurrences } from "./extractor.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "./source-key.js";

export const CONTENT_SOURCE_SCHEMA_VERSION = 1;

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
			error:
				| "CONTENT_NOT_FOUND"
				| "DRAFT_REVISION_NOT_FOUND"
				| "DRAFT_REVISION_MISMATCH"
				| "DRAFT_REVISION_INVALID";
			source?: MediaUsageSourceInput;
			snapshots?: ContentMediaUsageSnapshot[];
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
	fieldDiscovery?: ContentMediaUsageFieldDiscovery,
): Promise<LoadContentMediaUsageSnapshotsResult> {
	validateIdentifier(collectionSlug, "collection slug");
	const discovery = fieldDiscovery ?? (await loadContentMediaUsageFields(db, collectionSlug));
	const row = await loadContentRow(db, collectionSlug, contentId, [
		...discovery.extractionFields.map((field) => field.slug),
		...discovery.displayFieldSlugs,
	]);

	if (!row) return { success: false, error: "CONTENT_NOT_FOUND" };

	const columnsData = projectData(
		row,
		discovery.extractionFields.map((field) => field.slug),
	);
	const displayData = projectRawData(row, discovery.displayFieldSlugs);
	const occurrences = extractMediaUsageOccurrences({
		fields: discovery.extractionFields,
		data: columnsData,
	});
	const columnsRevisionId = readNullableString(row.live_revision_id);
	const columnsFingerprint = await buildSourceFingerprint({
		collectionSlug,
		sourceVariant: "columns",
		revisionId: columnsRevisionId,
		fields: discovery.extractionFields,
		data: columnsData,
	});
	const snapshots: ContentMediaUsageSnapshot[] = [
		{
			source: buildContentSource({
				collectionSlug,
				row,
				displayData,
				sourceVariant: "columns",
				revisionId: columnsRevisionId,
				sourceFingerprint: columnsFingerprint,
			}),
			occurrences,
			fields: discovery.extractionFields,
		},
	];

	const draftRevisionId = readNullableString(row.draft_revision_id);
	if (draftRevisionId) {
		const attemptedDraftSource = buildContentSource({
			collectionSlug,
			row,
			displayData,
			sourceVariant: "draft_overlay",
			revisionId: draftRevisionId,
		});
		const revisionResult = await loadRevisionRow(db, draftRevisionId);
		if (!revisionResult) {
			return {
				success: false,
				error: "DRAFT_REVISION_NOT_FOUND",
				source: attemptedDraftSource,
				snapshots,
			};
		}
		if (!revisionResult.success) {
			return {
				success: false,
				error: "DRAFT_REVISION_INVALID",
				source: attemptedDraftSource,
				snapshots,
			};
		}
		const revision = revisionResult.revision;
		if (revision.collection !== collectionSlug || revision.entryId !== row.id) {
			return {
				success: false,
				error: "DRAFT_REVISION_MISMATCH",
				source: attemptedDraftSource,
				snapshots,
			};
		}

		const revisionData = stripRevisionMetadata(revision.data);
		const draftOverlayData = { ...columnsData, ...revisionData };
		const draftDisplayData = {
			...displayData,
			...projectPresentData(revisionData, discovery.displayFieldSlugs),
		};
		const draftContentSlug =
			readNullableString(revision.data._slug) ?? readNullableString(row.slug);
		const draftFingerprint = await buildSourceFingerprint({
			collectionSlug,
			sourceVariant: "draft_overlay",
			revisionId: draftRevisionId,
			fields: discovery.extractionFields,
			data: draftOverlayData,
		});
		snapshots.push({
			source: buildContentSource({
				collectionSlug,
				row,
				displayData: draftDisplayData,
				sourceVariant: "draft_overlay",
				revisionId: draftRevisionId,
				contentSlug: draftContentSlug,
				sourceFingerprint: draftFingerprint,
			}),
			occurrences: extractMediaUsageOccurrences({
				fields: discovery.extractionFields,
				data: draftOverlayData,
			}),
			fields: discovery.extractionFields,
		});
	}

	return {
		success: true,
		snapshots,
	};
}

interface RevisionSnapshotRow {
	id: string;
	collection: string;
	entryId: string;
	data: Record<string, unknown>;
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

async function loadRevisionRow(
	db: Kysely<Database>,
	revisionId: string,
): Promise<{ success: true; revision: RevisionSnapshotRow } | { success: false } | null> {
	const row = await db
		.selectFrom("revisions")
		.select(["id", "collection", "entry_id", "data"])
		.where("id", "=", revisionId)
		.executeTakeFirst();
	if (!row) return null;
	const data = parseRevisionData(row.data);
	if (!data) return { success: false };
	return {
		success: true,
		revision: {
			id: row.id,
			collection: row.collection,
			entryId: row.entry_id,
			data,
		},
	};
}

function buildContentSource(input: {
	collectionSlug: string;
	row: Record<string, unknown>;
	displayData: Record<string, unknown>;
	sourceVariant: MediaUsageContentSourceVariant;
	revisionId: string | null;
	contentSlug?: string | null;
	sourceFingerprint?: string | null;
}): MediaUsageSourceInput {
	const { collectionSlug, row, displayData, sourceVariant, revisionId } = input;
	const contentId = readString(row.id) ?? "";
	const contentSlug = input.contentSlug ?? readNullableString(row.slug);
	const source: MediaUsageSourceInput = {
		sourceKey: buildContentMediaUsageSourceKey({
			collectionSlug,
			contentId,
			sourceVariant,
		}),
		sourceType: "content",
		collectionSlug,
		contentId,
		sourceVariant,
		locale: readNullableString(row.locale),
		translationGroup: readNullableString(row.translation_group),
		contentSlug,
		contentTitle: deriveContentTitle(displayData, contentSlug, contentId),
		contentStatus: readNullableString(row.status),
		contentScheduledAt: readNullableString(row.scheduled_at),
		contentDeletedAt: readNullableString(row.deleted_at),
		revisionId,
		schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
		sourceUpdatedAt: readNullableString(row.updated_at),
		sourceVersion: readNumber(row.version),
	};
	if (input.sourceFingerprint !== undefined) source.sourceFingerprint = input.sourceFingerprint;
	return source;
}

async function buildSourceFingerprint(input: {
	collectionSlug: string;
	sourceVariant: MediaUsageContentSourceVariant;
	revisionId: string | null;
	fields: readonly ContentMediaUsageField[];
	data: Record<string, unknown>;
}): Promise<string> {
	return hashString(
		canonicalJson({
			schemaVersion: CONTENT_SOURCE_SCHEMA_VERSION,
			collectionSlug: input.collectionSlug,
			sourceVariant: input.sourceVariant,
			fields: normalizeFingerprintFields(input.fields),
			values: projectFingerprintData(input.data, input.fields),
			revisionId: input.sourceVariant === "draft_overlay" ? input.revisionId : null,
		}),
	);
}

function normalizeFingerprintFields(
	fields: readonly ContentMediaUsageField[],
): Record<string, unknown>[] {
	return fields
		.map((field) => {
			if (field.type !== "repeater") return { slug: field.slug, type: field.type };
			return {
				slug: field.slug,
				type: field.type,
				subFields: (field.validation?.subFields ?? [])
					.map((subField) => ({ slug: subField.slug, type: subField.type }))
					.toSorted((a, b) => a.slug.localeCompare(b.slug)),
			};
		})
		.toSorted((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

function projectFingerprintData(
	data: Record<string, unknown>,
	fields: readonly ContentMediaUsageField[],
): Record<string, unknown> {
	const projected: Record<string, unknown> = {};
	for (const field of fields) {
		projected[field.slug] = Object.hasOwn(data, field.slug) ? data[field.slug] : null;
	}
	return projected;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (!isRecord(value)) return value;

	const canonical: Record<string, unknown> = {};
	for (const key of Object.keys(value).toSorted()) {
		canonical[key] = canonicalize(value[key]);
	}
	return canonical;
}

function projectData(
	row: Record<string, unknown>,
	fieldSlugs: readonly string[],
): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const fieldSlug of fieldSlugs) {
		data[fieldSlug] = deserializeValue(row[fieldSlug] ?? null);
	}
	return data;
}

function projectRawData(
	row: Record<string, unknown>,
	fieldSlugs: readonly string[],
): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const fieldSlug of fieldSlugs) {
		data[fieldSlug] = row[fieldSlug] ?? null;
	}
	return data;
}

function projectPresentData(
	row: Record<string, unknown>,
	fieldSlugs: readonly string[],
): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const fieldSlug of fieldSlugs) {
		if (Object.hasOwn(row, fieldSlug)) data[fieldSlug] = row[fieldSlug];
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

function parseRevisionData(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return isRecord(value) ? value : null;
}

function stripRevisionMetadata(data: Record<string, unknown>): Record<string, unknown> {
	const stripped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (!key.startsWith("_")) stripped[key] = value;
	}
	return stripped;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
