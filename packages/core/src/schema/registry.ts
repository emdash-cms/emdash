import type { Kysely } from "kysely";
import type { Selectable } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";

import { currentTimestamp, listTablesLike, tableExists } from "../database/dialect-helpers.js";
import { withTransaction } from "../database/transaction.js";
import type { CollectionTable, Database, FieldTable } from "../database/types.js";
import { FTSManager } from "../search/fts-manager.js";
import {
	type Collection,
	type CollectionSource,
	type ColumnType,
	type Field,
	type CreateCollectionInput,
	type UpdateCollectionInput,
	type CreateFieldInput,
	type UpdateFieldInput,
	type CollectionWithFields,
	type FieldType,
	FIELD_TYPE_TO_COLUMN,
	RESERVED_FIELD_SLUGS,
	RESERVED_COLLECTION_SLUGS,
} from "./types.js";

// Regex patterns for schema registry
const SLUG_VALIDATION_PATTERN = /^[a-z][a-z0-9_]*$/;
const EC_PREFIX_PATTERN = /^ec_/;
const SINGLE_QUOTE_PATTERN = /'/g;
const UNDERSCORE_PATTERN = /_/g;
const WORD_BOUNDARY_PATTERN = /\b\w/g;

/** Valid column types for runtime validation */
const COLUMN_TYPES: ReadonlySet<string> = new Set(["TEXT", "REAL", "INTEGER", "JSON"]);

/** Valid collection source prefixes/values */
const VALID_SOURCES: ReadonlySet<string> = new Set(["manual", "discovered", "seed"]);

function isCollectionSource(value: string): value is CollectionSource {
	return VALID_SOURCES.has(value) || value.startsWith("template:") || value.startsWith("import:");
}

function isFieldType(value: string): value is FieldType {
	return value in FIELD_TYPE_TO_COLUMN;
}

function isColumnType(value: string): value is ColumnType {
	return COLUMN_TYPES.has(value);
}

/**
 * Error thrown when a schema operation fails
 */
export class SchemaError extends Error {
	constructor(
		message: string,
		public code: string,
		public details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "SchemaError";
	}
}

/**
 * Schema Registry
 *
 * Manages collection and field definitions stored in D1.
 * Handles runtime DDL operations (CREATE TABLE, ALTER TABLE).
 */
export class SchemaRegistry {
	constructor(private db: Kysely<Database>) {}

	// ============================================
	// Collection Operations
	// ============================================

	/**
	 * List all collections
	 */
	async listCollections(): Promise<Collection[]> {
		const rows = await this.db
			.selectFrom("_emdash_collections")
			.selectAll()
			.orderBy("slug", "asc")
			.execute();

		return rows.map(this.mapCollectionRow);
	}

	/**
	 * Get a collection by slug
	 */
	async getCollection(slug: string): Promise<Collection | null> {
		const row = await this.db
			.selectFrom("_emdash_collections")
			.where("slug", "=", slug)
			.selectAll()
			.executeTakeFirst();

		return row ? this.mapCollectionRow(row) : null;
	}

	/**
	 * Get a collection with all its fields
	 */
	async getCollectionWithFields(slug: string): Promise<CollectionWithFields | null> {
		const collection = await this.getCollection(slug);
		if (!collection) return null;

		const fields = await this.listFields(collection.id);

		return { ...collection, fields };
	}

	/**
	 * Create a new collection
	 */
	async createCollection(input: CreateCollectionInput): Promise<Collection> {
		// Validate slug
		this.validateSlug(input.slug, "collection");
		if (RESERVED_COLLECTION_SLUGS.includes(input.slug)) {
			throw new SchemaError(`Collection slug "${input.slug}" is reserved`, "RESERVED_SLUG");
		}

		// Check if collection already exists
		const existing = await this.getCollection(input.slug);
		if (existing) {
			throw new SchemaError(`Collection "${input.slug}" already exists`, "COLLECTION_EXISTS");
		}

		const id = ulid();

		// Insert collection record and create content table in a transaction
		// so a failure in table creation doesn't leave an orphaned row.
		// Uses withTransaction for D1 compatibility (no transaction support).
		// Derive hasSeo from supports array if not explicitly set
		const hasSeo = input.hasSeo ?? input.supports?.includes("seo") ?? false;

		await withTransaction(this.db, async (trx) => {
			await trx
				.insertInto("_emdash_collections")
				.values({
					id,
					slug: input.slug,
					label: input.label,
					label_singular: input.labelSingular ?? null,
					description: input.description ?? null,
					icon: input.icon ?? null,
					supports: input.supports ? JSON.stringify(input.supports) : null,
					source: input.source ?? "manual",
					has_seo: hasSeo ? 1 : 0,
					comments_enabled: input.commentsEnabled ? 1 : 0,
					url_pattern: input.urlPattern ?? null,
				})
				.execute();

			// Create the content table for this collection
			await this.createContentTable(input.slug, trx);
		});

		const collection = await this.getCollection(input.slug);
		if (!collection) {
			throw new SchemaError("Failed to create collection", "CREATE_FAILED");
		}

		return collection;
	}

	/**
	 * Update a collection
	 */
	async updateCollection(slug: string, input: UpdateCollectionInput): Promise<Collection> {
		const existing = await this.getCollection(slug);
		if (!existing) {
			throw new SchemaError(`Collection "${slug}" not found`, "COLLECTION_NOT_FOUND");
		}

		const now = new Date().toISOString();

		// Derive hasSeo from supports array if supports is being updated and hasSeo not explicitly set
		const supportsArray = input.supports ?? existing.supports;
		const hasSeo =
			input.hasSeo !== undefined
				? input.hasSeo
				: input.supports !== undefined
					? supportsArray.includes("seo")
					: existing.hasSeo;

		await this.db
			.updateTable("_emdash_collections")
			.set({
				label: input.label ?? existing.label,
				label_singular: input.labelSingular ?? existing.labelSingular ?? null,
				description: input.description ?? existing.description ?? null,
				icon: input.icon ?? existing.icon ?? null,
				supports: input.supports
					? JSON.stringify(input.supports)
					: JSON.stringify(existing.supports),
				url_pattern:
					input.urlPattern !== undefined
						? (input.urlPattern ?? null)
						: (existing.urlPattern ?? null),
				has_seo: hasSeo ? 1 : 0,
				comments_enabled:
					input.commentsEnabled !== undefined
						? input.commentsEnabled
							? 1
							: 0
						: existing.commentsEnabled
							? 1
							: 0,
				comments_moderation: input.commentsModeration ?? existing.commentsModeration,
				comments_closed_after_days:
					input.commentsClosedAfterDays !== undefined
						? input.commentsClosedAfterDays
						: existing.commentsClosedAfterDays,
				comments_auto_approve_users:
					input.commentsAutoApproveUsers !== undefined
						? input.commentsAutoApproveUsers
							? 1
							: 0
						: existing.commentsAutoApproveUsers
							? 1
							: 0,
				updated_at: now,
			})
			.where("slug", "=", slug)
			.execute();

		const updated = await this.getCollection(slug);
		if (!updated) {
			throw new SchemaError("Failed to update collection", "UPDATE_FAILED");
		}

		// Sync FTS state when the supports array changes (e.g. search toggled on/off)
		if (input.supports !== undefined) {
			const hadSearch = existing.supports.includes("search");
			const hasSearch = updated.supports.includes("search");
			if (hadSearch !== hasSearch) {
				await this.syncSearchState(slug);
			}
		}

		return updated;
	}

	/**
	 * Delete a collection
	 */
	async deleteCollection(slug: string, options?: { force?: boolean }): Promise<void> {
		const existing = await this.getCollection(slug);
		if (!existing) {
			throw new SchemaError(`Collection "${slug}" not found`, "COLLECTION_NOT_FOUND");
		}

		// Check if collection has content
		if (!options?.force) {
			const hasContent = await this.collectionHasContent(slug);
			if (hasContent) {
				throw new SchemaError(
					`Collection "${slug}" has content. Use force: true to delete.`,
					"COLLECTION_HAS_CONTENT",
				);
			}
		}

		// Drop the content table
		await this.dropContentTable(slug);

		// Delete the collection record (fields will cascade)
		await this.db.deleteFrom("_emdash_collections").where("id", "=", existing.id).execute();
	}

	// ============================================
	// Field Operations
	// ============================================

	/**
	 * List fields for a collection
	 */
	async listFields(collectionId: string): Promise<Field[]> {
		const rows = await this.db
			.selectFrom("_emdash_fields")
			.where("collection_id", "=", collectionId)
			.selectAll()
			.orderBy("sort_order", "asc")
			.orderBy("created_at", "asc")
			.execute();

		return rows.map(this.mapFieldRow);
	}

	/**
	 * Get a field by slug within a collection
	 */
	async getField(collectionSlug: string, fieldSlug: string): Promise<Field | null> {
		const collection = await this.getCollection(collectionSlug);
		if (!collection) return null;

		const row = await this.db
			.selectFrom("_emdash_fields")
			.where("collection_id", "=", collection.id)
			.where("slug", "=", fieldSlug)
			.selectAll()
			.executeTakeFirst();

		return row ? this.mapFieldRow(row) : null;
	}

	/**
	 * Create a new field
	 */
	async createField(collectionSlug: string, input: CreateFieldInput): Promise<Field> {
		const collection = await this.getCollection(collectionSlug);
		if (!collection) {
			throw new SchemaError(`Collection "${collectionSlug}" not found`, "COLLECTION_NOT_FOUND");
		}

		// Validate slug
		this.validateSlug(input.slug, "field");
		if (RESERVED_FIELD_SLUGS.includes(input.slug)) {
			throw new SchemaError(`Field slug "${input.slug}" is reserved`, "RESERVED_SLUG");
		}

		// Check if field already exists
		const existing = await this.getField(collectionSlug, input.slug);
		if (existing) {
			throw new SchemaError(
				`Field "${input.slug}" already exists in collection "${collectionSlug}"`,
				"FIELD_EXISTS",
			);
		}

		const id = ulid();
		const columnType = FIELD_TYPE_TO_COLUMN[input.type];

		// Get max sort order
		const maxSort = await this.db
			.selectFrom("_emdash_fields")
			.where("collection_id", "=", collection.id)
			.select((eb) => eb.fn.max<number>("sort_order").as("max"))
			.executeTakeFirst();

		const sortOrder = input.sortOrder ?? (maxSort?.max ?? -1) + 1;

		// Insert field record
		await this.db
			.insertInto("_emdash_fields")
			.values({
				id,
				collection_id: collection.id,
				slug: input.slug,
				label: input.label,
				type: input.type,
				column_type: columnType,
				required: input.required ? 1 : 0,
				unique: input.unique ? 1 : 0,
				default_value: input.defaultValue !== undefined ? JSON.stringify(input.defaultValue) : null,
				validation: input.validation ? JSON.stringify(input.validation) : null,
				widget: input.widget ?? null,
				options: input.options ? JSON.stringify(input.options) : null,
				sort_order: sortOrder,
				searchable: input.searchable ? 1 : 0,
				translatable: input.translatable === false ? 0 : 1,
			})
			.execute();

		// Add column to content table
		await this.addColumn(collectionSlug, input.slug, input.type, {
			required: input.required,
			defaultValue: input.defaultValue,
		});

		const field = await this.getField(collectionSlug, input.slug);
		if (!field) {
			throw new SchemaError("Failed to create field", "CREATE_FAILED");
		}

		// Sync search state if this field is searchable; support checks are handled by syncSearchState()
		if (input.searchable) {
			await this.syncSearchState(collectionSlug);
		}

		return field;
	}

	/**
	 * Update a field
	 */
	async updateField(
		collectionSlug: string,
		fieldSlug: string,
		input: UpdateFieldInput,
	): Promise<Field> {
		const field = await this.getField(collectionSlug, fieldSlug);
		if (!field) {
			throw new SchemaError(
				`Field "${fieldSlug}" not found in collection "${collectionSlug}"`,
				"FIELD_NOT_FOUND",
			);
		}

		await this.db
			.updateTable("_emdash_fields")
			.set({
				label: input.label ?? field.label,
				required: input.required !== undefined ? (input.required ? 1 : 0) : field.required ? 1 : 0,
				unique: input.unique !== undefined ? (input.unique ? 1 : 0) : field.unique ? 1 : 0,
				searchable:
					input.searchable !== undefined ? (input.searchable ? 1 : 0) : field.searchable ? 1 : 0,
				translatable:
					input.translatable !== undefined
						? input.translatable
							? 1
							: 0
						: field.translatable
							? 1
							: 0,
				default_value:
					input.defaultValue !== undefined
						? JSON.stringify(input.defaultValue)
						: field.defaultValue !== undefined
							? JSON.stringify(field.defaultValue)
							: null,
				validation: input.validation
					? JSON.stringify(input.validation)
					: field.validation
						? JSON.stringify(field.validation)
						: null,
				widget: input.widget ?? field.widget ?? null,
				options: input.options
					? JSON.stringify(input.options)
					: field.options
						? JSON.stringify(field.options)
						: null,
				sort_order: input.sortOrder ?? field.sortOrder,
			})
			.where("id", "=", field.id)
			.execute();

		const updated = await this.getField(collectionSlug, fieldSlug);
		if (!updated) {
			throw new SchemaError("Failed to update field", "UPDATE_FAILED");
		}

		// If searchable changed, sync FTS state for this collection
		const searchableChanged =
			input.searchable !== undefined && input.searchable !== field.searchable;
		if (searchableChanged) {
			await this.syncSearchState(collectionSlug);
		}

		return updated;
	}

	/**
	 * Synchronize FTS state with the collection's current supports and searchable fields.
	 *
	 * Called whenever supports or searchable fields change. Reconciles user intent
	 * (supports includes "search") with FTS implementation reality.
	 *
	 * - supports search + has searchable fields → enable or rebuild FTS
	 * - supports search + no searchable fields  → disable FTS if active
	 * - does not support search                 → disable FTS if active
	 */
	private async syncSearchState(collectionSlug: string): Promise<void> {
		const ftsManager = new FTSManager(this.db);
		const collection = await this.getCollection(collectionSlug);
		if (!collection) return;

		const wantsSearch = collection.supports.includes("search");
		const searchableFields = await ftsManager.getSearchableFields(collectionSlug);
		const config = await ftsManager.getSearchConfig(collectionSlug);
		const ftsActive = config?.enabled === true;

		if (wantsSearch && searchableFields.length > 0) {
			if (ftsActive) {
				await ftsManager.rebuildIndex(collectionSlug, searchableFields, config?.weights);
			} else {
				await ftsManager.enableSearch(collectionSlug);
			}
		} else if (ftsActive) {
			await ftsManager.disableSearch(collectionSlug);
		}
	}

	/**
	 * Delete a field
	 */
	async deleteField(collectionSlug: string, fieldSlug: string): Promise<void> {
		const field = await this.getField(collectionSlug, fieldSlug);
		if (!field) {
			throw new SchemaError(
				`Field "${fieldSlug}" not found in collection "${collectionSlug}"`,
				"FIELD_NOT_FOUND",
			);
		}

		// Delete the field record first so syncSearchState sees the updated field list.
		// This ordering matters for searchable fields: SQLite prevents dropping a column
		// that is still referenced by a trigger. syncSearchState drops and recreates the
		// FTS triggers based on the remaining searchable fields, clearing the dependency
		// before we attempt the ALTER TABLE DROP COLUMN below.
		await this.db.deleteFrom("_emdash_fields").where("id", "=", field.id).execute();

		// If the deleted field was searchable, sync FTS state (removes old triggers)
		if (field.searchable) {
			await this.syncSearchState(collectionSlug);
		}

		// Drop column from content table — safe now because FTS triggers are gone
		await this.dropColumn(collectionSlug, fieldSlug);
	}

	/**
	 * Reorder fields
	 */
	async reorderFields(collectionSlug: string, fieldSlugs: string[]): Promise<void> {
		const collection = await this.getCollection(collectionSlug);
		if (!collection) {
			throw new SchemaError(`Collection "${collectionSlug}" not found`, "COLLECTION_NOT_FOUND");
		}

		// Update sort_order for each field
		for (let i = 0; i < fieldSlugs.length; i++) {
			await this.db
				.updateTable("_emdash_fields")
				.set({ sort_order: i })
				.where("collection_id", "=", collection.id)
				.where("slug", "=", fieldSlugs[i])
				.execute();
		}
	}

	// ============================================
	// DDL Operations
	// ============================================

	/**
	 * Create a content table for a collection
	 */
	private async createContentTable(slug: string, db?: Kysely<Database>): Promise<void> {
		const conn = db ?? this.db;
		const tableName = this.getTableName(slug);

		await conn.schema
			.createTable(tableName)
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("slug", "text")
			.addColumn("status", "text", (col) => col.defaultTo("draft"))
			.addColumn("author_id", "text")
			.addColumn("primary_byline_id", "text")
			.addColumn("created_at", "text", (col) => col.defaultTo(currentTimestamp(conn)))
			.addColumn("updated_at", "text", (col) => col.defaultTo(currentTimestamp(conn)))
			.addColumn("published_at", "text")
			.addColumn("scheduled_at", "text")
			.addColumn("deleted_at", "text")
			.addColumn("version", "integer", (col) => col.defaultTo(1))
			.addColumn("live_revision_id", "text", (col) => col.references("revisions.id"))
			.addColumn("draft_revision_id", "text", (col) => col.references("revisions.id"))
			.addColumn("locale", "text", (col) => col.notNull().defaultTo("en"))
			.addColumn("translation_group", "text")
			.addUniqueConstraint(`${tableName}_slug_locale_unique`, ["slug", "locale"])
			.execute();

		// Create standard indexes
		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_slug`)}
			ON ${sql.ref(tableName)} (slug)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_scheduled`)}
			ON ${sql.ref(tableName)} (scheduled_at)
			WHERE scheduled_at IS NOT NULL
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_live_revision`)}
			ON ${sql.ref(tableName)} (live_revision_id)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_draft_revision`)}
			ON ${sql.ref(tableName)} (draft_revision_id)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_author`)}
			ON ${sql.ref(tableName)} (author_id)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_primary_byline`)}
			ON ${sql.ref(tableName)} (primary_byline_id)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_locale`)}
			ON ${sql.ref(tableName)} (locale)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_translation_group`)}
			ON ${sql.ref(tableName)} (translation_group)
		`.execute(conn);

		// Composite indexes for optimized query performance (see migration 033)
		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_deleted_updated_id`)}
			ON ${sql.ref(tableName)} (deleted_at, updated_at DESC, id DESC)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_deleted_status`)}
			ON ${sql.ref(tableName)} (deleted_at, status)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_deleted_created_id`)}
			ON ${sql.ref(tableName)} (deleted_at, created_at DESC, id DESC)
		`.execute(conn);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${tableName}_deleted_published_id`)}
			ON ${sql.ref(tableName)} (deleted_at, published_at DESC, id DESC)
		`.execute(conn);
	}

	/**
	 * Drop a content table
	 */
	private async dropContentTable(slug: string): Promise<void> {
		const tableName = this.getTableName(slug);
		await sql`DROP TABLE IF EXISTS ${sql.ref(tableName)}`.execute(this.db);
	}

	/**
	 * Add a column to a content table
	 */
	private async addColumn(
		collectionSlug: string,
		fieldSlug: string,
		fieldType: FieldType,
		options?: { required?: boolean; defaultValue?: unknown },
	): Promise<void> {
		const tableName = this.getTableName(collectionSlug);
		const columnType = FIELD_TYPE_TO_COLUMN[fieldType];
		const columnName = this.getColumnName(fieldSlug);

		// Build ALTER TABLE statement
		// Note: SQLite requires DEFAULT for NOT NULL columns in ALTER TABLE
		if (options?.required && options?.defaultValue !== undefined) {
			const defaultVal = this.formatDefaultValue(options.defaultValue, fieldType);
			await sql`
				ALTER TABLE ${sql.ref(tableName)} 
				ADD COLUMN ${sql.ref(columnName)} ${sql.raw(columnType)} NOT NULL DEFAULT ${sql.raw(defaultVal)}
			`.execute(this.db);
		} else if (options?.required) {
			// For required fields without default, use empty string/0 as default
			const defaultVal = this.getEmptyDefault(fieldType);
			await sql`
				ALTER TABLE ${sql.ref(tableName)} 
				ADD COLUMN ${sql.ref(columnName)} ${sql.raw(columnType)} NOT NULL DEFAULT ${sql.raw(defaultVal)}
			`.execute(this.db);
		} else {
			await sql`
				ALTER TABLE ${sql.ref(tableName)} 
				ADD COLUMN ${sql.ref(columnName)} ${sql.raw(columnType)}
			`.execute(this.db);
		}
	}

	/**
	 * Drop a column from a content table
	 */
	private async dropColumn(collectionSlug: string, fieldSlug: string): Promise<void> {
		const tableName = this.getTableName(collectionSlug);
		const columnName = this.getColumnName(fieldSlug);

		await sql`
			ALTER TABLE ${sql.ref(tableName)} 
			DROP COLUMN ${sql.ref(columnName)}
		`.execute(this.db);
	}

	// ============================================
	// Helpers
	// ============================================

	/**
	 * Check if a collection has any content
	 */
	private async collectionHasContent(slug: string): Promise<boolean> {
		const tableName = this.getTableName(slug);
		try {
			const result = await sql<{ count: number }>`
				SELECT COUNT(*) as count FROM ${sql.ref(tableName)} 
				WHERE deleted_at IS NULL
			`.execute(this.db);
			return (result.rows[0]?.count ?? 0) > 0;
		} catch {
			// Table might not exist
			return false;
		}
	}

	/**
	 * Get table name for a collection
	 */
	private getTableName(slug: string): string {
		return `ec_${slug}`;
	}

	/**
	 * Get column name for a field
	 */
	private getColumnName(slug: string): string {
		return slug;
	}

	/**
	 * Validate a slug
	 */
	private validateSlug(slug: string, type: "collection" | "field"): void {
		if (!slug || typeof slug !== "string") {
			throw new SchemaError(`${type} slug is required`, "INVALID_SLUG");
		}

		if (!SLUG_VALIDATION_PATTERN.test(slug)) {
			throw new SchemaError(
				`${type} slug must start with a letter and contain only lowercase letters, numbers, and underscores`,
				"INVALID_SLUG",
			);
		}

		if (slug.length > 63) {
			throw new SchemaError(`${type} slug must be 63 characters or less`, "INVALID_SLUG");
		}
	}

	/**
	 * Format a default value for SQL.
	 *
	 * SQLite `ALTER TABLE ADD COLUMN ... DEFAULT` requires a literal constant
	 * expression — parameterized values cannot be used here. We manually escape
	 * single quotes and coerce types to ensure the output is safe.
	 *
	 * INTEGER/REAL values are coerced through `Number()` which can only produce
	 * digits, `.`, `-`, `e`, `Infinity`, or `NaN` — all safe in SQL.
	 * TEXT/JSON values have single quotes escaped via SQL standard doubling (`''`).
	 */
	private formatDefaultValue(value: unknown, fieldType: FieldType): string {
		if (value === null || value === undefined) {
			return "NULL";
		}

		const columnType = FIELD_TYPE_TO_COLUMN[fieldType];

		if (columnType === "JSON") {
			// JSON.stringify produces valid JSON; escape single quotes for SQL literal
			const json = JSON.stringify(value);
			return `'${json.replace(SINGLE_QUOTE_PATTERN, "''")}'`;
		}

		if (columnType === "INTEGER") {
			if (typeof value === "boolean") {
				return value ? "1" : "0";
			}
			const num = Number(value);
			if (!Number.isFinite(num)) {
				return "0";
			}
			return String(Math.trunc(num));
		}

		if (columnType === "REAL") {
			const num = Number(value);
			if (!Number.isFinite(num)) {
				return "0";
			}
			return String(num);
		}

		// TEXT — escape single quotes via SQL standard doubling
		let text: string;
		if (typeof value === "string") {
			text = value;
		} else if (typeof value === "number" || typeof value === "boolean") {
			text = String(value);
		} else if (typeof value === "object" && value !== null) {
			text = JSON.stringify(value);
		} else {
			text = "";
		}
		return `'${text.replace(SINGLE_QUOTE_PATTERN, "''")}'`;
	}

	/**
	 * Get empty default for a field type
	 */
	private getEmptyDefault(fieldType: FieldType): string {
		const columnType = FIELD_TYPE_TO_COLUMN[fieldType];

		switch (columnType) {
			case "INTEGER":
				return "0";
			case "REAL":
				return "0.0";
			case "JSON":
				return "'null'";
			default:
				return "''";
		}
	}

	/**
	 * Map a collection row to a Collection object
	 */
	private mapCollectionRow = (row: Selectable<CollectionTable>): Collection => {
		const moderation = row.comments_moderation;
		return {
			id: row.id,
			slug: row.slug,
			label: row.label,
			labelSingular: row.label_singular ?? undefined,
			description: row.description ?? undefined,
			icon: row.icon ?? undefined,
			supports: row.supports ? JSON.parse(row.supports) : [],
			source: row.source && isCollectionSource(row.source) ? row.source : undefined,
			hasSeo: row.has_seo === 1,
			urlPattern: row.url_pattern ?? undefined,
			commentsEnabled: row.comments_enabled === 1,
			commentsModeration:
				moderation === "all" || moderation === "first_time" || moderation === "none"
					? moderation
					: "first_time",
			commentsClosedAfterDays: row.comments_closed_after_days ?? 90,
			commentsAutoApproveUsers: row.comments_auto_approve_users === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	};

	/**
	 * Map a field row to a Field object
	 */
	private mapFieldRow = (row: Selectable<FieldTable>): Field => {
		return {
			id: row.id,
			collectionId: row.collection_id,
			slug: row.slug,
			label: row.label,
			type: isFieldType(row.type) ? row.type : "string",
			columnType: isColumnType(row.column_type) ? row.column_type : "TEXT",
			required: row.required === 1,
			unique: row.unique === 1,
			defaultValue: row.default_value ? JSON.parse(row.default_value) : undefined,
			validation: row.validation ? JSON.parse(row.validation) : undefined,
			widget: row.widget ?? undefined,
			options: row.options ? JSON.parse(row.options) : undefined,
			sortOrder: row.sort_order,
			searchable: row.searchable === 1,
			translatable: row.translatable !== 0,
			createdAt: row.created_at,
		};
	};

	// ============================================
	// Discovery
	// ============================================

	/**
	 * Discover orphaned content tables
	 *
	 * Finds ec_* tables that exist in the database but don't have a
	 * corresponding entry in _emdash_collections.
	 */
	async discoverOrphanedTables(): Promise<
		Array<{ slug: string; tableName: string; rowCount: number }>
	> {
		// Get all ec_* tables
		// Content tables are ec_* (e.g., ec_posts, ec_pages)
		// Internal tables are _emdash_* (e.g., _emdash_collections, _emdash_fts_posts)
		const allTables = await listTablesLike(this.db, "ec_%");

		// Get registered collections
		const registered = await this.listCollections();
		const registeredSlugs = new Set(registered.map((c) => c.slug));

		// Find orphans
		const orphans: Array<{
			slug: string;
			tableName: string;
			rowCount: number;
		}> = [];

		for (const tableName of allTables) {
			const slug = tableName.replace(EC_PREFIX_PATTERN, "");

			if (!registeredSlugs.has(slug)) {
				// Count rows in the orphaned table
				try {
					const countResult = await sql<{ count: number }>`
						SELECT COUNT(*) as count FROM ${sql.ref(tableName)}
						WHERE deleted_at IS NULL
					`.execute(this.db);

					orphans.push({
						slug,
						tableName,
						rowCount: countResult.rows[0]?.count ?? 0,
					});
				} catch {
					// Table might have unexpected schema, still report it
					orphans.push({
						slug,
						tableName,
						rowCount: 0,
					});
				}
			}
		}

		return orphans;
	}

	/**
	 * Register an orphaned table as a collection
	 *
	 * Creates a _emdash_collections entry for an existing ec_* table.
	 */
	async registerOrphanedTable(
		slug: string,
		options?: {
			label?: string;
			labelSingular?: string;
			description?: string;
		},
	): Promise<Collection> {
		// Verify table exists
		const tableName = this.getTableName(slug);
		const exists = await tableExists(this.db, tableName);

		if (!exists) {
			throw new SchemaError(`Table "${tableName}" does not exist`, "TABLE_NOT_FOUND");
		}

		// Check if already registered
		const existing = await this.getCollection(slug);
		if (existing) {
			throw new SchemaError(`Collection "${slug}" is already registered`, "COLLECTION_EXISTS");
		}

		// Create collection entry
		const id = ulid();
		const label = options?.label || this.slugToLabel(slug);

		await this.db
			.insertInto("_emdash_collections")
			.values({
				id,
				slug,
				label,
				label_singular: options?.labelSingular ?? null,
				description: options?.description ?? null,
				icon: null,
				supports: JSON.stringify([]),
				source: "discovered",
				has_seo: 0,
				url_pattern: null,
			})
			.execute();

		const collection = await this.getCollection(slug);
		if (!collection) {
			throw new SchemaError("Failed to register orphaned table", "REGISTER_FAILED");
		}

		return collection;
	}

	/**
	 * Convert slug to human-readable label
	 */
	private slugToLabel(slug: string): string {
		return slug
			.replace(UNDERSCORE_PATTERN, " ")
			.replace(WORD_BOUNDARY_PATTERN, (c) => c.toUpperCase());
	}
}
