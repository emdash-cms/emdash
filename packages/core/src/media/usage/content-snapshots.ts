import { sql, type Kysely } from "kysely";

import { jsonTextValues } from "../../database/json-recordset.js";
import type {
	MediaUsageOccurrenceInput,
	MediaUsageSourceInput,
} from "../../database/repositories/media-usage.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import {
	loadContentMediaUsageFields,
	type ContentMediaUsageField,
	type ContentMediaUsageFieldDiscovery,
} from "./content-fields.js";
import { extractMediaUsageOccurrences } from "./extractor.js";
import { buildMediaUsageProjectionFingerprint } from "./projection-fingerprint.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "./source-key.js";
import { CONTENT_SOURCE_SCHEMA_VERSION } from "./types.js";

export { CONTENT_SOURCE_SCHEMA_VERSION } from "./types.js";
const CONTENT_COLLECTION_ID_RESULT = "__emdash_media_usage_collection_id";

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
	projectionByteLength: number;
}

export interface LoadContentMediaUsageSnapshotsOptions {
	collectionId?: string;
	identityVersion?: number;
}

export interface LoadContentMediaUsageSnapshotsBatchControl {
	shouldContinue?: () => boolean;
	maxOccurrenceCount?: number;
	maxProjectionBytes?: number;
}

export async function loadContentMediaUsageSnapshots(
	db: Kysely<Database>,
	collectionSlug: string,
	contentId: string,
	fieldDiscovery?: ContentMediaUsageFieldDiscovery,
	options: LoadContentMediaUsageSnapshotsOptions = {},
): Promise<LoadContentMediaUsageSnapshotsResult> {
	const results = await loadContentMediaUsageSnapshotsBatch(
		db,
		collectionSlug,
		[contentId],
		fieldDiscovery,
		options,
	);
	return results.get(contentId) ?? { success: false, error: "CONTENT_NOT_FOUND" };
}

export async function loadContentMediaUsageSnapshotsBatch(
	db: Kysely<Database>,
	collectionSlug: string,
	contentIds: readonly string[],
	fieldDiscovery?: ContentMediaUsageFieldDiscovery,
	options: LoadContentMediaUsageSnapshotsOptions = {},
	control: LoadContentMediaUsageSnapshotsBatchControl = {},
): Promise<Map<string, LoadContentMediaUsageSnapshotsResult>> {
	validateIdentifier(collectionSlug, "collection slug");
	if (options.identityVersion !== undefined && !options.collectionId) {
		throw new Error("Canonical media usage snapshots require a collection identity");
	}
	const discovery = fieldDiscovery ?? (await loadContentMediaUsageFields(db, collectionSlug));
	const rows = await loadContentRows(
		db,
		collectionSlug,
		contentIds,
		[...discovery.extractionFields.map((field) => field.slug), ...discovery.displayFieldSlugs],
		options.collectionId,
	);
	const revisionIds = Array.from(rows.values(), (row) =>
		readNullableString(row.draft_revision_id),
	).filter((revisionId): revisionId is string => revisionId !== null);
	const revisions = await loadRevisionRows(db, revisionIds);
	const results = new Map<string, LoadContentMediaUsageSnapshotsResult>();
	let occurrenceCount = 0;
	let projectionBytes = 0;
	for (const contentId of new Set(contentIds)) {
		if (control.shouldContinue && !control.shouldContinue()) break;
		const row = rows.get(contentId);
		const result: LoadContentMediaUsageSnapshotsResult = row
			? await buildContentMediaUsageSnapshots(row, collectionSlug, discovery, options, revisions)
			: { success: false, error: "CONTENT_NOT_FOUND" };
		const snapshots = result.success ? result.snapshots : (result.snapshots ?? []);
		const itemOccurrenceCount = snapshots.reduce(
			(total, snapshot) => total + snapshot.occurrences.length,
			0,
		);
		const itemProjectionBytes = snapshots.reduce(
			(total, snapshot) => total + snapshot.projectionByteLength,
			0,
		);
		if (
			results.size > 0 &&
			((control.maxOccurrenceCount !== undefined &&
				occurrenceCount + itemOccurrenceCount > control.maxOccurrenceCount) ||
				(control.maxProjectionBytes !== undefined &&
					projectionBytes + itemProjectionBytes > control.maxProjectionBytes))
		) {
			break;
		}
		results.set(contentId, result);
		occurrenceCount += itemOccurrenceCount;
		projectionBytes += itemProjectionBytes;
	}
	return results;
}

async function buildContentMediaUsageSnapshots(
	row: Record<string, unknown>,
	collectionSlug: string,
	discovery: ContentMediaUsageFieldDiscovery,
	options: LoadContentMediaUsageSnapshotsOptions,
	revisions: ReadonlyMap<
		string,
		{ success: true; revision: RevisionSnapshotRow } | { success: false }
	>,
): Promise<LoadContentMediaUsageSnapshotsResult> {
	const collectionId = readString(row[CONTENT_COLLECTION_ID_RESULT]);
	if (!collectionId) {
		throw new Error("Media usage snapshot query did not return a collection identity");
	}

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
	const columnsSource = buildContentSource({
		collectionId: options.collectionId,
		collectionSlug,
		identityVersion: options.identityVersion,
		row,
		displayData,
		sourceVariant: "columns",
		revisionId: columnsRevisionId,
	});
	const columnsProjection = await buildMediaUsageProjectionFingerprint({
		collectionId,
		source: columnsSource,
		occurrences,
		extractionFields: discovery.extractionFields,
	});
	columnsSource.sourceFingerprint = columnsProjection.fingerprint;
	const snapshots: ContentMediaUsageSnapshot[] = [
		{
			source: columnsSource,
			occurrences,
			fields: discovery.extractionFields,
			projectionByteLength: columnsProjection.byteLength,
		},
	];

	const draftRevisionId = readNullableString(row.draft_revision_id);
	if (draftRevisionId) {
		const attemptedDraftSource = buildContentSource({
			collectionId: options.collectionId,
			collectionSlug,
			identityVersion: options.identityVersion,
			row,
			displayData,
			sourceVariant: "draft_overlay",
			revisionId: draftRevisionId,
		});
		const revisionResult = revisions.get(draftRevisionId);
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
		const draftOccurrences = extractMediaUsageOccurrences({
			fields: discovery.extractionFields,
			data: draftOverlayData,
		});
		const draftSource = buildContentSource({
			collectionId: options.collectionId,
			collectionSlug,
			identityVersion: options.identityVersion,
			row,
			displayData: draftDisplayData,
			sourceVariant: "draft_overlay",
			revisionId: draftRevisionId,
			contentSlug: draftContentSlug,
		});
		const draftProjection = await buildMediaUsageProjectionFingerprint({
			collectionId,
			source: draftSource,
			occurrences: draftOccurrences,
			extractionFields: discovery.extractionFields,
		});
		draftSource.sourceFingerprint = draftProjection.fingerprint;
		snapshots.push({
			source: draftSource,
			occurrences: draftOccurrences,
			fields: discovery.extractionFields,
			projectionByteLength: draftProjection.byteLength,
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

async function loadContentRows(
	db: Kysely<Database>,
	collectionSlug: string,
	contentIds: readonly string[],
	fieldSlugs: readonly string[],
	expectedCollectionId?: string,
): Promise<Map<string, Record<string, unknown>>> {
	const tableName = getContentTableName(collectionSlug);
	const columns = uniqueColumns([...CONTENT_SYSTEM_COLUMNS, ...fieldSlugs]);
	const columnRefs = columns.map((column) => sql.ref(`content.${column}`));
	const rows = new Map<string, Record<string, unknown>>();
	const uniqueContentIds = [...new Set(contentIds)];
	if (uniqueContentIds.length === 0) return rows;
	const contentIdInput = jsonTextValues(db, uniqueContentIds);
	const result = await sql<Record<string, unknown>>`
		WITH requested AS (${contentIdInput})
		SELECT
			${sql.join(columnRefs, sql`, `)},
			collection.id AS __emdash_media_usage_collection_id
		FROM ${sql.ref(tableName)} AS content
		INNER JOIN requested ON requested.value = content.id
		INNER JOIN _emdash_collections AS collection
			ON collection.slug = ${collectionSlug}
			${expectedCollectionId ? sql`AND collection.id = ${expectedCollectionId}` : sql``}
	`.execute(db);
	for (const row of result.rows) {
		const contentId = readString(row.id);
		if (contentId) rows.set(contentId, row);
	}
	return rows;
}

async function loadRevisionRows(
	db: Kysely<Database>,
	revisionIds: readonly string[],
): Promise<Map<string, { success: true; revision: RevisionSnapshotRow } | { success: false }>> {
	const revisions = new Map<
		string,
		{ success: true; revision: RevisionSnapshotRow } | { success: false }
	>();
	const uniqueRevisionIds = [...new Set(revisionIds)];
	if (uniqueRevisionIds.length === 0) return revisions;
	const revisionIdInput = jsonTextValues(db, uniqueRevisionIds);
	const rows = await sql<{
		id: string;
		collection: string;
		entry_id: string;
		data: unknown;
	}>`
		WITH requested AS (${revisionIdInput})
		SELECT revision.id, revision.collection, revision.entry_id, revision.data
		FROM revisions AS revision
		INNER JOIN requested ON requested.value = revision.id
	`.execute(db);
	for (const row of rows.rows) {
		const data = parseRevisionData(row.data);
		revisions.set(
			row.id,
			data
				? {
						success: true,
						revision: {
							id: row.id,
							collection: row.collection,
							entryId: row.entry_id,
							data,
						},
					}
				: { success: false },
		);
	}
	return revisions;
}

function buildContentSource(input: {
	collectionId?: string;
	collectionSlug: string;
	identityVersion?: number;
	row: Record<string, unknown>;
	displayData: Record<string, unknown>;
	sourceVariant: MediaUsageContentSourceVariant;
	revisionId: string | null;
	contentSlug?: string | null;
}): MediaUsageSourceInput {
	const {
		collectionId,
		collectionSlug,
		identityVersion,
		row,
		displayData,
		sourceVariant,
		revisionId,
	} = input;
	const contentId = readString(row.id) ?? "";
	const contentSlug = input.contentSlug ?? readNullableString(row.slug);
	const source: MediaUsageSourceInput = {
		sourceKey: buildContentMediaUsageSourceKey({
			collectionId,
			collectionSlug,
			contentId,
			sourceVariant,
		}),
		sourceType: "content",
		collectionId,
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
		identityVersion,
	};
	return source;
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
