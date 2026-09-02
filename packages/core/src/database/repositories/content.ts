import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import type { ContentFieldFilterValue, ContentFieldFilters } from "../../content-list-query.js";
import { invalidateCollectionCache } from "../../object-cache/index.js";
import { isIndexableFieldType, type FieldType } from "../../schema/types.js";
import { buildFtsPrefixMatch, buildSlugGlobPrefix } from "../../search/match.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { slugify } from "../../utils/slugify.js";
import type { Database } from "../types.js";
import { validateIdentifier } from "../validate.js";
import { RevisionRepository } from "./revision.js";
import type {
	CreateContentInput,
	UpdateContentInput,
	FindManyOptions,
	FindManyResult,
	ContentItem,
	ContentDateField,
	ContentBylineFilter,
} from "./types.js";
import {
	ContentCollectionNotFoundError,
	ContentMutationConflictError,
	EmDashValidationError,
	InvalidCursorError,
	ScheduledNotDueError,
	encodeCursor,
	decodeCursor,
} from "./types.js";

// Regex pattern for ULID validation
const ULID_PATTERN = /^[0-9A-Z]{26}$/;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const MAX_DRAFT_STAGE_ATTEMPTS = 32;

// LIKE wildcards that must be escaped so user search input is matched literally.
const LIKE_WILDCARD_RE = /[\\%_]/g;
const MAX_INDEXED_FIELD_FILTERS = 20;
const MAX_IN_FILTER_VALUES = SQL_BATCH_SIZE;
const MAX_FILTER_STRING_LENGTH = 2048;

type NormalizedFilterScalar = string | number;

type ResolvedFieldFilter =
	| { column: string; kind: "null" }
	| { column: string; kind: "exact"; value: NormalizedFilterScalar }
	| { column: string; kind: "in"; values: NormalizedFilterScalar[] }
	| {
			column: string;
			kind: "range";
			bounds: Partial<Record<"gt" | "gte" | "lt" | "lte", NormalizedFilterScalar>>;
	  };

function nullableColumnMatch(column: string, value: string | null): ReturnType<typeof sql> {
	validateIdentifier(column, "content column");
	return value === null ? sql`${sql.ref(column)} IS NULL` : sql`${sql.ref(column)} = ${value}`;
}

function sameStoredValue(left: unknown, right: unknown): boolean {
	return Object.is(serializeValue(left), serializeValue(right));
}

function matchesPublication(
	observed: ContentItem,
	existing: ContentItem,
	revision: { data: Record<string, unknown> },
	revisionId: string,
	slug: string | null,
	publishedAt: string,
	updatedAt: string,
): boolean {
	if (
		observed.version !== existing.version + 1 ||
		observed.status !== "published" ||
		observed.slug !== slug ||
		observed.liveRevisionId !== revisionId ||
		observed.draftRevisionId !== null ||
		observed.scheduledAt !== null ||
		observed.publishedAt !== publishedAt ||
		observed.updatedAt !== updatedAt
	) {
		return false;
	}

	return Object.entries(revision.data).every(
		([key, value]) =>
			SYSTEM_COLUMNS.has(key) || key.startsWith("_") || sameStoredValue(observed.data[key], value),
	);
}

function matchesLifecyclePublication(
	observed: ContentItem,
	existing: ContentItem,
	liveRevisionId: string,
	publishedAt: string,
	updatedAt: string,
): boolean {
	if (
		observed.version !== existing.version + 1 ||
		observed.status !== "published" ||
		observed.slug !== existing.slug ||
		observed.liveRevisionId !== liveRevisionId ||
		observed.draftRevisionId !== null ||
		observed.scheduledAt !== null ||
		observed.publishedAt !== publishedAt ||
		observed.updatedAt !== updatedAt
	) {
		return false;
	}

	return Object.entries(existing.data).every(([key, value]) =>
		sameStoredValue(observed.data[key], value),
	);
}

function matchesPublicationFence(observed: ContentItem, existing: ContentItem): boolean {
	return (
		observed.version === existing.version &&
		observed.status === existing.status &&
		observed.liveRevisionId === existing.liveRevisionId &&
		observed.draftRevisionId === existing.draftRevisionId &&
		observed.scheduledAt === existing.scheduledAt
	);
}

export function isConfirmedStatementFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	return (
		typeof code === "string" &&
		(code === "ERR_SQLITE_ERROR" || code.startsWith("SQLITE_") || SQLSTATE_PATTERN.test(code))
	);
}

interface ResolvedOrderField {
	column: string;
	indexedCustomField: boolean;
}

type IndexedOrderValue = string | number | null;

interface IndexedFieldCursorPayload {
	version: 1;
	field: string;
	value: IndexedOrderValue;
}

function encodeIndexedFieldCursor(field: string, value: IndexedOrderValue, id: string): string {
	const payload: IndexedFieldCursorPayload = { version: 1, field, value };
	return encodeCursor(JSON.stringify(payload), id);
}

function decodeIndexedFieldCursor(
	cursor: string,
	field: string,
): { value: IndexedOrderValue; id: string } {
	const { orderValue, id } = decodeCursor(cursor);
	let payload: unknown;
	try {
		payload = JSON.parse(orderValue);
	} catch {
		throw new InvalidCursorError(cursor);
	}

	if (payload === null || typeof payload !== "object") {
		throw new InvalidCursorError(cursor);
	}
	const candidate = payload as Partial<IndexedFieldCursorPayload>;
	const validValue =
		candidate.value === null ||
		typeof candidate.value === "string" ||
		typeof candidate.value === "number";
	if (candidate.version !== 1 || candidate.field !== field || !validValue) {
		throw new InvalidCursorError(cursor);
	}

	return { value: candidate.value as IndexedOrderValue, id };
}

/**
 * Whitelist mapping a public date-filter field to its physical column. Keeping
 * this separate from `mapOrderField` makes the filterable set explicit and
 * prevents filtering on arbitrary columns.
 */
const DATE_FILTER_COLUMNS: Record<ContentDateField, "created_at" | "updated_at" | "published_at"> =
	{
		createdAt: "created_at",
		updatedAt: "updated_at",
		publishedAt: "published_at",
	};

/**
 * Built-in sort fields → their physical columns. A closed set that blocks
 * sorting by arbitrary columns; per-collection fields are allowed
 * separately via `mapOrderField`'s `sortableExtras`.
 */
const ORDER_FIELD_COLUMNS: Record<string, string> = {
	createdAt: "created_at",
	updatedAt: "updated_at",
	publishedAt: "published_at",
	scheduledAt: "scheduled_at",
	deletedAt: "deleted_at",
	title: "title",
	name: "name",
	slug: "slug",
	status: "status",
	locale: "locale",
};

/** True when `field` maps to a system column and needs no per-collection resolution. */
export function isSystemOrderField(field: string): boolean {
	return field in ORDER_FIELD_COLUMNS;
}

/**
 * System columns that exist in every ec_* table
 */
const SYSTEM_COLUMNS = new Set([
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

/**
 * Get the table name for a collection type
 */
function getTableName(type: string): string {
	validateIdentifier(type, "collection type");
	return `ec_${type}`;
}

/**
 * Serialize a value for database storage
 * Objects/arrays are JSON-stringified
 * Booleans are converted to 0/1 for SQLite
 */
function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "boolean") {
		return value ? 1 : 0;
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return value;
}

function writableContentData(data: Record<string, unknown>): Record<string, unknown> {
	const writable: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (SYSTEM_COLUMNS.has(key)) continue;
		validateIdentifier(key, "content field name");
		writable[key] = value;
	}
	return writable;
}

/**
 * Deserialize a value from database storage
 * Attempts to parse JSON strings that look like objects/arrays
 */
function deserializeValue(value: unknown): unknown {
	if (typeof value === "string") {
		// Try to parse if it looks like JSON
		if (value.startsWith("{") || value.startsWith("[")) {
			try {
				return JSON.parse(value);
			} catch {
				return value;
			}
		}
	}
	return value;
}

/** Pattern for escaping special regex characters */
const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape special regex characters in a string for use in `new RegExp()`
 */
function escapeRegExp(s: string): string {
	return s.replace(REGEX_ESCAPE_PATTERN, "\\$&");
}

/**
 * Repository for content CRUD operations
 *
 * Content is stored in per-collection tables (ec_posts, ec_pages, etc.)
 * Each field becomes a real column in the table.
 */
export class ContentRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Create a new content item
	 */
	async create(input: CreateContentInput): Promise<ContentItem> {
		const id = input.id ?? ulid();
		const now = new Date().toISOString();

		const {
			type,
			slug,
			data,
			status = "draft",
			authorId,
			primaryBylineId,
			locale,
			translationOf,
			publishedAt,
			createdAt,
		} = input;

		// Validate required fields
		if (!type) {
			throw new EmDashValidationError("Content type is required");
		}

		const tableName = getTableName(type);

		// Resolve translation_group: if translationOf is set, look up the source item's group
		let translationGroup: string = id; // default: self-reference
		if (translationOf) {
			const source = await this.findById(type, translationOf);
			if (!source) {
				throw new EmDashValidationError("Translation source content not found");
			}
			translationGroup = source.translationGroup || source.id;
		}

		// Build column names and values
		const columns: string[] = [
			"id",
			"slug",
			"status",
			"author_id",
			"primary_byline_id",
			"created_at",
			"updated_at",
			"published_at",
			"version",
			"locale",
			"translation_group",
		];
		const values: unknown[] = [
			id,
			slug || null,
			status,
			authorId || null,
			primaryBylineId ?? null,
			createdAt || now,
			now,
			publishedAt || null,
			1,
			locale || "en",
			translationGroup,
		];

		// Add data fields as columns (skip system columns to prevent injection via data)
		if (data && typeof data === "object") {
			for (const [key, value] of Object.entries(data)) {
				if (!SYSTEM_COLUMNS.has(key)) {
					validateIdentifier(key, "content field name");
					columns.push(key);
					values.push(serializeValue(value));
				}
			}
		}

		// Build dynamic INSERT using raw SQL
		const columnRefs = columns.map((c) => sql.ref(c));
		const valuePlaceholders = values.map((v) => (v === null ? sql`NULL` : sql`${v}`));

		await sql`
			INSERT INTO ${sql.ref(tableName)} (${sql.join(columnRefs, sql`, `)})
			VALUES (${sql.join(valuePlaceholders, sql`, `)})
		`.execute(this.db);

		invalidateCollectionCache(type);

		// Fetch and return the created item
		const item = await this.findById(type, id);
		if (!item) {
			throw new Error("Failed to create content");
		}
		return item;
	}

	/**
	 * Generate a unique slug for a content item within a collection.
	 *
	 * Checks the collection table for existing slugs that match `baseSlug`
	 * (optionally scoped to a locale) and appends a numeric suffix (`-1`,
	 * `-2`, etc.) on collision to guarantee uniqueness.
	 *
	 * Returns null when slug normalization cannot produce a value.
	 */
	async generateUniqueSlug(type: string, text: string, locale?: string): Promise<string | null> {
		const baseSlug = slugify(text);
		if (!baseSlug) return null;

		const tableName = getTableName(type);

		// Check if the base slug is available
		const existing = locale
			? await sql<{ slug: string }>`
					SELECT slug FROM ${sql.ref(tableName)}
					WHERE slug = ${baseSlug}
					AND locale = ${locale}
					LIMIT 1
				`.execute(this.db)
			: await sql<{ slug: string }>`
					SELECT slug FROM ${sql.ref(tableName)}
					WHERE slug = ${baseSlug}
					LIMIT 1
				`.execute(this.db);

		if (existing.rows.length === 0) {
			return baseSlug;
		}

		// Find all slugs matching the pattern `baseSlug` or `baseSlug-N`
		const pattern = `${baseSlug}-%`;
		const candidates = locale
			? await sql<{ slug: string }>`
					SELECT slug FROM ${sql.ref(tableName)}
					WHERE (slug = ${baseSlug} OR slug LIKE ${pattern})
					AND locale = ${locale}
				`.execute(this.db)
			: await sql<{ slug: string }>`
					SELECT slug FROM ${sql.ref(tableName)}
					WHERE slug = ${baseSlug} OR slug LIKE ${pattern}
				`.execute(this.db);

		// Find the highest numeric suffix in use
		let maxSuffix = 0;
		const suffixPattern = new RegExp(`^${escapeRegExp(baseSlug)}-(\\d+)$`);
		for (const row of candidates.rows) {
			const match = suffixPattern.exec(row.slug);
			if (match) {
				const n = parseInt(match[1], 10);
				if (n > maxSuffix) maxSuffix = n;
			}
		}

		return `${baseSlug}-${maxSuffix + 1}`;
	}

	/**
	 * Duplicate a content item
	 * Creates a new draft copy with "(Copy)" appended to the title.
	 * A slug is auto-generated from the new title by the handler layer.
	 */
	async duplicate(type: string, id: string, authorId?: string): Promise<ContentItem> {
		// Fetch the original item
		const original = await this.findById(type, id);
		if (!original) {
			throw new EmDashValidationError("Content item not found");
		}

		// Prepare the new data
		const newData = { ...original.data };

		// Append "(Copy)" to title if present
		if (typeof newData.title === "string") {
			newData.title = `${newData.title} (Copy)`;
		} else if (typeof newData.name === "string") {
			newData.name = `${newData.name} (Copy)`;
		}

		// Auto-generate a unique slug from the new title/name
		const slugSource =
			typeof newData.title === "string"
				? newData.title
				: typeof newData.name === "string"
					? newData.name
					: null;

		const slug = slugSource
			? await this.generateUniqueSlug(type, slugSource, original.locale ?? undefined)
			: null;

		// Create the duplicate as a draft — use override authorId if provided (caller owns the copy)
		return this.create({
			type,
			slug,
			data: newData,
			status: "draft",
			authorId: authorId || original.authorId || undefined,
			locale: original.locale ?? undefined,
		});
	}

	/**
	 * Find content by ID
	 */
	async findById(type: string, id: string): Promise<ContentItem | null> {
		const tableName = getTableName(type);

		const result = await sql<Record<string, unknown>>`
			SELECT * FROM ${sql.ref(tableName)}
			WHERE id = ${id}
			AND deleted_at IS NULL
		`.execute(this.db);

		const row = result.rows[0];
		if (!row) {
			return null;
		}

		return this.mapRow(type, row);
	}

	/**
	 * Find content by id, including trashed (soft-deleted) items.
	 * Used by restore endpoint for ownership checks.
	 */
	async findByIdIncludingTrashed(type: string, id: string): Promise<ContentItem | null> {
		const tableName = getTableName(type);

		const result = await sql<Record<string, unknown>>`
			SELECT * FROM ${sql.ref(tableName)}
			WHERE id = ${id}
		`.execute(this.db);

		const row = result.rows[0];
		if (!row) {
			return null;
		}

		return this.mapRow(type, row);
	}

	/**
	 * Find content by ID or slug. Tries ID first if it looks like a ULID,
	 * otherwise tries slug. Falls back to the other if the first lookup misses.
	 */
	async findByIdOrSlug(
		type: string,
		identifier: string,
		locale?: string,
	): Promise<ContentItem | null> {
		return this._findByIdOrSlug(type, identifier, false, locale);
	}

	/**
	 * Find content by ID or slug, including trashed (soft-deleted) items.
	 * Used by restore/permanent-delete endpoints.
	 */
	async findByIdOrSlugIncludingTrashed(
		type: string,
		identifier: string,
		locale?: string,
	): Promise<ContentItem | null> {
		return this._findByIdOrSlug(type, identifier, true, locale);
	}

	private async _findByIdOrSlug(
		type: string,
		identifier: string,
		includeTrashed: boolean,
		locale?: string,
	): Promise<ContentItem | null> {
		// ULIDs are 26 uppercase alphanumeric chars
		const looksLikeUlid = ULID_PATTERN.test(identifier);

		const findById = includeTrashed
			? (t: string, id: string) => this.findByIdIncludingTrashed(t, id)
			: (t: string, id: string) => this.findById(t, id);
		const findBySlug = includeTrashed
			? (t: string, s: string) => this.findBySlugIncludingTrashed(t, s, locale)
			: (t: string, s: string) => this.findBySlug(t, s, locale);

		try {
			if (looksLikeUlid) {
				// Try ID first, fall back to slug
				const byId = await findById(type, identifier);
				if (byId) return byId;
				return await findBySlug(type, identifier);
			}
			// Try slug first, fall back to ID
			const bySlug = await findBySlug(type, identifier);
			if (bySlug) return bySlug;
			return await findById(type, identifier);
		} catch (error) {
			// A collection dropped out from under a still-referencing caller (e.g. a
			// relation whose collection was deleted without cascading) leaves the
			// ec_* table missing. Treat that as "not found", matching
			// findManyByIdOrSlug and findTranslationsForGroups, so callers surface a
			// structured NOT_FOUND instead of a 500.
			if (isMissingTableError(error)) return null;
			throw error;
		}
	}

	/**
	 * Find content by slug
	 */
	async findBySlug(type: string, slug: string, locale?: string): Promise<ContentItem | null> {
		const tableName = getTableName(type);

		const result = locale
			? await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
					WHERE slug = ${slug}
					AND locale = ${locale}
					AND deleted_at IS NULL
				`.execute(this.db)
			: await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
					WHERE slug = ${slug}
					AND deleted_at IS NULL
					ORDER BY locale ASC
					LIMIT 1
				`.execute(this.db);

		const row = result.rows[0];
		if (!row) {
			return null;
		}

		return this.mapRow(type, row);
	}

	/**
	 * Find content by slug, including trashed (soft-deleted) items.
	 * Used by restore/permanent-delete endpoints.
	 */
	async findBySlugIncludingTrashed(
		type: string,
		slug: string,
		locale?: string,
	): Promise<ContentItem | null> {
		const tableName = getTableName(type);

		const result = locale
			? await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
					WHERE slug = ${slug}
					AND locale = ${locale}
				`.execute(this.db)
			: await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
					WHERE slug = ${slug}
					ORDER BY locale ASC
					LIMIT 1
				`.execute(this.db);

		const row = result.rows[0];
		if (!row) {
			return null;
		}

		return this.mapRow(type, row);
	}

	/**
	 * Find many content items with filtering and pagination
	 */
	async findMany(
		type: string,
		options: FindManyOptions = {},
	): Promise<FindManyResult<ContentItem>> {
		const tableName = getTableName(type);
		const limit = Math.min(options.limit || 50, 100);

		// Determine ordering
		const orderField = options.orderBy?.field || "createdAt";
		const orderDirection = options.orderBy?.direction || "desc";
		const resolvedOrderField = await this.resolveOrderField(
			type,
			orderField,
			options.sortableExtras,
		);
		const dbField = resolvedOrderField.column;
		const resolvedFieldFilters = await this.resolveFieldFilters(type, options.where?.fieldFilters);

		// Validate order direction to prevent injection
		const safeOrderDirection = orderDirection.toLowerCase() === "asc" ? "ASC" : "DESC";

		// Build query with parameterized values (no string interpolation)
		// Note: Dynamic content tables have deleted_at column, cast needed for Kysely
		let query = this.db
			.selectFrom(tableName as keyof Database)
			.selectAll()
			.where("deleted_at" as never, "is", null);

		// Apply filters with parameterized queries
		if (options.where?.status) {
			query = query.where("status", "=", options.where.status);
		}

		if (options.where?.authorId) {
			query = query.where("author_id", "=", options.where.authorId);
		}

		if (options.where?.locale) {
			query = query.where("locale" as any, "=", options.where.locale);
		}

		query = this.applySearchFilter(query, options.where, type);
		query = this.applyDateFilter(query, options.where);
		query = this.applyBylineFilter(query, options.where, type);
		query = this.applyFieldFilters(query, resolvedFieldFilters);

		// Handle cursor pagination — decodeCursor throws InvalidCursorError
		// on malformed input; let it propagate so handlers surface a
		// structured INVALID_CURSOR rather than silently returning page 1.
		if (options.cursor) {
			if (resolvedOrderField.indexedCustomField) {
				const { value, id: cursorId } = decodeIndexedFieldCursor(options.cursor, orderField);
				const isPresent = sql<boolean>`${sql.ref(dbField)} IS NOT NULL`;
				const falseLiteral = sql<boolean>`FALSE`;
				const trueLiteral = sql<boolean>`TRUE`;
				if (safeOrderDirection === "ASC" && value === null) {
					query = query.where(sql<boolean>`
						(${isPresent}) > ${falseLiteral}
						OR ((${isPresent}) = ${falseLiteral} AND ${sql.ref("id")} > ${cursorId})
					`);
				} else if (safeOrderDirection === "DESC" && value === null) {
					query = query.where(sql<boolean>`
						(${isPresent}) = ${falseLiteral} AND ${sql.ref("id")} < ${cursorId}
					`);
				} else if (safeOrderDirection === "ASC") {
					query = query.where(sql<boolean>`
						(${isPresent}, ${sql.ref(dbField)}, ${sql.ref("id")})
							> (${trueLiteral}, ${value}, ${cursorId})
					`);
				} else {
					query = query.where(sql<boolean>`
						(${isPresent}, ${sql.ref(dbField)}, ${sql.ref("id")})
							< (${trueLiteral}, ${value}, ${cursorId})
					`);
				}
			} else {
				const { orderValue, id: cursorId } = decodeCursor(options.cursor);

				if (safeOrderDirection === "DESC") {
					query = query.where((eb) =>
						eb.or([
							eb(dbField as any, "<", orderValue),
							eb.and([eb(dbField as any, "=", orderValue), eb("id", "<", cursorId)]),
						]),
					);
				} else {
					query = query.where((eb) =>
						eb.or([
							eb(dbField as any, ">", orderValue),
							eb.and([eb(dbField as any, "=", orderValue), eb("id", ">", cursorId)]),
						]),
					);
				}
			}
		}

		// Apply ordering and limit
		const indexedOrderFilter = resolvedOrderField.indexedCustomField
			? resolvedFieldFilters.find((filter) => filter.column === dbField)
			: undefined;
		if (resolvedOrderField.indexedCustomField && !indexedOrderFilter) {
			query = query.orderBy(
				sql<boolean>`${sql.ref(dbField)} IS NOT NULL`,
				safeOrderDirection === "ASC" ? "asc" : "desc",
			);
		}
		if (indexedOrderFilter?.kind !== "null") {
			query = query.orderBy(dbField as any, safeOrderDirection === "ASC" ? "asc" : "desc");
		}
		query = query.orderBy("id", safeOrderDirection === "ASC" ? "asc" : "desc").limit(limit + 1);

		// Run the page fetch and the unbounded count together — the UI needs
		// both to render a stable denominator (kept on every page intentionally),
		// and issuing them in parallel on SQLite is essentially free.
		//
		// Settled rather than raced: a collection whose table is missing rejects
		// both, and `Promise.all` returns on the first. The loser stays in flight
		// holding a pooled connection, so a Postgres pool destroyed in that window
		// never finishes closing.
		const [rowsResult, countResult] = await Promise.allSettled([
			query.execute(),
			this.countWithResolvedFilters(type, options.where, resolvedFieldFilters),
		]);
		if (rowsResult.status === "rejected") throw rowsResult.reason;
		if (countResult.status === "rejected") throw countResult.reason;
		const rows = rowsResult.value;
		const total = countResult.value;
		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit);

		const mappedResult: FindManyResult<ContentItem> = {
			items: items.map((row) => this.mapRow(type, row as Record<string, unknown>)),
			total,
		};

		if (hasMore && items.length > 0) {
			const lastRow = items.at(-1) as Record<string, unknown>;
			const lastOrderValue = lastRow[dbField];
			if (resolvedOrderField.indexedCustomField) {
				if (
					lastOrderValue !== null &&
					typeof lastOrderValue !== "string" &&
					typeof lastOrderValue !== "number"
				) {
					throw new EmDashValidationError(`Invalid indexed value for order field: ${orderField}`);
				}
				mappedResult.nextCursor = encodeIndexedFieldCursor(
					orderField,
					lastOrderValue,
					String(lastRow.id),
				);
			} else {
				const orderStr =
					typeof lastOrderValue === "string" || typeof lastOrderValue === "number"
						? String(lastOrderValue)
						: "";
				mappedResult.nextCursor = encodeCursor(orderStr, String(lastRow.id));
			}
		}

		return mappedResult;
	}

	/**
	 * Update content
	 */
	async update(type: string, id: string, input: UpdateContentInput): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		// Every update advances the optimistic-concurrency version. updated_at
		// advances only when a content-row column actually changes.
		const updates: Record<string, unknown> = {};

		if (input.status !== undefined) {
			updates.status = input.status;
		}

		if (input.slug !== undefined) {
			updates.slug = input.slug;
		}

		if (input.publishedAt !== undefined) {
			updates.published_at = input.publishedAt;
		}

		if (input.scheduledAt !== undefined) {
			updates.scheduled_at = input.scheduledAt;
		}

		if (input.authorId !== undefined) {
			updates.author_id = input.authorId;
		}

		if (input.primaryBylineId !== undefined) {
			updates.primary_byline_id = input.primaryBylineId;
		}

		// Update data fields (skip system columns to prevent injection via data)
		if (input.data !== undefined && typeof input.data === "object") {
			for (const [key, value] of Object.entries(writableContentData(input.data))) {
				updates[key] = serializeValue(value);
			}
		}

		const hasColumnWrites = Object.keys(updates).length > 0;
		if (hasColumnWrites) {
			updates.updated_at = now;
		}
		updates.version = sql`version + 1`;

		await this.db
			.updateTable(tableName as keyof Database)
			.set(updates)
			.where("id", "=", id)
			.where("deleted_at" as never, "is", null)
			.execute();

		if (hasColumnWrites) invalidateCollectionCache(type);

		const updated = await this.findById(type, id);
		if (!updated) {
			throw new Error("Content not found");
		}

		return updated;
	}

	/**
	 * Update plugin-authored fields without letting content columns diverge
	 * from the revision pointers that publication promotes.
	 */
	async updateDraftAware(
		type: string,
		id: string,
		input: UpdateContentInput,
	): Promise<ContentItem> {
		const data = input.data ? writableContentData(input.data) : {};
		const stagedSlug = typeof input.slug === "string" ? input.slug : undefined;
		const hasDraftUpdate = Object.keys(data).length > 0 || stagedSlug !== undefined;

		if (!hasDraftUpdate) {
			return this.update(type, id, { ...input, data });
		}

		const collectionRows = await this.db
			.selectFrom("_emdash_collections as collection")
			.leftJoin("_emdash_fields as field", "field.collection_id", "collection.id")
			.select(["collection.supports", "field.slug as fieldSlug"])
			.where("collection.slug", "=", type)
			.execute();
		const supportsRaw = collectionRows[0]?.supports;
		const supports: unknown = supportsRaw ? JSON.parse(supportsRaw) : [];
		if (!Array.isArray(supports) || !supports.includes("revisions")) {
			return this.update(type, id, { ...input, data });
		}

		const fieldSlugs = new Set(collectionRows.map((row) => row.fieldSlug).filter(Boolean));
		for (const field of Object.keys(data)) {
			if (!fieldSlugs.has(field)) {
				throw new EmDashValidationError(`Unknown field '${field}' in collection '${type}'`);
			}
		}

		const revisionRepo = new RevisionRepository(this.db);
		let existing = await this.findById(type, id);

		for (let attempt = 0; existing && attempt < MAX_DRAFT_STAGE_ATTEMPTS; attempt++) {
			let baseData = existing.data;
			if (existing.draftRevisionId) {
				const draft = await revisionRepo.findById(existing.draftRevisionId);
				if (draft) baseData = draft.data;
			}

			const mergedData = { ...baseData, ...data };
			if (stagedSlug !== undefined) mergedData._slug = stagedSlug;
			const revision = await revisionRepo.create({
				collection: type,
				entryId: id,
				data: mergedData,
				...(input.authorId ? { authorId: input.authorId } : {}),
			});

			let staged: boolean;
			try {
				staged = await this.replaceDraftRevisionForUpdate(type, id, revision.id, existing, input);
			} catch (error) {
				await this.deleteUnstagedRevision(revisionRepo, type, id, revision.id);
				throw error;
			}

			if (staged) {
				const updated = await this.findById(type, id);
				if (!updated) throw new Error("Content not found");
				const draftData: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(mergedData)) {
					if (!key.startsWith("_")) draftData[key] = value;
				}
				return { ...updated, data: { ...updated.data, ...draftData } };
			}

			await this.deleteUnstagedRevision(revisionRepo, type, id, revision.id);
			existing = await this.findById(type, id);
		}

		if (!existing) throw new Error("Content not found");
		throw new ContentMutationConflictError();
	}

	private async deleteUnstagedRevision(
		revisionRepo: RevisionRepository,
		type: string,
		id: string,
		revisionId: string,
	): Promise<void> {
		try {
			await revisionRepo.deleteIfUnreferenced(type, id, revisionId);
		} catch (error) {
			console.error(`[content] Failed to clean up unstaged revision ${revisionId}:`, error);
		}
	}

	private async replaceDraftRevisionForUpdate(
		type: string,
		id: string,
		revisionId: string,
		expected: ContentItem,
		input: UpdateContentInput,
	): Promise<boolean> {
		const tableName = getTableName(type);
		const assignments = [sql`draft_revision_id = ${revisionId}`];
		let liveMetadataChanged = false;

		if (input.status !== undefined) {
			assignments.push(sql`status = ${input.status}`);
			liveMetadataChanged = true;
		}
		if (input.slug === null) {
			assignments.push(sql`slug = NULL`);
			liveMetadataChanged = true;
		}
		if (input.publishedAt !== undefined) {
			assignments.push(sql`published_at = ${input.publishedAt}`);
			liveMetadataChanged = true;
		}
		if (input.scheduledAt !== undefined) {
			assignments.push(sql`scheduled_at = ${input.scheduledAt}`);
			liveMetadataChanged = true;
		}
		if (input.authorId !== undefined) {
			assignments.push(sql`author_id = ${input.authorId}`);
			liveMetadataChanged = true;
		}
		if (input.primaryBylineId !== undefined) {
			assignments.push(sql`primary_byline_id = ${input.primaryBylineId}`);
			liveMetadataChanged = true;
		}
		if (liveMetadataChanged) assignments.push(sql`updated_at = ${new Date().toISOString()}`);
		assignments.push(sql`version = version + 1`);

		const result = await sql`
			UPDATE ${sql.ref(tableName)}
			SET ${sql.join(assignments, sql`, `)}
			WHERE id = ${id}
			AND deleted_at IS NULL
			AND version = ${expected.version}
			AND ${nullableColumnMatch("live_revision_id", expected.liveRevisionId)}
			AND ${nullableColumnMatch("draft_revision_id", expected.draftRevisionId)}
			AND EXISTS (
				SELECT 1 FROM revisions
				WHERE revisions.id = ${revisionId}
				AND revisions.collection = ${type}
				AND revisions.entry_id = ${id}
			)
		`.execute(this.db);

		const changed = (result.numAffectedRows ?? 0n) > 0n;
		if (changed && liveMetadataChanged) invalidateCollectionCache(type);
		return changed;
	}

	/**
	 * Delete content (soft delete - moves to trash)
	 */
	async delete(type: string, id: string): Promise<boolean> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		const result = await sql`
			UPDATE ${sql.ref(tableName)}
			SET deleted_at = ${now}
			WHERE id = ${id}
			AND deleted_at IS NULL
		`.execute(this.db);

		const changed = (result.numAffectedRows ?? 0n) > 0n;
		if (changed) {
			invalidateCollectionCache(type);
		}
		return changed;
	}

	/**
	 * Restore content from trash
	 */
	async restore(type: string, id: string): Promise<ContentItem | null> {
		const tableName = getTableName(type);

		const result = await sql<Record<string, unknown>>`
			UPDATE ${sql.ref(tableName)}
			SET deleted_at = NULL
			WHERE id = ${id}
			AND deleted_at IS NOT NULL
			RETURNING *
		`.execute(this.db);

		const restored = result.rows[0];
		if (!restored) return null;

		invalidateCollectionCache(type);
		return this.mapRow(type, restored);
	}

	/**
	 * Permanently delete content (cannot be undone)
	 */
	/**
	 * Permanently delete a soft-deleted content row.
	 *
	 * Returns `true` only when a soft-deleted (trashed) row was removed.
	 * Returns `false` when no row exists OR when the row exists but is live —
	 * the caller is responsible for distinguishing these cases (typically via
	 * a follow-up `findByIdOrSlugIncludingTrashed` to surface NOT_FOUND vs
	 * NOT_TRASHED). The `AND deleted_at IS NOT NULL` clause is the safety net
	 * that prevents permanent delete from bypassing the trash workflow.
	 */
	async permanentDelete(type: string, id: string): Promise<boolean> {
		const tableName = getTableName(type);

		const result = await sql`
			DELETE FROM ${sql.ref(tableName)}
			WHERE id = ${id}
			AND deleted_at IS NOT NULL
		`.execute(this.db);

		const changed = (result.numAffectedRows ?? 0n) > 0n;
		if (changed) invalidateCollectionCache(type);
		return changed;
	}

	/**
	 * Find trashed content items
	 */
	async findTrashed(
		type: string,
		options: Omit<FindManyOptions, "where"> = {},
	): Promise<FindManyResult<ContentItem & { deletedAt: string }>> {
		const tableName = getTableName(type);
		const limit = Math.min(options.limit || 50, 100);

		// Determine ordering - default to most recently deleted
		const orderField = options.orderBy?.field || "deletedAt";
		const orderDirection = options.orderBy?.direction || "desc";
		const dbField = this.mapOrderField(orderField);

		const safeOrderDirection = orderDirection.toLowerCase() === "asc" ? "ASC" : "DESC";

		let query = this.db
			.selectFrom(tableName as keyof Database)
			.selectAll()
			.where("deleted_at" as never, "is not", null);

		// Handle cursor pagination — decodeCursor throws on invalid input.
		if (options.cursor) {
			const { orderValue, id: cursorId } = decodeCursor(options.cursor);

			if (safeOrderDirection === "DESC") {
				query = query.where((eb) =>
					eb.or([
						eb(dbField as any, "<", orderValue),
						eb.and([eb(dbField as any, "=", orderValue), eb("id", "<", cursorId)]),
					]),
				);
			} else {
				query = query.where((eb) =>
					eb.or([
						eb(dbField as any, ">", orderValue),
						eb.and([eb(dbField as any, "=", orderValue), eb("id", ">", cursorId)]),
					]),
				);
			}
		}

		query = query
			.orderBy(dbField as any, safeOrderDirection === "ASC" ? "asc" : "desc")
			.orderBy("id", safeOrderDirection === "ASC" ? "asc" : "desc")
			.limit(limit + 1);

		const rows = await query.execute();
		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit);

		const mappedResult: FindManyResult<ContentItem & { deletedAt: string }> = {
			items: items.map((row) => {
				const record = row as Record<string, unknown>;
				return {
					...this.mapRow(type, record),
					deletedAt: typeof record.deleted_at === "string" ? record.deleted_at : "",
				};
			}),
		};

		if (hasMore && items.length > 0) {
			const lastRow = items.at(-1) as Record<string, unknown>;
			const lastOrderValue = lastRow[dbField];
			const orderStr =
				typeof lastOrderValue === "string" || typeof lastOrderValue === "number"
					? String(lastOrderValue)
					: "";
			mappedResult.nextCursor = encodeCursor(orderStr, String(lastRow.id));
		}

		return mappedResult;
	}

	/**
	 * Count trashed content items
	 */
	async countTrashed(type: string): Promise<number> {
		const tableName = getTableName(type);

		const result = await this.db
			.selectFrom(tableName as keyof Database)
			.select((eb) => eb.fn.count("id").as("count"))
			.where("deleted_at" as never, "is not", null)
			.executeTakeFirst();

		return Number(result?.count || 0);
	}

	/**
	 * Apply the optional `q` filter.
	 *
	 * When the handler sets `useFts` (collection has a healthy FTS5 index
	 * covering the display columns; SQLite only), the filter is served from
	 * the index: a token-prefix MATCH against `_emdash_fts_<slug>` OR'd with
	 * an index-served `slug GLOB 'term*'` prefix (the slug is not in the FTS
	 * index). Both sides are index-backed, so SQLite's OR optimization avoids
	 * the full-table scan the LIKE fallback needs (#1517). The trade-off is
	 * search semantics: token-prefix matching instead of arbitrary substring.
	 *
	 * Fallback (Postgres, search disabled, or no usable terms): case-
	 * insensitive substring LIKE across the handler-resolved `searchColumns`
	 * (OR'd). User input is treated literally (LIKE wildcards escaped) and
	 * `lower()` is applied on both sides for SQLite/Postgres parity.
	 */
	private applySearchFilter<QB extends { where: (cb: (eb: any) => unknown) => QB }>(
		query: QB,
		where: { q?: string; searchColumns?: string[]; useFts?: boolean } | undefined,
		type: string,
	): QB {
		const term = where?.q?.trim();
		const columns = where?.searchColumns;
		if (!term || !columns || columns.length === 0) return query;

		if (where.useFts) {
			const match = buildFtsPrefixMatch(term);
			if (match) {
				validateIdentifier(type, "collection slug");
				const ftsTable = `_emdash_fts_${type}`;
				const slugPrefix = buildSlugGlobPrefix(term);
				return query.where((eb) =>
					eb.or([
						sql<boolean>`id IN (SELECT id FROM ${sql.ref(ftsTable)} WHERE ${sql.ref(ftsTable)} MATCH ${match})`,
						sql<boolean>`slug GLOB ${slugPrefix}`,
					]),
				);
			}
			// No usable terms (e.g. quotes only) — fall through to LIKE.
		}

		const escaped = term.replace(LIKE_WILDCARD_RE, (c) => `\\${c}`);
		const pattern = `%${escaped}%`;

		return query.where((eb) =>
			eb.or(
				columns.map((col) => {
					validateIdentifier(col, "search column");
					return sql<boolean>`lower(CAST(${sql.ref(col)} AS TEXT)) LIKE lower(${pattern}) ESCAPE '\\'`;
				}),
			),
		);
	}

	/**
	 * Apply the optional inclusive date-range filter. The field is mapped
	 * through `DATE_FILTER_COLUMNS` (a closed whitelist), and bounds compare
	 * lexicographically against the stored ISO 8601 timestamps. A `publishedAt`
	 * range naturally excludes never-published rows (their column is NULL).
	 */
	private applyDateFilter<QB extends { where: (cb: (eb: any) => unknown) => QB }>(
		query: QB,
		where?: { dateFilter?: { field: string; from?: string; to?: string } },
	): QB {
		const filter = where?.dateFilter;
		if (!filter) return query;
		const column = DATE_FILTER_COLUMNS[filter.field as ContentDateField];
		if (!column) {
			throw new EmDashValidationError(`Invalid date filter field: ${filter.field}`);
		}
		const { from, to } = filter;
		if (!from && !to) return query;

		let next = query;
		if (from) next = next.where((eb) => eb(column as any, ">=", from));
		if (to) next = next.where((eb) => eb(column as any, "<=", to));
		return next;
	}

	/**
	 * Apply the optional byline filter as a correlated (NOT) EXISTS against
	 * `_emdash_content_bylines`.
	 *
	 * Correlating from the content table preserves the outer sort index so
	 * `LIMIT` can short-circuit. `mode: "none"` tests the junction rather than
	 * `primary_byline_id` because the two are written in the same call but
	 * are not atomically consistent, so the junction is authoritative.
	 *
	 * Whether a credit *renders* is locale-scoped; whether one *exists* is
	 * not. Both are needed: the first decides what the filter matches, the
	 * second decides whether the author fallback applies at all.
	 */
	private applyBylineFilter<QB extends { where: (cb: (eb: any) => unknown) => QB }>(
		query: QB,
		where: { bylineFilter?: ContentBylineFilter } | undefined,
		type: string,
	): QB {
		const filter = where?.bylineFilter;
		if (!filter) return query;
		const tableName = getTableName(type);
		const idColumn = `${tableName}.id`;
		const authorColumn = `${tableName}.author_id`;
		const localeColumn = `${tableName}.locale`;

		// An explicit credit that actually renders — optionally within a given
		// set of translation groups. The junction stores a group, but a credit
		// resolves only where that group has a byline row at the locale the
		// list is scoped to, so this repeats the join `getContentBylinesMany`
		// makes. `locale` falls back to each entry's own when the list spans
		// locales.
		const creditRenders = (eb: any, bylineIds?: string[]) => {
			let sub = eb
				.selectFrom("_emdash_content_bylines as cb")
				.innerJoin("_emdash_bylines as b", "b.translation_group", "cb.byline_id")
				.select("cb.id")
				.where("cb.collection_slug", "=", type)
				.whereRef("cb.content_id", "=", idColumn);
			sub = filter.locale
				? sub.where("b.locale", "=", filter.locale)
				: sub.whereRef("b.locale", "=", localeColumn);
			if (bylineIds) sub = sub.where("cb.byline_id", "in", bylineIds);
			return eb.exists(sub);
		};

		// Whether the entry carries an explicit credit at all, at any locale.
		// Deliberately not locale-scoped: the author fallback is suppressed by
		// the presence of a junction row, even one that renders nothing here
		// (`hydrateBylinesMany` gates inference on `primaryBylineId`).
		const hasExplicitCredit = (eb: any) =>
			eb.exists(
				eb
					.selectFrom("_emdash_content_bylines as cb")
					.select("cb.id")
					.where("cb.collection_slug", "=", type)
					.whereRef("cb.content_id", "=", idColumn),
			);

		// The entry's author owns a byline row — optionally within a given set
		// of translation groups — at the locale the list is scoped to. Matching
		// the locale is what keeps the filter agreeing with the list: an
		// inferred credit renders only when the author's byline has a row at
		// that locale (`hydrateBylinesMany` -> `findByUserIds`), and byline
		// translations start life with a null `user_id`, so a group translated
		// into the locale but not re-linked resolves to no credit. `locale`
		// falls back to each entry's own when the list spans locales.
		const authorHasByline = (eb: any, bylineIds?: string[]) => {
			let sub = eb
				.selectFrom("_emdash_bylines as b")
				.select("b.id")
				.whereRef("b.user_id", "=", authorColumn);
			sub = filter.locale
				? sub.where("b.locale", "=", filter.locale)
				: sub.whereRef("b.locale", "=", localeColumn);
			if (bylineIds) sub = sub.where("b.translation_group", "in", bylineIds);
			return eb.exists(sub);
		};

		if (filter.mode === "none") {
			return query.where((eb: any) => {
				const uncredited = eb.not(creditRenders(eb));
				// With inference on, "no byline" means none is rendered, so an
				// entry that falls through to an author byline is excluded too.
				return filter.includeInferred
					? eb.and([uncredited, eb.or([hasExplicitCredit(eb), eb.not(authorHasByline(eb))])])
					: uncredited;
			});
		}

		const bylineIds = filter.bylineIds ?? [];
		if (bylineIds.length === 0) {
			// A filter that resolved to no ids must match nothing rather than
			// silently degrade to "no filter" and return the whole collection.
			return query.where(() => sql<boolean>`1 = 0`);
		}

		return query.where((eb: any) => {
			if (!filter.includeInferred) return creditRenders(eb, bylineIds);
			// Inference applies only where no explicit credit exists, so an
			// entry credited to someone else never matches on its author.
			return eb.or([
				creditRenders(eb, bylineIds),
				eb.and([eb.not(hasExplicitCredit(eb)), authorHasByline(eb, bylineIds)]),
			]);
		});
	}

	/**
	 * Count content items
	 */
	async count(type: string, where?: FindManyOptions["where"]): Promise<number> {
		const resolvedFieldFilters = await this.resolveFieldFilters(type, where?.fieldFilters);
		return this.countWithResolvedFilters(type, where, resolvedFieldFilters);
	}

	private async countWithResolvedFilters(
		type: string,
		where: FindManyOptions["where"] | undefined,
		resolvedFieldFilters: ResolvedFieldFilter[],
	): Promise<number> {
		const tableName = getTableName(type);

		let query = this.db
			.selectFrom(tableName as keyof Database)
			.select((eb) => eb.fn.count("id").as("count"))
			.where("deleted_at" as never, "is", null);

		if (where?.status) {
			query = query.where("status", "=", where.status);
		}

		if (where?.authorId) {
			query = query.where("author_id", "=", where.authorId);
		}

		if (where?.locale) {
			query = query.where("locale" as any, "=", where.locale);
		}

		query = this.applySearchFilter(query, where, type);
		query = this.applyDateFilter(query, where);
		query = this.applyBylineFilter(query, where, type);
		query = this.applyFieldFilters(query, resolvedFieldFilters);

		const result = await query.executeTakeFirst();
		return Number(result?.count || 0);
	}

	/**
	 * Distinct, non-null `author_id` values across the collection's live
	 * (non-trashed) content. Used to populate the admin author filter with
	 * only the users who have actually authored entries, rather than the
	 * full user directory (which requires admin privileges to read).
	 */
	async findDistinctAuthorIds(type: string): Promise<string[]> {
		const tableName = getTableName(type);

		const rows = await this.db
			.selectFrom(tableName as keyof Database)
			.select("author_id")
			.distinct()
			.where("deleted_at" as never, "is", null)
			.where("author_id" as never, "is not", null)
			.execute();

		return rows.map((row) => row.author_id).filter((id): id is string => id !== null);
	}

	// get overall statistics for a content type in a single query
	async getStats(
		type: string,
		now = new Date(),
	): Promise<{
		total: number;
		published: number;
		draft: number;
		scheduled: number;
		overdueScheduled: number;
	}> {
		const tableName = getTableName(type);
		const nowIso = now.toISOString();

		const result = await this.db
			.selectFrom(tableName as keyof Database)
			.select((eb) => [
				eb.fn.count("id").as("total"),
				eb.fn.sum(eb.case().when("status", "=", "published").then(1).else(0).end()).as("published"),
				eb.fn.sum(eb.case().when("status", "=", "draft").then(1).else(0).end()).as("draft"),
				sql<number>`SUM(CASE WHEN scheduled_at IS NOT NULL THEN 1 ELSE 0 END)`.as("scheduled"),
				sql<number>`SUM(CASE WHEN scheduled_at IS NOT NULL AND scheduled_at <= ${nowIso} THEN 1 ELSE 0 END)`.as(
					"overdue_scheduled",
				),
			])
			.where("deleted_at" as never, "is", null)
			.executeTakeFirst();

		return {
			total: Number(result?.total || 0),
			published: Number(result?.published || 0),
			draft: Number(result?.draft || 0),
			scheduled: Number(result?.scheduled || 0),
			overdueScheduled: Number(result?.overdue_scheduled || 0),
		};
	}

	/**
	 * Schedule content for future publishing
	 *
	 * Sets status to 'scheduled' and stores the scheduled publish time.
	 * The content will be auto-published when the scheduled time is reached.
	 */
	async schedule(type: string, id: string, scheduledAt: string): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		// Validate scheduledAt is in the future
		const scheduledDate = new Date(scheduledAt);
		if (isNaN(scheduledDate.getTime())) {
			throw new EmDashValidationError("Invalid scheduled date");
		}
		if (scheduledDate <= new Date()) {
			throw new EmDashValidationError("Scheduled date must be in the future");
		}

		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}

		// Published posts keep their status — the schedule applies to the
		// pending draft, not the currently-live revision. Unpublished posts
		// transition to 'scheduled' so they aren't visible before the time.
		const newStatus = existing.status === "published" ? "published" : "scheduled";

		await sql`
			UPDATE ${sql.ref(tableName)}
			SET status = ${newStatus},
				scheduled_at = ${scheduledAt},
				updated_at = ${now}
			WHERE id = ${id}
			AND deleted_at IS NULL
		`.execute(this.db);

		invalidateCollectionCache(type);

		const updated = await this.findById(type, id);
		if (!updated) {
			throw new Error("Content not found");
		}

		return updated;
	}

	/**
	 * Unschedule content
	 *
	 * Clears the scheduled time. Published posts stay published;
	 * draft/scheduled posts revert to 'draft'.
	 */
	async unschedule(type: string, id: string): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}

		// Published posts keep their status — just clear the pending schedule.
		// Draft/scheduled posts revert to 'draft'.
		const newStatus = existing.status === "published" ? "published" : "draft";

		await sql`
			UPDATE ${sql.ref(tableName)}
			SET status = ${newStatus},
				scheduled_at = NULL,
				updated_at = ${now}
			WHERE id = ${id}
			AND scheduled_at IS NOT NULL
			AND deleted_at IS NULL
		`.execute(this.db);

		invalidateCollectionCache(type);

		const updated = await this.findById(type, id);
		if (!updated) {
			throw new Error("Content not found");
		}

		return updated;
	}

	/**
	 * Find content that is ready to be published
	 *
	 * Returns all content where scheduled_at <= now, regardless of status.
	 * This covers both draft-scheduled posts (status='scheduled') and
	 * published posts with scheduled draft changes (status='published').
	 *
	 * `limit` (optional) caps how many due rows are returned, oldest-due first.
	 * The scheduled-publishing sweep passes a limit so a large backlog can't
	 * fan out unbounded publish/webhook work in a single tick (and blow a Worker
	 * invocation's CPU/subrequest budget); the remainder drains on later ticks.
	 */
	async findReadyToPublish(type: string, limit?: number): Promise<ContentItem[]> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		// Embed an empty fragment when unbounded so callers that want every due
		// row (manual flows, tests) keep the original behaviour.
		const limitClause =
			typeof limit === "number" && Number.isInteger(limit) && limit > 0
				? sql`LIMIT ${limit}`
				: sql``;

		const result = await sql<Record<string, unknown>>`
			SELECT * FROM ${sql.ref(tableName)}
			WHERE scheduled_at IS NOT NULL
			AND scheduled_at <= ${now}
			AND deleted_at IS NULL
			ORDER BY scheduled_at ASC
			${limitClause}
		`.execute(this.db);

		return result.rows.map((row) => this.mapRow(type, row));
	}

	/**
	 * Find all translations in a translation group
	 */
	async findTranslations(type: string, translationGroup: string): Promise<ContentItem[]> {
		const tableName = getTableName(type);

		const result = await sql<Record<string, unknown>>`
			SELECT * FROM ${sql.ref(tableName)}
			WHERE translation_group = ${translationGroup}
			AND deleted_at IS NULL
			ORDER BY locale ASC
		`.execute(this.db);

		return result.rows.map((row) => this.mapRow(type, row));
	}

	/**
	 * Batch variant of {@link findTranslations}: every (non-deleted) locale
	 * variant for any of `translationGroups`, in one `WHERE translation_group IN
	 * (...)` query chunked at `SQL_BATCH_SIZE` for D1's bind-parameter limit.
	 * Lets callers resolve many edge groups without an N+1 per group. The caller
	 * groups the flat result by `translationGroup` itself.
	 *
	 * `translation_group` leads the sort so the ordering follows
	 * `idx_{table}_del_tg_locale` past its `deleted_at` equality; callers group by
	 * `translationGroup`, so the per-group locale order they rely on is preserved.
	 *
	 * `publishedOnly` restricts the result to `status = 'published'` — reference
	 * reads pass this for callers without `content:read_drafts` so draft/scheduled
	 * entries never leak through an edge traversal.
	 *
	 * A reference edge stores only a collection slug (no SQL FK), so the table may
	 * have been dropped since the edge was written. That is a tolerated dangling
	 * state, not an error: a missing table resolves to no rows, mirroring how the
	 * content read handlers treat `isMissingTableError`.
	 */
	async findTranslationsForGroups(
		type: string,
		translationGroups: string[],
		options: { publishedOnly?: boolean } = {},
	): Promise<ContentItem[]> {
		if (translationGroups.length === 0) return [];
		const tableName = getTableName(type);
		const publishedFilter = options.publishedOnly ? sql`AND status = 'published'` : sql``;

		const items: ContentItem[] = [];
		try {
			for (const chunk of chunks(translationGroups, SQL_BATCH_SIZE)) {
				const result = await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
					WHERE translation_group IN (${sql.join(chunk)})
					AND deleted_at IS NULL
					${publishedFilter}
					ORDER BY translation_group ASC, locale ASC
				`.execute(this.db);
				for (const row of result.rows) items.push(this.mapRow(type, row));
			}
		} catch (error) {
			if (isMissingTableError(error)) return [];
			throw error;
		}
		return items;
	}

	/**
	 * Batch variant of {@link findByIdOrSlug}: resolve many identifiers (each an
	 * id OR a slug) within `type` in a constant number of queries — one `WHERE id
	 * IN (...)` and one `WHERE slug IN (...)`, each chunked at `SQL_BATCH_SIZE`.
	 * Returns a map from the input identifier to its resolved item; identifiers
	 * that match nothing are absent. Used on write paths that accept a list of
	 * references, so a single request doesn't fan out to an N+1 of point lookups.
	 *
	 * Resolution mirrors {@link findByIdOrSlug}: a ULID-shaped identifier prefers
	 * the id match and falls back to slug; anything else prefers the slug match
	 * and falls back to id. Slug matches collapse to the lowest-locale variant
	 * (`ORDER BY locale ASC`), matching the slug-without-locale lookup.
	 */
	async findManyByIdOrSlug(type: string, identifiers: string[]): Promise<Map<string, ContentItem>> {
		const resolved = new Map<string, ContentItem>();
		const unique = [...new Set(identifiers)];
		if (unique.length === 0) return resolved;

		const tableName = getTableName(type);
		const byId = new Map<string, ContentItem>();
		const bySlug = new Map<string, ContentItem>();

		try {
			for (const chunk of chunks(unique, SQL_BATCH_SIZE)) {
				const idRows = await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
					WHERE id IN (${sql.join(chunk)})
					AND deleted_at IS NULL
				`.execute(this.db);
				for (const row of idRows.rows) {
					const item = this.mapRow(type, row);
					byId.set(item.id, item);
				}

				const slugRows = await sql<Record<string, unknown>>`
					SELECT * FROM ${sql.ref(tableName)}
					WHERE slug IN (${sql.join(chunk)})
					AND deleted_at IS NULL
					ORDER BY locale ASC
				`.execute(this.db);
				for (const row of slugRows.rows) {
					const item = this.mapRow(type, row);
					// First write wins → lowest locale, matching findBySlug without a locale.
					if (item.slug != null && !bySlug.has(item.slug)) bySlug.set(item.slug, item);
				}
			}
		} catch (error) {
			// A collection dropped after a relation was created leaves the relation
			// pointing at a missing table. Treat it like an empty collection (no
			// matches) so callers surface a structured NOT_FOUND, not a 500 —
			// mirroring findTranslationsForGroups.
			if (isMissingTableError(error)) return resolved;
			throw error;
		}

		for (const identifier of unique) {
			const looksLikeUlid = ULID_PATTERN.test(identifier);
			const item = looksLikeUlid
				? (byId.get(identifier) ?? bySlug.get(identifier))
				: (bySlug.get(identifier) ?? byId.get(identifier));
			if (item) resolved.set(identifier, item);
		}
		return resolved;
	}

	/**
	 * Publish the current draft
	 *
	 * Promotes draft_revision_id to live_revision_id and clears draft pointer.
	 * Syncs the draft revision's data into the content table columns so the
	 * content table always reflects the published version.
	 * If no draft revision exists, creates one from current data and publishes it.
	 * When `promoteRevision` is false, publishes the current content-table data
	 * by changing lifecycle metadata only.
	 *
	 * `publishedAt` (optional) overrides the publication timestamp. If omitted,
	 * the existing `published_at` is preserved (idempotent re-publish keeps the
	 * original date) and falls back to the current time on first publish. Pass
	 * an explicit value to backdate a publish (e.g. when migrating content from
	 * another CMS).
	 *
	 * `requireDue` gates the final update on the row still being due.
	 * `expectedScheduledAt` additionally fences changes made after a sweep
	 * selected the row but before publication preparation began.
	 */
	async publish(
		type: string,
		id: string,
		publishedAt?: string,
		requireDue = false,
		expectedScheduledAt?: string,
		promoteRevision = true,
		requireSlug = true,
	): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}
		if (
			requireDue &&
			expectedScheduledAt !== undefined &&
			existing.scheduledAt !== expectedScheduledAt
		) {
			throw new ScheduledNotDueError();
		}
		if (!promoteRevision && requireSlug && !existing.slug?.trim()) {
			throw new EmDashValidationError("Cannot publish routable content without a slug");
		}

		if (!promoteRevision) {
			const revisionRepo = new RevisionRepository(this.db);
			let provisionalRevisionId: string | null = null;
			try {
				let liveRevisionId = existing.liveRevisionId;
				if (!liveRevisionId) {
					const revision = await revisionRepo.create({
						collection: type,
						entryId: id,
						data: existing.data,
					});
					liveRevisionId = revision.id;
					provisionalRevisionId = revision.id;
				}

				const intendedPublishedAt = publishedAt ?? existing.publishedAt ?? now;
				const duePredicate = requireDue
					? sql`AND scheduled_at IS NOT NULL AND scheduled_at <= ${now}`
					: sql``;
				let published = false;
				try {
					const result = await sql`
						UPDATE ${sql.ref(tableName)}
						SET live_revision_id = ${liveRevisionId},
							draft_revision_id = NULL,
							status = 'published',
							scheduled_at = NULL,
							published_at = ${intendedPublishedAt},
							updated_at = ${now},
							version = version + 1
						WHERE id = ${id}
						AND deleted_at IS NULL
						AND version = ${existing.version}
						AND status = ${existing.status}
						AND ${nullableColumnMatch("live_revision_id", existing.liveRevisionId)}
						AND ${nullableColumnMatch("draft_revision_id", existing.draftRevisionId)}
						AND ${nullableColumnMatch("scheduled_at", existing.scheduledAt)}
						${duePredicate}
					`.execute(this.db);
					published = (result.numAffectedRows ?? 0n) > 0n;
				} catch (error) {
					if (isConfirmedStatementFailure(error)) throw error;
					let observed: ContentItem | null;
					try {
						observed = await this.findById(type, id);
					} catch (reconciliationError) {
						throw new Error("Unable to confirm whether content publication completed", {
							cause: reconciliationError,
						});
					}
					if (!observed) {
						throw new Error("Unable to confirm whether content publication completed", {
							cause: error,
						});
					}
					published = matchesLifecyclePublication(
						observed,
						existing,
						liveRevisionId,
						intendedPublishedAt,
						now,
					);
					if (!published && matchesPublicationFence(observed, existing)) throw error;
					if (!published) {
						throw new Error("Unable to confirm whether content publication completed", {
							cause: error,
						});
					}
				}

				if (!published) {
					throw requireDue ? new ScheduledNotDueError() : new ContentMutationConflictError();
				}

				invalidateCollectionCache(type);
				const updated = await this.findById(type, id);
				if (!updated) throw new Error("Content not found");
				return updated;
			} catch (error) {
				if (provisionalRevisionId) {
					try {
						await revisionRepo.deleteIfUnreferenced(type, id, provisionalRevisionId);
					} catch (cleanupError) {
						console.error(
							`[content] Failed to clean up provisional revision ${provisionalRevisionId}:`,
							cleanupError,
						);
					}
				}
				throw error;
			}
		}

		const revisionRepo = new RevisionRepository(this.db);
		let provisionalRevisionId: string | null = null;
		try {
			let revisionToPublish = existing.draftRevisionId || existing.liveRevisionId;

			if (!revisionToPublish) {
				const revision = await revisionRepo.create({
					collection: type,
					entryId: id,
					data: existing.data,
				});
				revisionToPublish = revision.id;
				provisionalRevisionId = revision.id;
			}

			const revision = await revisionRepo.findById(revisionToPublish);
			if (!revision || revision.collection !== type || revision.entryId !== id) {
				throw new EmDashValidationError("Revision does not belong to the specified content item");
			}

			const stagedSlug = typeof revision.data._slug === "string" ? revision.data._slug : null;
			const intendedSlug = stagedSlug ?? existing.slug;
			if (requireSlug && !intendedSlug?.trim()) {
				throw new EmDashValidationError("Cannot publish routable content without a slug");
			}
			const intendedPublishedAt = publishedAt ?? existing.publishedAt ?? now;
			if (stagedSlug !== null && stagedSlug !== existing.slug && existing.locale !== null) {
				const conflict = await this.findBySlugIncludingTrashed(type, stagedSlug, existing.locale);
				if (conflict && conflict.id !== id) {
					throw new EmDashValidationError(
						`Cannot publish: slug '${stagedSlug}' is already used by another entry` +
							` in this collection (id: ${conflict.id}). Choose a different slug.`,
						{ code: "SLUG_CONFLICT" },
					);
				}
			}

			const assignments: ReturnType<typeof sql>[] = [];
			if (stagedSlug !== null) assignments.push(sql`slug = ${stagedSlug}`);
			for (const [key, value] of Object.entries(revision.data)) {
				if (SYSTEM_COLUMNS.has(key) || key.startsWith("_")) continue;
				validateIdentifier(key, "content field name");
				assignments.push(sql`${sql.ref(key)} = ${serializeValue(value)}`);
			}
			assignments.push(
				sql`live_revision_id = ${revisionToPublish}`,
				sql`draft_revision_id = NULL`,
				sql`status = 'published'`,
				sql`scheduled_at = NULL`,
				sql`published_at = ${intendedPublishedAt}`,
				sql`updated_at = ${now}`,
				sql`version = version + 1`,
			);

			const duePredicate = requireDue
				? sql`AND scheduled_at IS NOT NULL AND scheduled_at <= ${now}`
				: sql``;
			let promoted = false;
			try {
				const result = await sql`
					UPDATE ${sql.ref(tableName)}
					SET ${sql.join(assignments, sql`, `)}
					WHERE id = ${id}
					AND deleted_at IS NULL
					AND version = ${existing.version}
					AND status = ${existing.status}
					AND ${nullableColumnMatch("live_revision_id", existing.liveRevisionId)}
					AND ${nullableColumnMatch("draft_revision_id", existing.draftRevisionId)}
					AND ${nullableColumnMatch("scheduled_at", existing.scheduledAt)}
					${duePredicate}
					AND EXISTS (
						SELECT 1 FROM revisions
						WHERE revisions.id = ${revisionToPublish}
						AND revisions.collection = ${type}
						AND revisions.entry_id = ${id}
					)
				`.execute(this.db);
				promoted = (result.numAffectedRows ?? 0n) > 0n;
			} catch (error) {
				if (isConfirmedStatementFailure(error)) throw error;
				let observed: ContentItem | null;
				try {
					observed = await this.findById(type, id);
				} catch (reconciliationError) {
					throw new Error("Unable to confirm whether content publication completed", {
						cause: reconciliationError,
					});
				}
				if (!observed) {
					throw new Error("Unable to confirm whether content publication completed", {
						cause: error,
					});
				}
				promoted = matchesPublication(
					observed,
					existing,
					revision,
					revisionToPublish,
					intendedSlug,
					intendedPublishedAt,
					now,
				);
				if (!promoted && matchesPublicationFence(observed, existing)) throw error;
				if (!promoted) {
					throw new Error("Unable to confirm whether content publication completed", {
						cause: error,
					});
				}
			}

			if (!promoted) {
				throw requireDue ? new ScheduledNotDueError() : new ContentMutationConflictError();
			}

			invalidateCollectionCache(type);
			const updated = await this.findById(type, id);
			if (!updated) {
				throw new Error("Content not found");
			}

			return updated;
		} catch (error) {
			if (provisionalRevisionId) {
				try {
					await revisionRepo.deleteIfUnreferenced(type, id, provisionalRevisionId);
				} catch (cleanupError) {
					console.error(
						`[content] Failed to clean up provisional revision ${provisionalRevisionId}:`,
						cleanupError,
					);
				}
			}
			throw error;
		}
	}

	/**
	 * Unpublish content
	 *
	 * Removes live pointer but preserves draft. If no draft exists,
	 * creates one from the live version so the content isn't lost.
	 */
	async unpublish(type: string, id: string): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}

		// If no draft exists, create one from the live version
		if (!existing.draftRevisionId && existing.liveRevisionId) {
			const revisionRepo = new RevisionRepository(this.db);
			const liveRevision = await revisionRepo.findById(existing.liveRevisionId);
			if (liveRevision) {
				const draft = await revisionRepo.create({
					collection: type,
					entryId: id,
					data: liveRevision.data,
				});

				await sql`
					UPDATE ${sql.ref(tableName)}
					SET draft_revision_id = ${draft.id}
					WHERE id = ${id}
				`.execute(this.db);
			}
		}

		await sql`
			UPDATE ${sql.ref(tableName)}
			SET live_revision_id = NULL,
				status = 'draft',
				published_at = NULL,
				updated_at = ${now}
			WHERE id = ${id}
			AND deleted_at IS NULL
		`.execute(this.db);

		invalidateCollectionCache(type);

		const updated = await this.findById(type, id);
		if (!updated) {
			throw new Error("Content not found");
		}

		return updated;
	}

	/**
	 * Set the draft revision pointer for a content item.
	 *
	 * Used by seed/import paths that stage a new revision's data before
	 * promoting it to live via `publish()`.
	 *
	 * Validates that the content item exists and is not soft-deleted, that
	 * the revision exists, and that the revision belongs to the same
	 * collection and entry. Without these checks, a caller could leave the
	 * content row pointing at a missing or unrelated revision.
	 */
	async setDraftRevision(type: string, id: string, revisionId: string): Promise<void> {
		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}

		const revisionRepo = new RevisionRepository(this.db);
		const revision = await revisionRepo.findById(revisionId);
		if (!revision) {
			throw new EmDashValidationError("Revision not found");
		}

		if (revision.collection !== type || revision.entryId !== id) {
			throw new EmDashValidationError("Revision does not belong to the specified content item");
		}

		if (!(await this.replaceDraftRevision(type, id, revisionId, existing))) {
			throw new ContentMutationConflictError();
		}
	}

	async replaceDraftRevision(
		type: string,
		id: string,
		revisionId: string,
		expected: Pick<ContentItem, "version" | "liveRevisionId" | "draftRevisionId">,
	): Promise<boolean> {
		const tableName = getTableName(type);
		const result = await sql`
			UPDATE ${sql.ref(tableName)}
			SET draft_revision_id = ${revisionId},
				version = version + 1
			WHERE id = ${id}
			AND deleted_at IS NULL
			AND version = ${expected.version}
			AND ${nullableColumnMatch("live_revision_id", expected.liveRevisionId)}
			AND ${nullableColumnMatch("draft_revision_id", expected.draftRevisionId)}
			AND EXISTS (
				SELECT 1 FROM revisions
				WHERE revisions.id = ${revisionId}
				AND revisions.collection = ${type}
				AND revisions.entry_id = ${id}
			)
		`.execute(this.db);
		return (result.numAffectedRows ?? 0n) > 0n;
	}

	/**
	 * Discard pending draft changes
	 *
	 * Clears draft_revision_id. The content table columns already hold the
	 * published version, so no data sync is needed.
	 */
	async discardDraft(type: string, id: string): Promise<ContentItem> {
		const tableName = getTableName(type);

		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}

		if (!existing.draftRevisionId) {
			// No draft to discard
			return existing;
		}

		// Discarding a draft restores the state from before the draft was
		// staged — nothing about the live entry changed in between, so
		// updated_at stays at its pre-draft value (#2143).
		await sql`
			UPDATE ${sql.ref(tableName)}
			SET draft_revision_id = NULL
			WHERE id = ${id}
			AND deleted_at IS NULL
		`.execute(this.db);

		const updated = await this.findById(type, id);
		if (!updated) {
			throw new Error("Content not found");
		}

		return updated;
	}

	/**
	 * Count content items with a pending schedule.
	 * Includes both draft-scheduled (status='scheduled') and published
	 * posts with scheduled draft changes (status='published', scheduled_at set).
	 */
	async countScheduled(type: string): Promise<number> {
		const tableName = getTableName(type);

		const result = await sql<{ count: number }>`
			SELECT COUNT(id) as count FROM ${sql.ref(tableName)}
			WHERE scheduled_at IS NOT NULL
			AND deleted_at IS NULL
		`.execute(this.db);

		return Number(result.rows[0]?.count || 0);
	}

	/**
	 * Map database row to ContentItem
	 * Extracts system columns and puts content fields in data
	 * Excludes null values from data to match input semantics
	 */
	private mapRow(type: string, row: Record<string, unknown>): ContentItem {
		const data: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(row)) {
			if (!SYSTEM_COLUMNS.has(key) && value !== null) {
				data[key] = deserializeValue(value);
			}
		}

		return {
			id: row.id as string,
			type,
			slug: row.slug as string | null,
			status: row.status as string,
			data,
			authorId: row.author_id as string | null,
			primaryBylineId: (row.primary_byline_id as string | null) ?? null,
			createdAt: row.created_at as string,
			updatedAt: row.updated_at as string,
			publishedAt: row.published_at as string | null,
			scheduledAt: row.scheduled_at as string | null,
			liveRevisionId: (row.live_revision_id as string | null) ?? null,
			draftRevisionId: (row.draft_revision_id as string | null) ?? null,
			version: typeof row.version === "number" ? row.version : 1,
			locale: (row.locale as string) ?? null,
			translationGroup: (row.translation_group as string) ?? null,
		};
	}

	private normalizeFilterScalar(
		field: string,
		type: FieldType,
		value: unknown,
	): NormalizedFilterScalar {
		if (type === "number" || type === "integer") {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new EmDashValidationError(`Filter for field "${field}" must use a finite number`);
			}
			if (type === "integer" && !Number.isInteger(value)) {
				throw new EmDashValidationError(`Filter for field "${field}" must use an integer`);
			}
			return value;
		}

		if (type === "boolean") {
			if (typeof value !== "boolean") {
				throw new EmDashValidationError(`Filter for field "${field}" must use a boolean`);
			}
			return value ? 1 : 0;
		}

		if (typeof value !== "string") {
			throw new EmDashValidationError(`Filter for field "${field}" must use a string`);
		}
		if (value.length > MAX_FILTER_STRING_LENGTH) {
			throw new EmDashValidationError(
				`Filter value for field "${field}" exceeds ${MAX_FILTER_STRING_LENGTH} characters`,
			);
		}
		return value;
	}

	private normalizeFieldFilter(
		field: string,
		type: FieldType,
		value: ContentFieldFilterValue,
	): ResolvedFieldFilter {
		if (value === null) return { column: field, kind: "null" };
		if (typeof value !== "object") {
			return {
				column: field,
				kind: "exact",
				value: this.normalizeFilterScalar(field, type, value),
			};
		}
		if (Array.isArray(value)) {
			throw new EmDashValidationError(`Invalid filter for field "${field}"`);
		}

		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length === 1 && keys[0] === "in") {
			if (!Array.isArray(record.in) || record.in.length === 0) {
				throw new EmDashValidationError(`IN filter for field "${field}" must not be empty`);
			}
			if (record.in.length > MAX_IN_FILTER_VALUES) {
				throw new EmDashValidationError(
					`IN filter for field "${field}" exceeds ${MAX_IN_FILTER_VALUES} values`,
				);
			}
			return {
				column: field,
				kind: "in",
				values: record.in.map((entry) => this.normalizeFilterScalar(field, type, entry)),
			};
		}

		const rangeKeys = new Set(["gt", "gte", "lt", "lte"]);
		if (keys.length === 0 || keys.some((key) => !rangeKeys.has(key))) {
			throw new EmDashValidationError(`Invalid filter operator for field "${field}"`);
		}
		if (type === "boolean") {
			throw new EmDashValidationError(`Boolean field "${field}" does not support range filters`);
		}

		const bounds: Partial<Record<"gt" | "gte" | "lt" | "lte", NormalizedFilterScalar>> = {};
		for (const key of keys as Array<"gt" | "gte" | "lt" | "lte">) {
			if (record[key] === undefined) continue;
			bounds[key] = this.normalizeFilterScalar(field, type, record[key]);
		}
		if (Object.keys(bounds).length === 0) {
			throw new EmDashValidationError(`Range filter for field "${field}" has no bounds`);
		}
		return { column: field, kind: "range", bounds };
	}

	private async collectionExists(type: string): Promise<boolean> {
		const collection = await this.db
			.selectFrom("_emdash_collections")
			.where("slug", "=", type)
			.select("id")
			.executeTakeFirst();
		return collection !== undefined;
	}

	private async resolveFieldFilters(
		type: string,
		filters: ContentFieldFilters | undefined,
	): Promise<ResolvedFieldFilter[]> {
		const resolvedFilters = filters ?? {};
		const fields = Object.keys(resolvedFilters);
		if (fields.length === 0) return [];
		if (fields.length > MAX_INDEXED_FIELD_FILTERS) {
			if (!(await this.collectionExists(type))) return [];
			throw new EmDashValidationError(
				`Content list queries support at most ${MAX_INDEXED_FIELD_FILTERS} indexed field filters`,
			);
		}
		const rows = await this.db
			.selectFrom("_emdash_fields as field")
			.innerJoin("_emdash_collections as collection", "collection.id", "field.collection_id")
			.where("collection.slug", "=", type)
			.where("field.slug", "in", fields)
			.where("field.indexed", "=", 1)
			.select(["field.slug", "field.type"])
			.execute();
		const metadata = new Map(rows.map((row) => [row.slug, row.type as FieldType]));

		if (metadata.size === 0 && !(await this.collectionExists(type))) return [];

		for (const field of fields) {
			try {
				validateIdentifier(field, "content filter field");
			} catch {
				throw new EmDashValidationError(`Invalid content filter field: ${field}`);
			}
		}

		const normalized = fields.map((field) => {
			const fieldType = metadata.get(field);
			if (!fieldType || !isIndexableFieldType(fieldType)) {
				throw new EmDashValidationError(
					`Cannot filter by field "${field}". Custom fields must be indexed before filtering.`,
				);
			}
			return this.normalizeFieldFilter(field, fieldType, resolvedFilters[field]);
		});
		const operandCount = normalized.reduce((total, filter) => {
			if (filter.kind === "null") return total;
			if (filter.kind === "exact") return total + 1;
			if (filter.kind === "in") return total + filter.values.length;
			return total + Object.keys(filter.bounds).length;
		}, 0);
		if (operandCount > SQL_BATCH_SIZE) {
			throw new EmDashValidationError(
				`Indexed field filters have a total operand budget of ${SQL_BATCH_SIZE}`,
			);
		}
		return normalized;
	}

	private applyFieldFilters<QB extends { where: (cb: (eb: any) => unknown) => QB }>(
		query: QB,
		filters: ResolvedFieldFilter[],
	): QB {
		let next = query;
		for (const filter of filters) {
			const column = sql.ref(filter.column);
			const isPresent = sql<boolean>`${column} IS NOT NULL`;
			if (filter.kind === "null") {
				next = next.where(() => sql<boolean>`(${isPresent}) = FALSE AND ${column} IS NULL`);
				continue;
			}
			if (filter.kind === "exact") {
				next = next.where(
					() => sql<boolean>`(${isPresent}) = TRUE AND ${column} = ${filter.value}`,
				);
				continue;
			}
			if (filter.kind === "in") {
				const values = sql.join(
					filter.values.map((value) => sql`${value}`),
					sql`, `,
				);
				next = next.where(() => sql<boolean>`(${isPresent}) = TRUE AND ${column} IN (${values})`);
				continue;
			}

			next = next.where(() => sql<boolean>`(${isPresent}) = TRUE`);
			if (filter.bounds.gt !== undefined) {
				next = next.where(() => sql<boolean>`${column} > ${filter.bounds.gt}`);
			}
			if (filter.bounds.gte !== undefined) {
				next = next.where(() => sql<boolean>`${column} >= ${filter.bounds.gte}`);
			}
			if (filter.bounds.lt !== undefined) {
				next = next.where(() => sql<boolean>`${column} < ${filter.bounds.lt}`);
			}
			if (filter.bounds.lte !== undefined) {
				next = next.where(() => sql<boolean>`${column} <= ${filter.bounds.lte}`);
			}
		}
		return next;
	}

	/**
	 * Map order field names to database columns.
	 * Only allows known fields to prevent column enumeration via crafted orderBy values.
	 */
	private mapOrderField(field: string, sortableExtras: readonly string[] = []): string {
		const mapped = ORDER_FIELD_COLUMNS[field];
		if (mapped) return mapped;

		// A collection's configured titleField/dateField are allowed as
		// sort columns. The caller passes the collection's *actual* values (resolved
		// server-side, never client-supplied), so this stays a closed set per
		// request and doesn't reopen the column-enumeration hole. The slug is a
		// validated identifier that maps directly to the column.
		if (sortableExtras.includes(field)) {
			validateIdentifier(field, "order field");
			return field;
		}

		throw new EmDashValidationError(`Invalid order field: ${field}`);
	}

	private async resolveOrderField(
		type: string,
		field: string,
		sortableExtras: readonly string[] = [],
	): Promise<ResolvedOrderField> {
		try {
			return { column: this.mapOrderField(field, sortableExtras), indexedCustomField: false };
		} catch (error) {
			if (!(error instanceof EmDashValidationError)) throw error;
		}

		const customField = await this.db
			.selectFrom("_emdash_collections as collection")
			.leftJoin("_emdash_fields as field", (join) =>
				join
					.onRef("field.collection_id", "=", "collection.id")
					.on("field.slug", "=", field)
					.on("field.indexed", "=", 1),
			)
			.where("collection.slug", "=", type)
			.select(["collection.id as collectionId", "field.slug as fieldSlug"])
			.executeTakeFirst();

		if (!customField) {
			throw new ContentCollectionNotFoundError(type);
		}

		if (!customField.fieldSlug) {
			throw new EmDashValidationError(
				`Invalid order field: ${field}. Custom fields must be indexed before sorting.`,
			);
		}

		validateIdentifier(customField.fieldSlug, "content order field");
		return { column: customField.fieldSlug, indexedCustomField: true };
	}
}
