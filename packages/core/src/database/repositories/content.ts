import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import { slugify } from "../../utils/slugify.js";
import type { Database } from "../types.js";
import { RevisionRepository } from "./revision.js";
import type {
	CreateContentInput,
	UpdateContentInput,
	FindManyOptions,
	FindManyResult,
	ContentItem,
} from "./types.js";
import { EmDashValidationError, encodeCursor, decodeCursor } from "./types.js";

// Regex pattern for ULID validation
const ULID_PATTERN = /^[0-9A-Z]{26}$/;

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
	"visibility",
]);

/**
 * Get the table name for a collection type
 */
function getTableName(type: string): string {
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
		const id = ulid();
		const now = new Date().toISOString();

		const {
			type,
			slug,
			data,
			status = "draft",
			visibility = "public",
			authorId,
			primaryBylineId,
			locale,
			translationOf,
			publishedAt,
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
			"visibility",
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
			visibility,
			authorId || null,
			primaryBylineId ?? null,
			now,
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
	 * Returns `null` if `baseSlug` is empty after slugification.
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

		if (looksLikeUlid) {
			// Try ID first, fall back to slug
			const byId = await findById(type, identifier);
			if (byId) return byId;
			return findBySlug(type, identifier);
		}
		// Try slug first, fall back to ID
		const bySlug = await findBySlug(type, identifier);
		if (bySlug) return bySlug;
		return findById(type, identifier);
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
		const dbField = this.mapOrderField(orderField);

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

		if (options.where?.visibility) {
			query = query.where("visibility", "=", options.where.visibility);
		}

		if (options.where?.authorId) {
			query = query.where("author_id", "=", options.where.authorId);
		}

		if (options.where?.locale) {
			query = query.where("locale" as any, "=", options.where.locale);
		}

		// Handle cursor pagination
		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded) {
				const { orderValue, id: cursorId } = decoded;

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
		query = query
			.orderBy(dbField as any, safeOrderDirection === "ASC" ? "asc" : "desc")
			.orderBy("id", safeOrderDirection === "ASC" ? "asc" : "desc")
			.limit(limit + 1);

		const rows = await query.execute();
		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit);

		const mappedResult: FindManyResult<ContentItem> = {
			items: items.map((row) => this.mapRow(type, row as Record<string, unknown>)),
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
	 * Update content
	 */
	async update(type: string, id: string, input: UpdateContentInput): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		// Build update object with parameterized values
		const updates: Record<string, unknown> = {
			updated_at: now,
			version: sql`version + 1`,
		};

		if (input.status !== undefined) {
			updates.status = input.status;
		}

		if (input.visibility !== undefined) {
			updates.visibility = input.visibility;
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
			for (const [key, value] of Object.entries(input.data)) {
				if (!SYSTEM_COLUMNS.has(key)) {
					updates[key] = serializeValue(value);
				}
			}
		}

		await this.db
			.updateTable(tableName as keyof Database)
			.set(updates)
			.where("id", "=", id)
			.where("deleted_at" as never, "is", null)
			.execute();

		const updated = await this.findById(type, id);
		if (!updated) {
			throw new Error("Content not found");
		}

		return updated;
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

		return (result.numAffectedRows ?? 0n) > 0n;
	}

	/**
	 * Restore content from trash
	 */
	async restore(type: string, id: string): Promise<boolean> {
		const tableName = getTableName(type);

		const result = await sql`
			UPDATE ${sql.ref(tableName)}
			SET deleted_at = NULL
			WHERE id = ${id}
			AND deleted_at IS NOT NULL
		`.execute(this.db);

		return (result.numAffectedRows ?? 0n) > 0n;
	}

	/**
	 * Permanently delete content (cannot be undone)
	 */
	async permanentDelete(type: string, id: string): Promise<boolean> {
		const tableName = getTableName(type);

		const result = await sql`
			DELETE FROM ${sql.ref(tableName)}
			WHERE id = ${id}
		`.execute(this.db);

		return (result.numAffectedRows ?? 0n) > 0n;
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

		// Handle cursor pagination
		if (options.cursor) {
			const decoded = decodeCursor(options.cursor);
			if (decoded) {
				const { orderValue, id: cursorId } = decoded;

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
	 * Count content items
	 */
	async count(
		type: string,
		where?: { status?: string; authorId?: string; locale?: string },
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

		const result = await query.executeTakeFirst();
		return Number(result?.count || 0);
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
	 */
	async findReadyToPublish(type: string): Promise<ContentItem[]> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		const result = await sql<Record<string, unknown>>`
			SELECT * FROM ${sql.ref(tableName)}
			WHERE scheduled_at IS NOT NULL
			AND scheduled_at <= ${now}
			AND deleted_at IS NULL
			ORDER BY scheduled_at ASC
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
	 * Publish the current draft
	 *
	 * Promotes draft_revision_id to live_revision_id and clears draft pointer.
	 * Syncs the draft revision's data into the content table columns so the
	 * content table always reflects the published version.
	 * If no draft revision exists, creates one from current data and publishes it.
	 */
	async publish(type: string, id: string): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}

		const revisionRepo = new RevisionRepository(this.db);
		let revisionToPublish = existing.draftRevisionId || existing.liveRevisionId;

		if (!revisionToPublish) {
			// No revision exists - create one from current data
			const revision = await revisionRepo.create({
				collection: type,
				entryId: id,
				data: existing.data,
			});
			revisionToPublish = revision.id;
		}

		// Sync the revision's data into the content table columns
		// so the content table always holds the published version
		const revision = await revisionRepo.findById(revisionToPublish);
		if (revision) {
			await this.syncDataColumns(type, id, revision.data);

			// Sync slug from revision if stored there
			if (typeof revision.data._slug === "string") {
				await sql`
					UPDATE ${sql.ref(tableName)}
					SET slug = ${revision.data._slug}
					WHERE id = ${id}
				`.execute(this.db);
			}
		}

		await sql`
			UPDATE ${sql.ref(tableName)}
			SET live_revision_id = ${revisionToPublish},
				draft_revision_id = NULL,
				status = 'published',
				scheduled_at = NULL,
				published_at = COALESCE(published_at, ${now}),
				updated_at = ${now}
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
				updated_at = ${now}
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
	 * Discard pending draft changes
	 *
	 * Clears draft_revision_id. The content table columns already hold the
	 * published version, so no data sync is needed.
	 */
	async discardDraft(type: string, id: string): Promise<ContentItem> {
		const tableName = getTableName(type);
		const now = new Date().toISOString();

		const existing = await this.findById(type, id);
		if (!existing) {
			throw new EmDashValidationError("Content item not found");
		}

		if (!existing.draftRevisionId) {
			// No draft to discard
			return existing;
		}

		await sql`
			UPDATE ${sql.ref(tableName)}
			SET draft_revision_id = NULL,
				updated_at = ${now}
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
	 * Sync data columns in the content table from a data object.
	 * Used to promote revision data into the content table on publish.
	 * Keys starting with _ are revision metadata (e.g. _slug) and are skipped.
	 */
	private async syncDataColumns(
		type: string,
		id: string,
		data: Record<string, unknown>,
	): Promise<void> {
		const tableName = getTableName(type);
		const updates: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(data)) {
			if (SYSTEM_COLUMNS.has(key)) continue;
			if (key.startsWith("_")) continue; // revision metadata
			updates[key] = serializeValue(value);
		}

		if (Object.keys(updates).length === 0) return;

		await this.db
			.updateTable(tableName as keyof Database)
			.set(updates)
			.where("id", "=", id)
			.execute();
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
			visibility: (row.visibility as string) ?? "public",
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

	/**
	 * Map order field names to database columns.
	 * Only allows known fields to prevent column enumeration via crafted orderBy values.
	 */
	private mapOrderField(field: string): string {
		const mapping: Record<string, string> = {
			createdAt: "created_at",
			updatedAt: "updated_at",
			publishedAt: "published_at",
			scheduledAt: "scheduled_at",
			deletedAt: "deleted_at",
			title: "title",
			slug: "slug",
		};

		const mapped = mapping[field];
		if (!mapped) {
			throw new EmDashValidationError(`Invalid order field: ${field}`);
		}
		return mapped;
	}
}
