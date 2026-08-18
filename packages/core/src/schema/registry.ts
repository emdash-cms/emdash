import type {
	ColumnDataType,
	CreateTableBuilder,
	Insertable,
	Kysely,
	Selectable,
	Updateable,
} from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";

import { currentTimestamp, listTablesLike, tableExists } from "../database/dialect-helpers.js";
import { withTransaction } from "../database/transaction.js";
import type { CollectionTable, Database, FieldTable } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import {
	canResumeMediaUsageCollectionCapture,
	finalizeMediaUsageCollectionCapture,
	installPreparedMediaUsageCollectionCapture,
	markMediaUsageCollectionCaptureReady,
	prepareMediaUsageCollectionCapture,
} from "../media/usage/activation.js";
import {
	deleteActivatedMediaUsageCollection,
	isMediaUsageCollectionSlugDeleting,
} from "../media/usage/collection-deletion.js";
import {
	deleteContentMediaUsageCollection,
	invalidateContentMediaUsageSchemaChange,
	markContentMediaUsageCollectionStaleSafely,
} from "../media/usage/content-refresh.js";
import { FTSManager } from "../search/fts-manager.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import {
	type Collection,
	type CollectionAdminConfig,
	type CollectionSource,
	type CollectionSupport,
	type ColumnType,
	type Field,
	type CreateCollectionInput,
	type UpdateCollectionInput,
	type CreateFieldInput,
	type UpdateFieldInput,
	type CollectionWithFields,
	type FieldType,
	FIELD_TYPE_TO_COLUMN,
	isIndexableFieldType,
	RESERVED_FIELD_SLUGS,
	RESERVED_COLLECTION_SLUGS,
} from "./types.js";

// Regex patterns for schema registry
const SLUG_VALIDATION_PATTERN = /^[a-z][a-z0-9_]*$/;
const EC_PREFIX_PATTERN = /^ec_/;
const SINGLE_QUOTE_PATTERN = /'/g;
const UNDERSCORE_PATTERN = /_/g;
const WORD_BOUNDARY_PATTERN = /\b\w/g;
const FIELD_ID_PATTERN = /^[0-9A-Z]{26}$/;

/** Valid column types for runtime validation */
const COLUMN_TYPES: ReadonlySet<string> = new Set(["TEXT", "REAL", "INTEGER", "JSON"]);
const COLUMN_TYPE_TO_DATA_TYPE = {
	TEXT: "text",
	REAL: "real",
	INTEGER: "integer",
	JSON: "json",
} satisfies Record<ColumnType, ColumnDataType>;
const TEXT_ALIAS_FIELD_TYPES: ReadonlySet<FieldType> = new Set(["string", "text", "slug"]);

/** Field types usable as a `titleField` — plain text that reads well as a title. */
const TITLE_FIELD_TYPES: ReadonlySet<string> = new Set(["string", "text", "slug"]);

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

const VALID_COLLECTION_SUPPORTS: ReadonlySet<string> = new Set<CollectionSupport>([
	"drafts",
	"revisions",
	"preview",
	"scheduling",
	"search",
	"seo",
]);

// Each _emdash_fields row uses 16 bound parameters. Six rows keep every
// multi-row INSERT below D1's 100-parameter statement limit.
const SEED_FIELD_INSERT_BATCH_SIZE = 6;

/**
 * Rank given to collections without an explicit `sort_order`. SQLite sorts
 * NULL first on ASC while Postgres sorts it last, so the fallback is
 * materialised with COALESCE rather than left to the dialect.
 */
const UNORDERED_COLLECTION_RANK = 2147483647;

/**
 * Collection ordering shared by every list read: explicit `sort_order`
 * first (ascending), then alphabetically by slug.
 */
const collectionOrder = sql<number>`coalesce(sort_order, ${sql.lit(UNORDERED_COLLECTION_RANK)})`;

function assertIndexableField(type: FieldType, indexed: boolean | undefined, slug: string): void {
	if (indexed && !isIndexableFieldType(type)) {
		throw new SchemaError(
			`Field "${slug}" cannot be indexed because type "${type}" is not a scalar query type`,
			"FIELD_NOT_INDEXABLE",
		);
	}
}

function isCollectionSupport(value: unknown): value is CollectionSupport {
	return typeof value === "string" && VALID_COLLECTION_SUPPORTS.has(value);
}

/**
 * Parse a collection's `supports` column (stored as a JSON array of
 * CollectionSupport keys). Unknown/invalid entries are filtered out so the
 * runtime value matches the declared `CollectionSupport[]` type.
 *
 * Throws on malformed JSON so corruption surfaces loudly; returns an empty
 * array only for explicitly null/empty values or non-array JSON.
 */
function parseSupports(raw: string | null | undefined): CollectionSupport[] {
	if (!raw) return [];
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isCollectionSupport);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCollectionAdmin(raw: string | null | undefined): CollectionAdminConfig | undefined {
	if (!raw) return undefined;
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) return undefined;
	const listColumns = parsed.listColumns;
	return {
		listColumns: Array.isArray(listColumns)
			? listColumns.filter((value): value is string => typeof value === "string")
			: undefined,
	};
}

export async function buildSeedCollectionCaptureFingerprint(
	input: Omit<CreateCollectionInput, "source">,
	fields: readonly CreateFieldInput[],
): Promise<string> {
	const supports = input.supports ?? ["drafts", "revisions"];
	const hasSeo = input.hasSeo ?? supports.includes("seo") ?? false;
	let maxSortOrder = -1;
	const definitions = fields.map((field) => {
		const sortOrder = field.sortOrder ?? maxSortOrder + 1;
		maxSortOrder = Math.max(maxSortOrder, sortOrder);
		return {
			slug: field.slug,
			label: field.label,
			type: field.type,
			required: field.required ?? false,
			unique: field.unique ?? false,
			defaultValue: field.defaultValue === undefined ? null : JSON.stringify(field.defaultValue),
			validation: field.validation ? JSON.stringify(field.validation) : null,
			widget: field.widget ?? null,
			options: field.options ? JSON.stringify(field.options) : null,
			sortOrder,
			searchable: field.searchable ?? false,
			translatable: field.translatable ?? true,
		};
	});
	const payload = JSON.stringify(
		canonicalizeFingerprintValue({
			version: 1,
			collection: {
				slug: input.slug,
				label: input.label,
				labelSingular: input.labelSingular ?? null,
				description: input.description ?? null,
				icon: input.icon ?? null,
				admin: input.admin ?? null,
				supports,
				hasSeo,
				hidden: input.hidden ?? false,
				sortOrder: input.sortOrder ?? null,
				commentsEnabled: input.commentsEnabled ?? false,
				urlPattern: input.urlPattern ?? null,
				routable: input.routable ?? true,
			},
			fields: definitions,
		}),
	);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
	return `media-usage-seed:v1:sha256:${hex}`;
}

function canonicalizeFingerprintValue(value: unknown): unknown {
	if (value === undefined) return { __emdashUndefined: true };
	if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
	if (typeof value !== "object" || value === null) return value;

	const canonical: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))) {
		canonical[key] = canonicalizeFingerprintValue(entry);
	}
	return canonical;
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
			.orderBy(collectionOrder, "asc")
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
	 * List every collection together with its fields in O(1) query shapes
	 * — one for collections, then one batched query for the fields of every
	 * returned collection — instead of the N+1 pattern of `listCollections`
	 * + per-collection `listFields`. The fields query is chunked at
	 * `SQL_BATCH_SIZE` to stay under D1's bound-parameter limit, so on
	 * sites with more than `SQL_BATCH_SIZE` collections the field fetch
	 * becomes `ceil(collectionCount / SQL_BATCH_SIZE)` queries — still
	 * a constant factor, not N+1. Typical sites have well under
	 * `SQL_BATCH_SIZE` collections, so this is two queries in practice.
	 *
	 * Used by the manifest build, which previously paid N+1 round-trips on
	 * every admin request. Each round-trip costs ~80–150ms against the D1
	 * primary on a busy link, so a 10-collection site spent ~1 s rebuilding
	 * a manifest that is now built fresh per admin request (no cache).
	 */
	async listCollectionsWithFields(): Promise<CollectionWithFields[]> {
		const collectionRows = await this.db
			.selectFrom("_emdash_collections")
			.selectAll()
			.orderBy(collectionOrder, "asc")
			.orderBy("slug", "asc")
			.execute();

		if (collectionRows.length === 0) return [];

		const fieldsByCollection = new Map<string, Field[]>();
		// Chunk to stay under D1's bound-parameter limit. Typical sites have
		// well under SQL_BATCH_SIZE collections, so this is a single query
		// in practice; on larger sites it becomes a small constant number
		// of queries, never N+1.
		for (const idChunk of chunks(
			collectionRows.map((c) => c.id),
			SQL_BATCH_SIZE,
		)) {
			const fieldRows = await this.db
				.selectFrom("_emdash_fields")
				.where("collection_id", "in", idChunk)
				.selectAll()
				.orderBy("collection_id", "asc")
				.orderBy("sort_order", "asc")
				.orderBy("created_at", "asc")
				.execute();
			for (const row of fieldRows) {
				const list = fieldsByCollection.get(row.collection_id) ?? [];
				list.push(this.mapFieldRow(row));
				fieldsByCollection.set(row.collection_id, list);
			}
		}

		return collectionRows.map((c) => ({
			...this.mapCollectionRow(c),
			fields: fieldsByCollection.get(c.id) ?? [],
		}));
	}

	/**
	 * Validate `titleField`/`dateField` against the collection's fields:
	 * `titleField` must be a text-like field; `dateField` must be a `datetime` field.
	 * Only truthy values are checked (undefined = unchanged, null/"" = cleared).
	 */
	private async validateTitleDateFields(
		collectionId: string,
		collectionSlug: string,
		input: { titleField?: string | null; dateField?: string | null },
		db: Kysely<Database> = this.db,
	): Promise<void> {
		const slugs = [input.titleField, input.dateField].filter((slug): slug is string => !!slug);
		if (slugs.length === 0) return;

		const rows = await db
			.selectFrom("_emdash_fields")
			.where("collection_id", "=", collectionId)
			.where("slug", "in", slugs)
			.select(["slug", "type"])
			.execute();
		const typeBySlug = new Map(rows.map((row) => [row.slug, row.type]));

		if (input.titleField) {
			const type = typeBySlug.get(input.titleField);
			if (type === undefined) {
				throw new SchemaError(
					`titleField "${input.titleField}" is not a field on "${collectionSlug}"`,
					"INVALID_TITLE_FIELD",
				);
			}
			if (!TITLE_FIELD_TYPES.has(type)) {
				throw new SchemaError(
					`titleField "${input.titleField}" must be a text field (got "${type}")`,
					"INVALID_TITLE_FIELD",
				);
			}
		}

		if (input.dateField) {
			const type = typeBySlug.get(input.dateField);
			if (type === undefined) {
				throw new SchemaError(
					`dateField "${input.dateField}" is not a field on "${collectionSlug}"`,
					"INVALID_DATE_FIELD",
				);
			}
			if (type !== "datetime") {
				throw new SchemaError(
					`dateField "${input.dateField}" must be a datetime field (got "${type}")`,
					"INVALID_DATE_FIELD",
				);
			}
		}
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
		if (await isMediaUsageCollectionSlugDeleting(this.db, input.slug)) {
			throw new SchemaError(`Collection "${input.slug}" already exists`, "COLLECTION_EXISTS");
		}

		// Check if collection already exists
		const existing = await this.getCollection(input.slug);
		if (await isMediaUsageCollectionSlugDeleting(this.db, input.slug)) {
			throw new SchemaError(`Collection "${input.slug}" already exists`, "COLLECTION_EXISTS");
		}
		if (
			existing &&
			!(await canResumeMediaUsageCollectionCapture(this.db, {
				collectionId: existing.id,
				collectionSlug: existing.slug,
			}))
		) {
			throw new SchemaError(`Collection "${input.slug}" already exists`, "COLLECTION_EXISTS");
		}

		const proposedId = existing?.id ?? ulid();

		// Default `supports` to drafts + revisions when the caller didn't
		// specify it. Explicit empty array (`[]`) is preserved as an opt-out
		// — only `undefined` triggers the default. This is the canonical
		// default for new collections; the MCP and admin UI layers used to
		// duplicate this default but now defer to the registry.
		const supports = input.supports ?? ["drafts", "revisions"];

		// Insert collection record and create content table in a transaction
		// so a failure in table creation doesn't leave an orphaned row.
		// Uses withTransaction for D1 compatibility (no transaction support).
		// Derive hasSeo from supports array if not explicitly set
		const hasSeo = input.hasSeo ?? supports.includes("seo") ?? false;

		await withTransaction(this.db, async (trx) => {
			const capture = await prepareMediaUsageCollectionCapture(trx, {
				collectionId: proposedId,
				collectionSlug: input.slug,
				registeredCollectionId: existing?.id,
			});
			const values: Insertable<CollectionTable> = {
				id: capture.collectionId,
				slug: input.slug,
				label: input.label,
				label_singular: input.labelSingular ?? null,
				description: input.description ?? null,
				icon: input.icon ?? null,
				admin_config: input.admin ? JSON.stringify(input.admin) : null,
				supports: JSON.stringify(supports),
				source: input.source ?? "manual",
				has_seo: hasSeo ? 1 : 0,
				routable: input.routable === false ? 0 : 1,
				hidden: input.hidden ? 1 : 0,
				sort_order: input.sortOrder ?? null,
				comments_enabled: input.commentsEnabled ? 1 : 0,
				url_pattern: input.urlPattern ?? null,
			};

			if (capture.captureRequired) {
				await this.createContentTable(input.slug, trx, [], {
					ifNotExists: capture.resuming,
				});
				await installPreparedMediaUsageCollectionCapture(trx, {
					collectionId: capture.collectionId,
					collectionSlug: input.slug,
				});
				await markMediaUsageCollectionCaptureReady(trx, {
					collectionId: capture.collectionId,
					collectionSlug: input.slug,
				});
				if (!capture.registrationExists) {
					await trx.insertInto("_emdash_collections").values(values).execute();
				}
				await finalizeMediaUsageCollectionCapture(trx, {
					collectionId: capture.collectionId,
					collectionSlug: input.slug,
				});
				return;
			}

			await trx.insertInto("_emdash_collections").values(values).execute();
			await this.createContentTable(input.slug, trx);
		});

		const collection = await this.getCollection(input.slug);
		if (!collection) {
			throw new SchemaError("Failed to create collection", "CREATE_FAILED");
		}

		return collection;
	}

	/**
	 * Create a seed-owned collection and all of its fields in bulk.
	 *
	 * Fresh seeds can define dozens of fields. Creating them through
	 * `createField` performs multiple reads, one ALTER TABLE, and one media
	 * usage invalidation per field, which can exhaust D1's per-request query
	 * budget. This path validates the full schema before mutating it, creates
	 * the complete content table in one statement, and inserts field metadata
	 * in parameter-safe batches.
	 */
	async createSeedCollection(
		input: Omit<CreateCollectionInput, "source">,
		fields: readonly CreateFieldInput[],
	): Promise<void> {
		this.validateSlug(input.slug, "collection");
		if (RESERVED_COLLECTION_SLUGS.includes(input.slug)) {
			throw new SchemaError(`Collection slug "${input.slug}" is reserved`, "RESERVED_SLUG");
		}
		if (await isMediaUsageCollectionSlugDeleting(this.db, input.slug)) {
			throw new SchemaError(`Collection "${input.slug}" already exists`, "COLLECTION_EXISTS");
		}

		const fieldSlugs = new Set<string>();
		for (const field of fields) {
			this.validateSlug(field.slug, "field");
			assertIndexableField(field.type, field.indexed, field.slug);
			if (RESERVED_FIELD_SLUGS.includes(field.slug)) {
				throw new SchemaError(`Field slug "${field.slug}" is reserved`, "RESERVED_SLUG");
			}
			if (fieldSlugs.has(field.slug)) {
				throw new SchemaError(
					`Field "${field.slug}" already exists in collection "${input.slug}"`,
					"FIELD_EXISTS",
				);
			}
			fieldSlugs.add(field.slug);
		}

		const supports = input.supports ?? ["drafts", "revisions"];
		const hasSeo = input.hasSeo ?? supports.includes("seo") ?? false;
		const creationFingerprint = await buildSeedCollectionCaptureFingerprint(input, fields);
		const existing = await this.getCollection(input.slug);
		if (await isMediaUsageCollectionSlugDeleting(this.db, input.slug)) {
			throw new SchemaError(`Collection "${input.slug}" already exists`, "COLLECTION_EXISTS");
		}
		if (
			existing &&
			!(await canResumeMediaUsageCollectionCapture(this.db, {
				collectionId: existing.id,
				collectionSlug: existing.slug,
				creationFingerprint,
			}))
		) {
			throw new SchemaError(`Collection "${input.slug}" already exists`, "COLLECTION_EXISTS");
		}

		const proposedCollectionId = existing?.id ?? ulid();
		let maxSortOrder = -1;
		const fieldRows: Insertable<FieldTable>[] = fields.map((field) => {
			const sortOrder = field.sortOrder ?? maxSortOrder + 1;
			maxSortOrder = Math.max(maxSortOrder, sortOrder);

			return {
				id: ulid(),
				collection_id: proposedCollectionId,
				slug: field.slug,
				label: field.label,
				type: field.type,
				column_type: FIELD_TYPE_TO_COLUMN[field.type],
				required: field.required ? 1 : 0,
				unique: field.unique ? 1 : 0,
				default_value: field.defaultValue !== undefined ? JSON.stringify(field.defaultValue) : null,
				validation: field.validation ? JSON.stringify(field.validation) : null,
				widget: field.widget ?? null,
				options: field.options ? JSON.stringify(field.options) : null,
				sort_order: sortOrder,
				searchable: field.searchable ? 1 : 0,
				indexed: field.indexed ? 1 : 0,
				translatable: field.translatable === false ? 0 : 1,
			};
		});

		let schemaMutated = false;
		try {
			await withTransaction(this.db, async (trx) => {
				const capture = await prepareMediaUsageCollectionCapture(trx, {
					collectionId: proposedCollectionId,
					collectionSlug: input.slug,
					creationFingerprint,
					registeredCollectionId: existing?.id,
				});
				const collectionValues: Insertable<CollectionTable> = {
					id: capture.collectionId,
					slug: input.slug,
					label: input.label,
					label_singular: input.labelSingular ?? null,
					description: input.description ?? null,
					icon: input.icon ?? null,
					admin_config: input.admin ? JSON.stringify(input.admin) : null,
					supports: JSON.stringify(supports),
					source: "seed",
					has_seo: hasSeo ? 1 : 0,
					routable: input.routable === false ? 0 : 1,
					hidden: input.hidden ? 1 : 0,
					sort_order: input.sortOrder ?? null,
					comments_enabled: input.commentsEnabled ? 1 : 0,
					url_pattern: input.urlPattern ?? null,
				};
				const rows = fieldRows.map((row) => ({
					...row,
					collection_id: capture.collectionId,
				}));

				if (capture.captureRequired) {
					await this.createContentTable(input.slug, trx, fields, {
						ifNotExists: capture.resuming,
					});
					await installPreparedMediaUsageCollectionCapture(trx, {
						collectionId: capture.collectionId,
						collectionSlug: input.slug,
					});
					await markMediaUsageCollectionCaptureReady(trx, {
						collectionId: capture.collectionId,
						collectionSlug: input.slug,
					});
					if (!capture.registrationExists) {
						await trx.insertInto("_emdash_collections").values(collectionValues).execute();
						schemaMutated = true;
					}
				} else {
					await trx.insertInto("_emdash_collections").values(collectionValues).execute();
					schemaMutated = true;
					await this.createContentTable(input.slug, trx, fields);
				}

				for (const fieldBatch of chunks(rows, SEED_FIELD_INSERT_BATCH_SIZE)) {
					let insert = trx.insertInto("_emdash_fields").values(fieldBatch);
					if (capture.resuming) {
						insert = insert.onConflict((conflict) =>
							conflict.columns(["collection_id", "slug"]).doNothing(),
						);
					}
					await insert.execute();
				}
				let indexedRows: readonly { id: string; slug: string; indexed?: number }[] = rows;
				if (capture.resuming) {
					indexedRows = await this.assertSeedFieldDefinitions(capture.collectionId, fields, trx);
				}
				for (const field of indexedRows) {
					if (field.indexed === 1) {
						await this.createFieldIndex(input.slug, field.id, field.slug, trx);
					}
				}
				if (capture.captureRequired) {
					await finalizeMediaUsageCollectionCapture(trx, {
						collectionId: capture.collectionId,
						collectionSlug: input.slug,
					});
				}
			});

			await markContentMediaUsageCollectionStaleSafely(this.db, input.slug, "CONTENT_USAGE_STALE");
		} catch (error) {
			if (schemaMutated) {
				await markContentMediaUsageCollectionStaleSafely(
					this.db,
					input.slug,
					"CONTENT_USAGE_STALE",
				);
			}
			throw error;
		}
	}

	private async assertSeedFieldDefinitions(
		collectionId: string,
		fields: readonly CreateFieldInput[],
		db: Kysely<Database>,
	): Promise<Selectable<FieldTable>[]> {
		const stored = await db
			.selectFrom("_emdash_fields")
			.selectAll()
			.where("collection_id", "=", collectionId)
			.execute();
		if (stored.length !== fields.length) {
			throw new SchemaError("Interrupted seed collection fields do not match", "CREATE_FAILED");
		}

		let maxSortOrder = -1;
		for (const field of fields) {
			const sortOrder = field.sortOrder ?? maxSortOrder + 1;
			maxSortOrder = Math.max(maxSortOrder, sortOrder);
			const row = stored.find((candidate) => candidate.slug === field.slug);
			if (
				!row ||
				row.label !== field.label ||
				row.type !== field.type ||
				row.column_type !== FIELD_TYPE_TO_COLUMN[field.type] ||
				row.required !== (field.required ? 1 : 0) ||
				row.unique !== (field.unique ? 1 : 0) ||
				row.default_value !==
					(field.defaultValue !== undefined ? JSON.stringify(field.defaultValue) : null) ||
				row.validation !== (field.validation ? JSON.stringify(field.validation) : null) ||
				row.widget !== (field.widget ?? null) ||
				row.options !== (field.options ? JSON.stringify(field.options) : null) ||
				row.sort_order !== sortOrder ||
				row.searchable !== (field.searchable ? 1 : 0) ||
				row.indexed !== (field.indexed ? 1 : 0) ||
				row.translatable !== (field.translatable === false ? 0 : 1)
			) {
				throw new SchemaError("Interrupted seed collection fields do not match", "CREATE_FAILED");
			}
		}
		return stored;
	}

	/**
	 * Update a collection
	 */
	async updateCollection(slug: string, input: UpdateCollectionInput): Promise<Collection> {
		return withTransaction(this.db, async (trx) => {
			const existingRow = await trx
				.selectFrom("_emdash_collections")
				.where("slug", "=", slug)
				.selectAll()
				.executeTakeFirst();
			if (!existingRow) {
				throw new SchemaError(`Collection "${slug}" not found`, "COLLECTION_NOT_FOUND");
			}
			const existing = this.mapCollectionRow(existingRow);
			await this.validateTitleDateFields(
				existing.id,
				slug,
				{
					titleField: input.titleField,
					dateField: input.dateField,
				},
				trx,
			);
			const updates: Updateable<CollectionTable> = {};

			if (input.label !== undefined) updates.label = input.label;
			if (input.labelSingular !== undefined) updates.label_singular = input.labelSingular;
			if (input.description !== undefined) updates.description = input.description;
			if (input.icon !== undefined) updates.icon = input.icon;
			if (input.admin !== undefined) updates.admin_config = JSON.stringify(input.admin);
			if (input.supports !== undefined) updates.supports = JSON.stringify(input.supports);
			if (input.urlPattern !== undefined) updates.url_pattern = input.urlPattern;
			if (input.routable !== undefined) updates.routable = input.routable ? 1 : 0;
			if (input.hasSeo !== undefined) {
				updates.has_seo = input.hasSeo ? 1 : 0;
			} else if (input.supports !== undefined) {
				updates.has_seo = input.supports.includes("seo") ? 1 : 0;
			}
			if (input.hidden !== undefined) updates.hidden = input.hidden ? 1 : 0;
			if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder;
			if (input.titleField !== undefined) updates.title_field = input.titleField || null;
			if (input.dateField !== undefined) updates.date_field = input.dateField || null;
			if (input.commentsEnabled !== undefined) {
				updates.comments_enabled = input.commentsEnabled ? 1 : 0;
			}
			if (input.commentsModeration !== undefined) {
				updates.comments_moderation = input.commentsModeration;
			}
			if (input.commentsClosedAfterDays !== undefined) {
				updates.comments_closed_after_days = input.commentsClosedAfterDays;
			}
			if (input.commentsAutoApproveUsers !== undefined) {
				updates.comments_auto_approve_users = input.commentsAutoApproveUsers ? 1 : 0;
			}

			updates.updated_at = new Date().toISOString();
			await trx
				.updateTable("_emdash_collections")
				.set(updates)
				.where("id", "=", existing.id)
				.execute();

			const row = await trx
				.selectFrom("_emdash_collections")
				.where("slug", "=", slug)
				.selectAll()
				.executeTakeFirst();

			if (!row) {
				throw new SchemaError("Failed to update collection", "UPDATE_FAILED");
			}

			// Sync FTS state when the supports array changes (e.g. search toggled on/off)
			if (input.supports !== undefined) {
				const hadSearch = existing.supports.includes("search");
				const hasSearch = parseSupports(row.supports).includes("search");
				if (hadSearch !== hasSearch) {
					await this.syncSearchState(slug, trx);
				}
			}

			return this.mapCollectionRow(row);
		});
	}

	/**
	 * Delete a collection
	 */
	async deleteCollection(slug: string, options?: { force?: boolean }): Promise<void> {
		const existing = await this.getCollection(slug);
		if (existing && !options?.force && (await this.collectionHasContent(slug))) {
			throw new SchemaError(
				`Collection "${slug}" has content. Use force: true to delete.`,
				"COLLECTION_HAS_CONTENT",
			);
		}
		const activated = await deleteActivatedMediaUsageCollection(this.db, {
			collectionId: existing?.id,
			collectionSlug: slug,
			forceDelete: options?.force === true,
		});
		if (activated === "has_content") {
			throw new SchemaError(
				`Collection "${slug}" has content. Use force: true to delete.`,
				"COLLECTION_HAS_CONTENT",
			);
		}
		if (activated === "in_progress") {
			throw new SchemaError(`Collection "${slug}" deletion is already in progress`, "CONFLICT");
		}
		if (activated === "deleted") return;
		if (!existing) {
			throw new SchemaError(`Collection "${slug}" not found`, "COLLECTION_NOT_FOUND");
		}

		let contentTableDropped = false;
		try {
			await withTransaction(this.db, async (trx) => {
				// Drop FTS table and triggers before dropping the content table
				const ftsManager = new FTSManager(trx);
				await ftsManager.dropFtsTable(slug);

				// Drop the content table
				const tableName = this.getTableName(slug);
				await sql`DROP TABLE IF EXISTS ${sql.ref(tableName)}`.execute(trx);
				contentTableDropped = true;

				// Delete the collection record (fields will cascade)
				await trx.deleteFrom("_emdash_collections").where("id", "=", existing.id).execute();
			});
			await deleteContentMediaUsageCollection(this.db, slug);
		} catch (error) {
			if (contentTableDropped && !(await tableExists(this.db, this.getTableName(slug)))) {
				await deleteContentMediaUsageCollection(this.db, slug);
			}
			throw error;
		}
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
		assertIndexableField(input.type, input.indexed, input.slug);

		// Get max sort order
		const maxSort = await this.db
			.selectFrom("_emdash_fields")
			.where("collection_id", "=", collection.id)
			.select((eb) => eb.fn.max<number>("sort_order").as("max"))
			.executeTakeFirst();

		const sortOrder = input.sortOrder ?? (maxSort?.max ?? -1) + 1;
		const activeCoverageInvalidated = await invalidateContentMediaUsageSchemaChange(
			this.db,
			collectionSlug,
		);

		let schemaMutated = false;
		try {
			const created = await withTransaction(this.db, async (trx) => {
				// Insert field record
				await trx
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
						default_value:
							input.defaultValue !== undefined ? JSON.stringify(input.defaultValue) : null,
						validation: input.validation ? JSON.stringify(input.validation) : null,
						widget: input.widget ?? null,
						options: input.options ? JSON.stringify(input.options) : null,
						sort_order: sortOrder,
						searchable: input.searchable ? 1 : 0,
						indexed: input.indexed ? 1 : 0,
						translatable: input.translatable === false ? 0 : 1,
					})
					.execute();
				schemaMutated = true;

				// Add column to content table — pass trx to stay on the same connection
				await this.addColumn(
					collectionSlug,
					input.slug,
					input.type,
					{
						required: input.required,
						defaultValue: input.defaultValue,
					},
					trx,
				);

				if (input.indexed) {
					await this.createFieldIndex(collectionSlug, id, input.slug, trx);
				}

				// Read the created field via trx (not this.db) to avoid connection mutex deadlock
				const fieldRow = await trx
					.selectFrom("_emdash_fields")
					.where("collection_id", "=", collection.id)
					.where("slug", "=", input.slug)
					.selectAll()
					.executeTakeFirst();

				if (!fieldRow) {
					throw new SchemaError("Failed to create field", "CREATE_FAILED");
				}

				const field = this.mapFieldRow(fieldRow);

				// Sync search state if this field is searchable; support checks are handled by syncSearchState()
				if (input.searchable) {
					await this.syncSearchState(collectionSlug, trx);
				}

				return field;
			});
			if (activeCoverageInvalidated) {
				await invalidateContentMediaUsageSchemaChange(this.db, collectionSlug);
			} else {
				await markContentMediaUsageCollectionStaleSafely(
					this.db,
					collectionSlug,
					"CONTENT_USAGE_STALE",
				);
			}
			return created;
		} catch (error) {
			if (schemaMutated) {
				if (activeCoverageInvalidated) {
					await invalidateContentMediaUsageSchemaChange(this.db, collectionSlug);
				} else {
					await markContentMediaUsageCollectionStaleSafely(
						this.db,
						collectionSlug,
						"CONTENT_USAGE_STALE",
					);
				}
			}
			throw error;
		}
	}

	/**
	 * Update a field
	 */
	async updateField(
		collectionSlug: string,
		fieldSlug: string,
		input: UpdateFieldInput,
	): Promise<Field> {
		let activeCoverageInvalidated = false;
		let schemaMutated = false;
		try {
			const updatedField = await withTransaction(this.db, async (trx) => {
				const collectionRow = await trx
					.selectFrom("_emdash_collections")
					.where("slug", "=", collectionSlug)
					.select(["id", "title_field", "date_field"])
					.executeTakeFirst();
				const fieldRow = collectionRow
					? await trx
							.selectFrom("_emdash_fields")
							.where("collection_id", "=", collectionRow.id)
							.where("slug", "=", fieldSlug)
							.selectAll()
							.executeTakeFirst()
					: undefined;
				if (!fieldRow) {
					throw new SchemaError(
						`Field "${fieldSlug}" not found in collection "${collectionSlug}"`,
						"FIELD_NOT_FOUND",
					);
				}
				const field = this.mapFieldRow(fieldRow);
				const updates: Updateable<FieldTable> = {};
				let nextType = field.type;

				if (input.type !== undefined && input.type !== field.type) {
					const newColumnType = FIELD_TYPE_TO_COLUMN[input.type];
					if (newColumnType !== field.columnType) {
						throw new SchemaError(
							`Cannot change field "${fieldSlug}" in collection "${collectionSlug}" from type ` +
								`"${field.type}" to "${input.type}": the underlying column type would change from ` +
								`${field.columnType} to ${newColumnType}, which requires a manual content migration.`,
							"FIELD_TYPE_COLUMN_CHANGE",
						);
					}
					if (!TEXT_ALIAS_FIELD_TYPES.has(field.type) || !TEXT_ALIAS_FIELD_TYPES.has(input.type)) {
						throw new SchemaError(
							`Cannot change field "${fieldSlug}" in collection "${collectionSlug}" from type ` +
								`"${field.type}" to "${input.type}" without a manual content migration.`,
							"FIELD_TYPE_CHANGE_REQUIRES_MIGRATION",
						);
					}
					if (collectionRow?.title_field === fieldSlug && !TITLE_FIELD_TYPES.has(input.type)) {
						throw new SchemaError(
							`titleField "${fieldSlug}" must stay a text field, not "${input.type}"`,
							"INVALID_TITLE_FIELD",
						);
					}
					if (collectionRow?.date_field === fieldSlug && input.type !== "datetime") {
						throw new SchemaError(
							`dateField "${fieldSlug}" must stay a datetime field, not "${input.type}"`,
							"INVALID_DATE_FIELD",
						);
					}
					nextType = input.type;
					updates.type = input.type;
					updates.column_type = newColumnType;
				}

				if (input.required !== undefined && input.required !== field.required) {
					throw new SchemaError(
						`Changing required for field "${fieldSlug}" requires a manual content migration.`,
						"FIELD_UPDATE_REQUIRES_MIGRATION",
					);
				}
				if (input.unique !== undefined && input.unique !== field.unique) {
					throw new SchemaError(
						`Changing unique for field "${fieldSlug}" requires a manual content migration.`,
						"FIELD_UPDATE_REQUIRES_MIGRATION",
					);
				}
				if (input.translatable === false && field.translatable) {
					throw new SchemaError(
						`Changing field "${fieldSlug}" to non-translatable requires a manual content migration.`,
						"FIELD_UPDATE_REQUIRES_MIGRATION",
					);
				}

				if (input.label !== undefined) updates.label = input.label;
				if (input.required !== undefined) updates.required = input.required ? 1 : 0;
				if (input.unique !== undefined) updates.unique = input.unique ? 1 : 0;
				if (input.searchable !== undefined) updates.searchable = input.searchable ? 1 : 0;
				const indexedChanged = input.indexed !== undefined && input.indexed !== field.indexed;
				if (indexedChanged) updates.indexed = input.indexed ? 1 : 0;
				if (input.translatable !== undefined) {
					updates.translatable = input.translatable ? 1 : 0;
				}
				if (input.defaultValue !== undefined) {
					updates.default_value = JSON.stringify(input.defaultValue);
				}
				if (input.validation !== undefined) {
					updates.validation = input.validation ? JSON.stringify(input.validation) : null;
				}
				if (input.widget !== undefined) updates.widget = input.widget;
				if (input.options !== undefined) updates.options = JSON.stringify(input.options);
				if (input.sortOrder !== undefined) updates.sort_order = input.sortOrder;

				assertIndexableField(nextType, input.indexed ?? field.indexed, fieldSlug);
				if (Object.keys(updates).length === 0) return field;

				activeCoverageInvalidated = await invalidateContentMediaUsageSchemaChange(
					trx,
					collectionSlug,
				);

				if (Object.keys(updates).length > 0) {
					await trx.updateTable("_emdash_fields").set(updates).where("id", "=", field.id).execute();
					schemaMutated = true;
				}

				if (indexedChanged) {
					if (input.indexed) {
						await this.createFieldIndex(collectionSlug, field.id, fieldSlug, trx);
					} else {
						await this.dropFieldIndex(field.id, trx);
					}
					schemaMutated = true;
				}

				// Read the updated field via trx (not this.db) to avoid connection mutex deadlock
				const updatedRow = await trx
					.selectFrom("_emdash_fields")
					.where("collection_id", "=", field.collectionId)
					.where("slug", "=", fieldSlug)
					.selectAll()
					.executeTakeFirst();

				if (!updatedRow) {
					throw new SchemaError("Failed to update field", "UPDATE_FAILED");
				}

				const updated = this.mapFieldRow(updatedRow);

				// If searchable changed, sync FTS state for this collection
				const searchableChanged =
					schemaMutated && input.searchable !== undefined && input.searchable !== field.searchable;
				if (searchableChanged) {
					await this.syncSearchState(collectionSlug, trx);
				}

				return updated;
			});
			if (schemaMutated) {
				if (activeCoverageInvalidated) {
					await invalidateContentMediaUsageSchemaChange(this.db, collectionSlug);
				} else {
					await markContentMediaUsageCollectionStaleSafely(
						this.db,
						collectionSlug,
						"CONTENT_USAGE_STALE",
					);
				}
			}
			return updatedField;
		} catch (error) {
			if (schemaMutated) {
				if (activeCoverageInvalidated) {
					await invalidateContentMediaUsageSchemaChange(this.db, collectionSlug);
				} else {
					await markContentMediaUsageCollectionStaleSafely(
						this.db,
						collectionSlug,
						"CONTENT_USAGE_STALE",
					);
				}
			}
			throw error;
		}
	}

	/**
	 * Synchronize an existing FTS index with the collection's current state.
	 *
	 * Only rebuilds or disables — never first-time enables. First-time FTS
	 * enablement is handled by the seed's explicit enableSearch call (which
	 * is try-caught) or the admin UI toggle.
	 *
	 * - FTS active + still has search support and searchable fields → rebuild
	 * - FTS active + lost search support or no searchable fields    → disable
	 * - FTS not active                                              → no-op
	 *
	 * Pass `db` when calling from within a transaction so FTS operations
	 * participate in the same transaction and are rolled back on failure.
	 */
	private async syncSearchState(collectionSlug: string, db?: Kysely<Database>): Promise<void> {
		const conn = db ?? this.db;
		const ftsManager = new FTSManager(conn);

		// Query via conn (not this.db) to avoid connection mutex deadlock when called inside a transaction
		const row = await conn
			.selectFrom("_emdash_collections")
			.where("slug", "=", collectionSlug)
			.select("supports")
			.executeTakeFirst();
		if (!row) return;

		const wantsSearch = parseSupports(row.supports).includes("search");
		const searchableFields = await ftsManager.getSearchableFields(collectionSlug);
		const config = await ftsManager.getSearchConfig(collectionSlug);
		const ftsActive = config?.enabled === true;

		if (wantsSearch && searchableFields.length > 0 && ftsActive) {
			await ftsManager.rebuildIndex(
				collectionSlug,
				searchableFields,
				config?.weights,
				config?.tokenize,
			);
		} else if (ftsActive && (!wantsSearch || searchableFields.length === 0)) {
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
		const activeCoverageInvalidated = await invalidateContentMediaUsageSchemaChange(
			this.db,
			collectionSlug,
		);

		// If this field powers the collection's titleField/dateField,
		// clear that reference in the same transaction — otherwise the metadata
		// would point at a dropped column and later crash the content list sort.
		const collection = await this.getCollection(collectionSlug);
		const clearTitle = collection?.titleField === fieldSlug;
		const clearDate = collection?.dateField === fieldSlug;

		let schemaMutated = false;
		try {
			await withTransaction(this.db, async (trx) => {
				// Delete the field record first so syncSearchState sees the updated field list.
				// This ordering matters for searchable fields: SQLite prevents dropping a column
				// that is still referenced by a trigger. syncSearchState drops and recreates the
				// FTS triggers based on the remaining searchable fields, clearing the dependency
				// before we attempt the ALTER TABLE DROP COLUMN below.
				await trx.deleteFrom("_emdash_fields").where("id", "=", field.id).execute();
				schemaMutated = true;

				if (clearTitle || clearDate) {
					await trx
						.updateTable("_emdash_collections")
						.set({
							...(clearTitle ? { title_field: null } : {}),
							...(clearDate ? { date_field: null } : {}),
							updated_at: new Date().toISOString(),
						})
						.where("slug", "=", collectionSlug)
						.execute();
				}

				// If the deleted field was searchable, sync FTS state (removes old triggers)
				if (field.searchable) {
					await this.syncSearchState(collectionSlug, trx);
				}

				if (field.indexed) {
					await this.dropFieldIndex(field.id, trx);
				}

				// Drop column from content table — safe now because FTS triggers are gone
				await this.dropColumn(collectionSlug, fieldSlug, trx);
			});
			if (activeCoverageInvalidated) {
				await invalidateContentMediaUsageSchemaChange(this.db, collectionSlug);
			} else {
				await markContentMediaUsageCollectionStaleSafely(
					this.db,
					collectionSlug,
					"CONTENT_USAGE_STALE",
				);
			}
		} catch (error) {
			if (schemaMutated) {
				if (activeCoverageInvalidated) {
					await invalidateContentMediaUsageSchemaChange(this.db, collectionSlug);
				} else {
					await markContentMediaUsageCollectionStaleSafely(
						this.db,
						collectionSlug,
						"CONTENT_USAGE_STALE",
					);
				}
			}
			throw error;
		}
	}

	/**
	 * Reorder collections in the admin sidebar.
	 *
	 * `slugs` is the full desired order: every listed collection gets its
	 * index as `sort_order`, and any collection left out has its explicit
	 * position cleared, dropping it back to the alphabetical tail. Unknown or
	 * duplicate slugs throw before anything is written.
	 */
	async reorderCollections(slugs: string[]): Promise<void> {
		const known = new Set((await this.listCollections()).map((collection) => collection.slug));

		const unknown = slugs.filter((slug) => !known.has(slug));
		if (unknown.length > 0) {
			throw new SchemaError(
				`Unknown collection${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
				"COLLECTION_NOT_FOUND",
				{ slugs: unknown },
			);
		}

		const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
		if (duplicates.length > 0) {
			throw new SchemaError(
				`Duplicate collection${duplicates.length > 1 ? "s" : ""}: ${[...new Set(duplicates)].join(", ")}`,
				"DUPLICATE_SLUG",
				{ slugs: [...new Set(duplicates)] },
			);
		}

		const now = new Date().toISOString();
		const ordered = new Set(slugs);

		await withTransaction(this.db, async (trx) => {
			for (const [index, slug] of slugs.entries()) {
				await trx
					.updateTable("_emdash_collections")
					.set({ sort_order: index, updated_at: now })
					.where("slug", "=", slug)
					.execute();
			}

			const cleared = [...known].filter((slug) => !ordered.has(slug));
			// Chunked to stay under D1's bound-parameter limit; typical sites
			// clear far fewer than one chunk.
			for (const slugChunk of chunks(cleared, SQL_BATCH_SIZE)) {
				await trx
					.updateTable("_emdash_collections")
					.set({ sort_order: null, updated_at: now })
					.where("slug", "in", slugChunk)
					.execute();
			}
		});
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
	private async createContentTable(
		slug: string,
		db?: Kysely<Database>,
		fields: readonly CreateFieldInput[] = [],
		options: { ifNotExists?: boolean } = {},
	): Promise<void> {
		const conn = db ?? this.db;
		const tableName = this.getTableName(slug);

		let table: CreateTableBuilder<string, string> = conn.schema
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
			.addColumn("translation_group", "text");
		if (options.ifNotExists) table = table.ifNotExists();

		for (const field of fields) {
			const columnName = this.getColumnName(field.slug);
			const columnType = COLUMN_TYPE_TO_DATA_TYPE[FIELD_TYPE_TO_COLUMN[field.type]];
			table = table.addColumn(columnName, columnType, (column) => {
				if (!field.required) return column;

				const defaultValue =
					field.defaultValue !== undefined
						? this.formatDefaultValue(field.defaultValue, field.type)
						: this.getEmptyDefault(field.type);
				return column.notNull().defaultTo(sql.raw(defaultValue));
			});
		}

		await table
			.addUniqueConstraint(`${tableName}_slug_locale_unique`, ["slug", "locale"])
			.execute();

		const createIndex = options.ifNotExists ? sql`CREATE INDEX IF NOT EXISTS` : sql`CREATE INDEX`;

		// Create standard indexes
		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_slug`)}
			ON ${sql.ref(tableName)} (slug)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_scheduled`)}
			ON ${sql.ref(tableName)} (scheduled_at)
			WHERE scheduled_at IS NOT NULL
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_live_revision`)}
			ON ${sql.ref(tableName)} (live_revision_id)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_draft_revision`)}
			ON ${sql.ref(tableName)} (draft_revision_id)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_author`)}
			ON ${sql.ref(tableName)} (author_id)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_primary_byline`)}
			ON ${sql.ref(tableName)} (primary_byline_id)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_locale`)}
			ON ${sql.ref(tableName)} (locale)
		`.execute(conn);

		// Names must stay identical to migration 055, which creates these indexes
		// on tables that already exist. Lookups that don't constrain `deleted_at`
		// (menu and reference resolution) need the first; reads that do need the
		// second.
		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_tg_locale`)}
			ON ${sql.ref(tableName)} (translation_group, locale)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_del_tg_locale`)}
			ON ${sql.ref(tableName)} (deleted_at, translation_group, locale)
		`.execute(conn);

		// Composite indexes for optimized query performance (see migration 033)
		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_deleted_updated_id`)}
			ON ${sql.ref(tableName)} (deleted_at, updated_at DESC, id DESC)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_deleted_status`)}
			ON ${sql.ref(tableName)} (deleted_at, status)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_deleted_created_id`)}
			ON ${sql.ref(tableName)} (deleted_at, created_at DESC, id DESC)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_deleted_published_id`)}
			ON ${sql.ref(tableName)} (deleted_at, published_at DESC, id DESC)
		`.execute(conn);

		// Locale-aware composite indexes for i18n content lists (see migration 041).
		// Short `loc_upd`/`loc_crt` suffix keeps the updated/created discriminator
		// inside Postgres's 63-byte identifier limit for long slugs; keep these
		// names identical to migration 041.
		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_loc_upd`)}
			ON ${sql.ref(tableName)} (deleted_at, locale, updated_at DESC, id DESC)
		`.execute(conn);

		await sql`
			${createIndex} ${sql.ref(`idx_${tableName}_loc_crt`)}
			ON ${sql.ref(tableName)} (deleted_at, locale, created_at DESC, id DESC)
		`.execute(conn);
	}

	private getFieldIndexName(fieldId: string): string {
		if (!FIELD_ID_PATTERN.test(fieldId)) {
			throw new SchemaError(`Invalid field id "${fieldId}"`, "INVALID_FIELD_ID");
		}
		return `idx_cf_${fieldId.toLowerCase()}`;
	}

	private getLocaleFieldIndexName(fieldId: string): string {
		return `${this.getFieldIndexName(fieldId)}_loc`;
	}

	private async createFieldIndex(
		collectionSlug: string,
		fieldId: string,
		fieldSlug: string,
		db?: Kysely<Database>,
	): Promise<void> {
		const conn = db ?? this.db;
		const tableName = this.getTableName(collectionSlug);
		const columnName = this.getColumnName(fieldSlug);
		const indexName = this.getFieldIndexName(fieldId);
		const localeIndexName = this.getLocaleFieldIndexName(fieldId);

		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(indexName)}
			ON ${sql.ref(tableName)} (
				(${sql.ref(columnName)} IS NOT NULL),
				${sql.ref(columnName)},
				id
			)
			WHERE deleted_at IS NULL
		`.execute(conn);

		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(localeIndexName)}
			ON ${sql.ref(tableName)} (
				locale,
				(${sql.ref(columnName)} IS NOT NULL),
				${sql.ref(columnName)},
				id
			)
			WHERE deleted_at IS NULL
		`.execute(conn);
	}

	private async dropFieldIndex(fieldId: string, db?: Kysely<Database>): Promise<void> {
		const conn = db ?? this.db;
		await sql`DROP INDEX IF EXISTS ${sql.ref(this.getFieldIndexName(fieldId))}`.execute(conn);
		await sql`DROP INDEX IF EXISTS ${sql.ref(this.getLocaleFieldIndexName(fieldId))}`.execute(conn);
	}

	/**
	 * Add a column to a content table
	 */
	private async addColumn(
		collectionSlug: string,
		fieldSlug: string,
		fieldType: FieldType,
		options?: { required?: boolean; defaultValue?: unknown },
		db?: Kysely<Database>,
	): Promise<void> {
		const conn = db ?? this.db;
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
			`.execute(conn);
		} else if (options?.required) {
			// For required fields without default, use empty string/0 as default
			const defaultVal = this.getEmptyDefault(fieldType);
			await sql`
				ALTER TABLE ${sql.ref(tableName)}
				ADD COLUMN ${sql.ref(columnName)} ${sql.raw(columnType)} NOT NULL DEFAULT ${sql.raw(defaultVal)}
			`.execute(conn);
		} else {
			await sql`
				ALTER TABLE ${sql.ref(tableName)}
				ADD COLUMN ${sql.ref(columnName)} ${sql.raw(columnType)}
			`.execute(conn);
		}
	}

	/**
	 * Drop a column from a content table
	 */
	private async dropColumn(
		collectionSlug: string,
		fieldSlug: string,
		db?: Kysely<Database>,
	): Promise<void> {
		const tableName = this.getTableName(collectionSlug);
		const columnName = this.getColumnName(fieldSlug);

		await sql`
			ALTER TABLE ${sql.ref(tableName)}
			DROP COLUMN ${sql.ref(columnName)}
		`.execute(db ?? this.db);
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
		validateIdentifier(slug, "collection slug");
		return `ec_${slug}`;
	}

	/**
	 * Get column name for a field
	 */
	private getColumnName(slug: string): string {
		validateIdentifier(slug, "field slug");
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
			admin: parseCollectionAdmin(row.admin_config),
			supports: parseSupports(row.supports),
			source: row.source && isCollectionSource(row.source) ? row.source : undefined,
			hasSeo: row.has_seo === 1,
			// Raw value; undefined when unset. The admin list resolves the
			// default (title fallback chain / updatedAt) at the point of use.
			titleField: row.title_field ?? undefined,
			dateField: row.date_field ?? undefined,
			urlPattern: row.url_pattern ?? undefined,
			routable: row.routable !== 0,
			hidden: row.hidden === 1,
			sortOrder: row.sort_order ?? undefined,
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
			indexed: row.indexed === 1,
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
		if (await isMediaUsageCollectionSlugDeleting(this.db, slug)) {
			throw new SchemaError(`Collection "${slug}" is already registered`, "COLLECTION_EXISTS");
		}
		const exists = await tableExists(this.db, tableName);

		if (!exists) {
			throw new SchemaError(`Table "${tableName}" does not exist`, "TABLE_NOT_FOUND");
		}

		// Check if already registered
		const existing = await this.getCollection(slug);
		if (await isMediaUsageCollectionSlugDeleting(this.db, slug)) {
			throw new SchemaError(`Collection "${slug}" is already registered`, "COLLECTION_EXISTS");
		}
		if (
			existing &&
			!(await canResumeMediaUsageCollectionCapture(this.db, {
				collectionId: existing.id,
				collectionSlug: existing.slug,
			}))
		) {
			throw new SchemaError(`Collection "${slug}" is already registered`, "COLLECTION_EXISTS");
		}

		// Create collection entry
		const proposedId = existing?.id ?? ulid();
		const label = options?.label || this.slugToLabel(slug);

		let collectionRegistered = false;
		try {
			const capture = await prepareMediaUsageCollectionCapture(this.db, {
				collectionId: proposedId,
				collectionSlug: slug,
				registeredCollectionId: existing?.id,
			});
			if (capture.captureRequired) {
				await installPreparedMediaUsageCollectionCapture(this.db, {
					collectionId: capture.collectionId,
					collectionSlug: slug,
				});
				await markMediaUsageCollectionCaptureReady(this.db, {
					collectionId: capture.collectionId,
					collectionSlug: slug,
				});
			}
			if (!capture.registrationExists) {
				await this.db
					.insertInto("_emdash_collections")
					.values({
						id: capture.collectionId,
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
				collectionRegistered = true;
			}
			if (capture.captureRequired) {
				await finalizeMediaUsageCollectionCapture(this.db, {
					collectionId: capture.collectionId,
					collectionSlug: slug,
				});
			}

			const collection = await this.getCollection(slug);
			if (!collection) {
				throw new SchemaError("Failed to register orphaned table", "REGISTER_FAILED");
			}
			await markContentMediaUsageCollectionStaleSafely(this.db, slug, "CONTENT_USAGE_STALE");

			return collection;
		} catch (error) {
			if (collectionRegistered) {
				await markContentMediaUsageCollectionStaleSafely(this.db, slug, "CONTENT_USAGE_STALE");
			}
			throw error;
		}
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
