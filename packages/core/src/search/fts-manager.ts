/**
 * FTS5 Manager
 *
 * Manages FTS5 virtual tables and triggers for search indexing.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isSqlite, tableExists as dialectTableExists } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import type { SearchConfig } from "./types.js";

/**
 * FTS5 Manager
 *
 * Handles creation, deletion, and management of FTS5 virtual tables
 * for full-text search on content collections.
 */
export class FTSManager {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Validate a collection slug and its searchable field names.
	 * Must be called before any raw SQL interpolation.
	 */
	private validateInputs(collectionSlug: string, searchableFields?: string[]): void {
		validateIdentifier(collectionSlug, "collection slug");
		if (searchableFields) {
			for (const field of searchableFields) {
				validateIdentifier(field, "searchable field name");
			}
		}
	}

	/**
	 * Get the FTS table name for a collection
	 * Uses _emdash_ prefix to clearly mark as internal/system table
	 */
	getFtsTableName(collectionSlug: string): string {
		validateIdentifier(collectionSlug, "collection slug");
		return `_emdash_fts_${collectionSlug}`;
	}

	/**
	 * Get the content table name for a collection
	 */
	getContentTableName(collectionSlug: string): string {
		validateIdentifier(collectionSlug, "collection slug");
		return `ec_${collectionSlug}`;
	}

	/**
	 * Check if an FTS table exists for a collection
	 */
	async ftsTableExists(collectionSlug: string): Promise<boolean> {
		const ftsTable = this.getFtsTableName(collectionSlug);
		return dialectTableExists(this.db, ftsTable);
	}

	/**
	 * Create an FTS5 virtual table for a collection.
	 * FTS5 is SQLite-only; on other dialects this is a no-op.
	 *
	 * @param collectionSlug - The collection slug
	 * @param searchableFields - Array of field names to index
	 * @param weights - Optional field weights for ranking
	 */
	async createFtsTable(
		collectionSlug: string,
		searchableFields: string[],
		_weights?: Record<string, number>,
	): Promise<void> {
		if (!isSqlite(this.db)) return;
		this.validateInputs(collectionSlug, searchableFields);
		const ftsTable = this.getFtsTableName(collectionSlug);
		const contentTable = this.getContentTableName(collectionSlug);

		// Build the column list for FTS5
		// id and locale are UNINDEXED (used for joining/filtering, not searched)
		const columns = ["id UNINDEXED", "locale UNINDEXED", ...searchableFields].join(", ");

		// Create the FTS5 virtual table.
		// `content='<table>'` makes this an *external content* FTS5 table:
		// the inverted index lives in the FTS shadow tables, but the actual
		// row data lives in the backing content table. The triggers in
		// `createTriggers` keep the index in sync; they MUST use the
		// external-content-safe `'delete'` command (see notes there) to
		// avoid `SQLITE_CORRUPT_VTAB` on UPDATE/DELETE.
		// tokenize='porter unicode61' enables stemming (run matches running, ran, etc.)
		await sql
			.raw(`
			CREATE VIRTUAL TABLE IF NOT EXISTS "${ftsTable}" USING fts5(
				${columns},
				content='${contentTable}',
				content_rowid='rowid',
				tokenize='porter unicode61'
			)
		`)
			.execute(this.db);

		// Create triggers for automatic sync
		await this.createTriggers(collectionSlug, searchableFields);
	}

	/**
	 * Create triggers to keep FTS table in sync with content table.
	 *
	 * The insert and update triggers only add rows to the FTS index when
	 * `deleted_at IS NULL`. This keeps soft-deleted content out of the
	 * search index and ensures the FTS row count matches the non-deleted
	 * content count (which `verifyAndRepairIndex` relies on).
	 *
	 * IMPORTANT: The FTS5 virtual table is created with `content='ec_<slug>'`
	 * which makes it an *external content* FTS5 table. For external-content
	 * tables, removing a row must use the documented `'delete'` command and
	 * supply the OLD column values explicitly, e.g.:
	 *
	 *     INSERT INTO fts(fts, rowid, col1, col2)
	 *     VALUES('delete', OLD.rowid, OLD.col1, OLD.col2);
	 *
	 * Using `DELETE FROM fts WHERE rowid = OLD.rowid` is the correct form
	 * for *contentless* tables but is unsafe for external-content tables:
	 * FTS5 then reads column values from the backing content table, which
	 * in an AFTER UPDATE trigger already holds the NEW values. The wrong
	 * tokens get removed and the inverted index drifts out of sync until
	 * SQLite raises `SQLITE_CORRUPT_VTAB` on the next mutation. See
	 * https://www.sqlite.org/fts5.html#external_content_tables.
	 *
	 * The UPDATE and DELETE triggers gate the `'delete'` on
	 * `OLD.deleted_at IS NULL` because the INSERT trigger never indexed
	 * rows that were already soft-deleted. Issuing `'delete'` for a rowid
	 * that was never inserted into the FTS index is itself a corruption
	 * trigger -- FTS5's `'delete'` is not a no-op on missing rowids and
	 * raises `SQLITE_CORRUPT_VTAB`. Affected paths include restore-from-
	 * trash (UPDATE where `OLD.deleted_at IS NOT NULL`), permanent-delete
	 * from trash (DELETE on a soft-deleted row), and any edit on a row
	 * that's currently in the trash.
	 */
	private async createTriggers(collectionSlug: string, searchableFields: string[]): Promise<void> {
		this.validateInputs(collectionSlug, searchableFields);
		if (searchableFields.length === 0) {
			throw new Error(
				`Cannot create FTS triggers for collection "${collectionSlug}": no searchable fields. ` +
					`Mark at least one field as searchable before enabling search.`,
			);
		}
		const ftsTable = this.getFtsTableName(collectionSlug);
		const contentTable = this.getContentTableName(collectionSlug);
		const fieldList = searchableFields.join(", ");
		const newFieldList = searchableFields.map((f) => `NEW.${f}`).join(", ");
		// `'delete'` takes the FTS5 virtual table name as the first column,
		// then the rowid being removed, then the OLD value of every column
		// declared on the FTS5 table (in declaration order: id, locale,
		// then each searchable field).
		const oldFieldList = searchableFields.map((f) => `OLD.${f}`).join(", ");

		// Insert trigger - only index non-deleted content
		await sql
			.raw(`
			CREATE TRIGGER IF NOT EXISTS "${ftsTable}_insert" 
			AFTER INSERT ON "${contentTable}" 
			WHEN NEW.deleted_at IS NULL
			BEGIN
				INSERT INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
				VALUES (NEW.rowid, NEW.id, NEW.locale, ${newFieldList});
			END
		`)
			.execute(this.db);

		// Update trigger - remove the old row from the FTS index using the
		// external-content-safe `'delete'` command (which uses OLD column
		// values, captured before the row was modified), then re-insert
		// the new values when the row is still visible.
		//
		// `'delete'` is gated on `OLD.deleted_at IS NULL` because rows that
		// were soft-deleted are not in the FTS index (the INSERT trigger
		// skips them). Issuing `'delete'` for a missing rowid raises
		// `SQLITE_CORRUPT_VTAB`, which would break restore-from-trash and
		// edits to soft-deleted rows.
		await sql
			.raw(`
			CREATE TRIGGER IF NOT EXISTS "${ftsTable}_update" 
			AFTER UPDATE ON "${contentTable}" 
			BEGIN
				INSERT INTO "${ftsTable}"("${ftsTable}", rowid, id, locale, ${fieldList})
				SELECT 'delete', OLD.rowid, OLD.id, OLD.locale, ${oldFieldList}
				WHERE OLD.deleted_at IS NULL;
				INSERT INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
				SELECT NEW.rowid, NEW.id, NEW.locale, ${newFieldList}
				WHERE NEW.deleted_at IS NULL;
			END
		`)
			.execute(this.db);

		// Delete trigger - same external-content-safe `'delete'` form,
		// gated on `OLD.deleted_at IS NULL` for the same reason as the
		// UPDATE trigger: permanent-delete from trash hits a row whose
		// `deleted_at` is already set and which was never indexed.
		await sql
			.raw(`
			CREATE TRIGGER IF NOT EXISTS "${ftsTable}_delete" 
			AFTER DELETE ON "${contentTable}" 
			BEGIN
				INSERT INTO "${ftsTable}"("${ftsTable}", rowid, id, locale, ${fieldList})
				SELECT 'delete', OLD.rowid, OLD.id, OLD.locale, ${oldFieldList}
				WHERE OLD.deleted_at IS NULL;
			END
		`)
			.execute(this.db);
	}

	/**
	 * Drop triggers for a collection
	 */
	private async dropTriggers(collectionSlug: string): Promise<void> {
		this.validateInputs(collectionSlug);
		const ftsTable = this.getFtsTableName(collectionSlug);

		await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_insert"`).execute(this.db);
		await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_update"`).execute(this.db);
		await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_delete"`).execute(this.db);
	}

	/**
	 * Drop the FTS table and triggers for a collection
	 */
	async dropFtsTable(collectionSlug: string): Promise<void> {
		if (!isSqlite(this.db)) return;
		this.validateInputs(collectionSlug);
		const ftsTable = this.getFtsTableName(collectionSlug);

		// Drop triggers first
		await this.dropTriggers(collectionSlug);

		// Drop the FTS table
		await sql.raw(`DROP TABLE IF EXISTS "${ftsTable}"`).execute(this.db);
	}

	/**
	 * Rebuild the FTS index for a collection
	 *
	 * This is useful after bulk imports or if the index gets out of sync.
	 */
	async rebuildIndex(
		collectionSlug: string,
		searchableFields: string[],
		weights?: Record<string, number>,
	): Promise<void> {
		if (!isSqlite(this.db)) return;
		// Drop existing table and triggers
		await this.dropFtsTable(collectionSlug);

		// Recreate table and triggers
		await this.createFtsTable(collectionSlug, searchableFields, weights);

		// Populate from existing content
		await this.populateFromContent(collectionSlug, searchableFields);
	}

	/**
	 * Populate the FTS table from existing content
	 */
	async populateFromContent(collectionSlug: string, searchableFields: string[]): Promise<void> {
		if (!isSqlite(this.db)) return;
		this.validateInputs(collectionSlug, searchableFields);
		const ftsTable = this.getFtsTableName(collectionSlug);
		const contentTable = this.getContentTableName(collectionSlug);
		const fieldList = searchableFields.join(", ");

		// Insert all existing content into FTS table
		await sql
			.raw(`
			INSERT INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
			SELECT rowid, id, locale, ${fieldList} FROM "${contentTable}"
			WHERE deleted_at IS NULL
		`)
			.execute(this.db);
	}

	/**
	 * Get the search configuration for a collection
	 */
	async getSearchConfig(collectionSlug: string): Promise<SearchConfig | null> {
		const result = await this.db
			.selectFrom("_emdash_collections")
			.select("search_config")
			.where("slug", "=", collectionSlug)
			.executeTakeFirst();

		if (!result?.search_config) {
			return null;
		}

		try {
			const parsed: unknown = JSON.parse(result.search_config);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("enabled" in parsed) ||
				typeof parsed.enabled !== "boolean"
			) {
				return null;
			}
			const config: SearchConfig = { enabled: parsed.enabled };
			if ("weights" in parsed && typeof parsed.weights === "object" && parsed.weights !== null) {
				// weights is a JSON-parsed object — safe to treat as Record<string, number>
				const weights: Record<string, number> = {};
				for (const [k, v] of Object.entries(parsed.weights)) {
					if (typeof v === "number") {
						weights[k] = v;
					}
				}
				config.weights = weights;
			}
			return config;
		} catch {
			return null;
		}
	}

	/**
	 * Update the search configuration for a collection
	 */
	async setSearchConfig(collectionSlug: string, config: SearchConfig): Promise<void> {
		await this.db
			.updateTable("_emdash_collections")
			.set({ search_config: JSON.stringify(config) })
			.where("slug", "=", collectionSlug)
			.execute();
	}

	/**
	 * Get searchable fields for a collection
	 */
	async getSearchableFields(collectionSlug: string): Promise<string[]> {
		const collection = await this.db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("slug", "=", collectionSlug)
			.executeTakeFirst();

		if (!collection) {
			return [];
		}

		const fields = await this.db
			.selectFrom("_emdash_fields")
			.select("slug")
			.where("collection_id", "=", collection.id)
			.where("searchable", "=", 1)
			.execute();

		return fields.map((f) => f.slug);
	}

	/**
	 * Whether a collection has a user-defined `title` field.
	 *
	 * `title` is not a system column on `ec_*` tables -- it exists only when a
	 * collection defines a field with slug `title`. Search and suggestion SQL
	 * that selects `c.title` must check this first; otherwise collections
	 * without a title field raise "no such column: c.title" (#1178).
	 */
	async hasTitleColumn(collectionSlug: string): Promise<boolean> {
		const withTitle = await this.getCollectionsWithTitleColumn([collectionSlug]);
		return withTitle.has(collectionSlug);
	}

	/**
	 * Bulk variant of `hasTitleColumn()`: which of the given collections have
	 * a user-defined `title` field. One query instead of one `hasTitleColumn`
	 * round-trip pair per collection -- callers that check this once per
	 * collection in a loop (multi-collection search, suggestions) should use
	 * this instead (AGENTS.md: "one query beats two").
	 */
	async getCollectionsWithTitleColumn(collectionSlugs: string[]): Promise<Set<string>> {
		if (collectionSlugs.length === 0) return new Set();

		const rows = await this.db
			.selectFrom("_emdash_fields as f")
			.innerJoin("_emdash_collections as c", "c.id", "f.collection_id")
			.select(["c.slug as collection_slug"])
			.where("f.slug", "=", "title")
			.execute();

		const withTitle = new Set(rows.map((r) => r.collection_slug));
		return new Set(collectionSlugs.filter((slug) => withTitle.has(slug)));
	}

	/**
	 * Enable search for a collection.
	 *
	 * Uses rebuildIndex to ensure a clean state -- drop any existing FTS
	 * table/triggers, recreate them, and populate from content. This avoids
	 * duplicate rows when triggers have already populated the index (e.g.
	 * during seeding where content is inserted before search is enabled).
	 */
	async enableSearch(
		collectionSlug: string,
		options?: { weights?: Record<string, number> },
	): Promise<void> {
		if (!isSqlite(this.db)) {
			throw new Error("Full-text search is only available with SQLite databases");
		}
		// Get searchable fields
		const searchableFields = await this.getSearchableFields(collectionSlug);

		if (searchableFields.length === 0) {
			throw new Error(
				`No searchable fields defined for collection "${collectionSlug}". ` +
					`Mark at least one field as searchable before enabling search.`,
			);
		}

		// Rebuild from scratch to ensure clean state (no duplicate rows)
		await this.rebuildIndex(collectionSlug, searchableFields, options?.weights);

		// Update search config
		await this.setSearchConfig(collectionSlug, {
			enabled: true,
			weights: options?.weights,
		});
	}

	/**
	 * Disable search for a collection
	 *
	 * Drops the FTS table and triggers.
	 */
	async disableSearch(collectionSlug: string): Promise<void> {
		if (!isSqlite(this.db)) return;
		await this.dropFtsTable(collectionSlug);
		const existing = await this.getSearchConfig(collectionSlug);
		await this.setSearchConfig(collectionSlug, { enabled: false, weights: existing?.weights });
	}

	/**
	 * Get index statistics for a collection
	 */
	async getIndexStats(
		collectionSlug: string,
	): Promise<{ indexed: number; lastRebuilt?: string } | null> {
		if (!isSqlite(this.db)) return null;
		this.validateInputs(collectionSlug);
		const ftsTable = this.getFtsTableName(collectionSlug);
		const ftsDocsizeTable = `${ftsTable}_docsize`;

		// Check if table exists
		if (!(await this.ftsTableExists(collectionSlug))) {
			return null;
		}

		// Count indexed rows
		const result = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "${sql.raw(ftsDocsizeTable)}"
		`.execute(this.db);

		return {
			indexed: result.rows[0]?.count ?? 0,
		};
	}

	/**
	 * Verify FTS index integrity and rebuild if drift is detected.
	 *
	 * Cheap belt-and-braces check, run lazily on the first search request
	 * per isolate. The expensive cases (corrupted indexes from pre-fix
	 * EmDash versions, broken legacy triggers) are handled at boot time by
	 * migration `039_fix_fts5_triggers`, not here. This routine sticks to:
	 *
	 *   1. FTS table missing while config says search is enabled -> rebuild.
	 *   2. Row count mismatch between content table and FTS docsize -> rebuild.
	 *
	 * Returns true if the index was rebuilt, false if it was healthy.
	 */
	async verifyAndRepairIndex(collectionSlug: string): Promise<boolean> {
		if (!isSqlite(this.db)) return false;
		this.validateInputs(collectionSlug);
		const ftsTable = this.getFtsTableName(collectionSlug);
		const ftsDocsizeTable = `${ftsTable}_docsize`;
		const contentTable = this.getContentTableName(collectionSlug);
		const fields = await this.getSearchableFields(collectionSlug);
		const config = await this.getSearchConfig(collectionSlug);

		if (!(await this.ftsTableExists(collectionSlug))) {
			if (!config?.enabled || fields.length === 0) {
				return false;
			}

			console.warn(`FTS index for "${collectionSlug}" is missing. Rebuilding.`);
			await this.rebuildIndex(collectionSlug, fields, config.weights);
			return true;
		}

		// Row count parity check. For external-content FTS tables, COUNT(*)
		// on the virtual table is answered from the backing content table
		// (including soft-deleted rows), so we use the docsize shadow table
		// which tracks rows actually present in the full-text index.
		const contentCount = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM ${sql.ref(contentTable)}
			WHERE deleted_at IS NULL
		`.execute(this.db);

		const ftsCount = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "${sql.raw(ftsDocsizeTable)}"
		`.execute(this.db);

		const contentRows = contentCount.rows[0]?.count ?? 0;
		const ftsRows = ftsCount.rows[0]?.count ?? 0;

		if (contentRows !== ftsRows) {
			console.warn(
				`FTS index for "${collectionSlug}" has ${ftsRows} rows but content table has ${contentRows}. Rebuilding.`,
			);
			if (fields.length > 0) {
				await this.rebuildIndex(collectionSlug, fields, config?.weights);
			}
			return true;
		}

		return false;
	}

	/**
	 * Verify and repair FTS indexes for all search-enabled collections.
	 *
	 * Intended to run at startup to auto-heal any corruption from
	 * previous process crashes.
	 */
	async verifyAndRepairAll(): Promise<number> {
		if (!isSqlite(this.db)) return 0;

		const collections = await this.db
			.selectFrom("_emdash_collections")
			.select("slug")
			.where("search_config", "is not", null)
			.execute();

		let repaired = 0;
		for (const { slug } of collections) {
			const config = await this.getSearchConfig(slug);
			if (!config?.enabled) continue;

			try {
				const wasRepaired = await this.verifyAndRepairIndex(slug);
				if (wasRepaired) repaired++;
			} catch (error) {
				console.error(`Failed to verify/repair FTS index for "${slug}":`, error);
			}
		}

		return repaired;
	}
}
