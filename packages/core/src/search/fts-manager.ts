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
import { SEARCH_TOKENIZERS } from "./types.js";
import type { SearchConfig, SearchTokenizer } from "./types.js";

const DEFAULT_SEARCH_TOKENIZER: SearchTokenizer = "porter unicode61";

function isSearchTokenizer(value: unknown): value is SearchTokenizer {
	return SEARCH_TOKENIZERS.some((tokenizer) => tokenizer === value);
}

function resolveSearchTokenizer(tokenize?: SearchTokenizer): SearchTokenizer {
	if (tokenize === undefined) return DEFAULT_SEARCH_TOKENIZER;
	if (!isSearchTokenizer(tokenize)) {
		throw new Error(`Unsupported FTS5 tokenizer: "${String(tokenize)}"`);
	}
	return tokenize;
}

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
	 * @param tokenize - Optional FTS5 tokenizer configuration
	 */
	async createFtsTable(
		collectionSlug: string,
		searchableFields: string[],
		_weights?: Record<string, number>,
		tokenize?: SearchTokenizer,
	): Promise<void> {
		const tokenizer = resolveSearchTokenizer(tokenize);
		if (!isSqlite(this.db)) return;
		this.validateInputs(collectionSlug, searchableFields);
		const ftsTable = this.getFtsTableName(collectionSlug);

		// Build the column list for FTS5
		// id and locale are UNINDEXED (used for joining/filtering, not searched)
		const columns = ["id UNINDEXED", "locale UNINDEXED", ...searchableFields].join(", ");

		// Create the FTS5 virtual table. The table stores its own copy of the
		// indexed values (no `content=` option): Portable Text fields are
		// indexed as extracted plain text — see searchValueExpr — which cannot
		// mirror the raw JSON in the ec_* column, and external-content FTS5
		// requires the index to exactly mirror the backing table's values
		// (snippet() reads them, and the 'delete' command must be fed the
		// inserted values or the index corrupts — see migration 039's history).
		// Storing the extracted text also makes snippet() return prose.
		await sql
			.raw(`
			CREATE VIRTUAL TABLE IF NOT EXISTS "${ftsTable}" USING fts5(
				${columns},
				tokenize='${tokenizer}'
			)
		`)
			.execute(this.db);

		// Create triggers for automatic sync
		await this.createTriggers(collectionSlug, searchableFields);
	}

	/**
	 * SQL expression producing the indexed value for one searchable field.
	 *
	 * Portable Text fields are stored as JSON; indexing the raw JSON pollutes
	 * the index with structural tokens (`_type`, style values like `normal`,
	 * `_key` ULIDs) and makes snippets show JSON fragments. Extract the prose
	 * instead: every JSON string under a `text`, `alt`, `caption`, or `code`
	 * key (span text, image alt/caption, code blocks). This is a superset of
	 * `extractPlainText` in text-extraction.ts, which walks only known block
	 * shapes — the SQL variant takes those keys at any depth, so search and
	 * the extractPlainText consumers (vectorize/ai-search) can see different
	 * text for the same document. Only JSON documents
	 * (arrays/objects) are extracted; legacy rows holding a bare string or a
	 * JSON scalar (`Some title`, `2024`) are indexed as-is. Extraction must
	 * live in SQL because the sync triggers cannot call into JS.
	 *
	 * `ref` must be a validated column reference (`NEW.x`, `OLD.x`, `"x"`).
	 */
	private searchValueExpr(ref: string, fieldType: string | undefined): string {
		if (fieldType !== "portableText") return ref;
		return (
			`CASE WHEN ${ref} IS NULL THEN NULL ` +
			`WHEN json_valid(${ref}) AND json_type(${ref}) IN ('array', 'object') THEN (` +
			`SELECT group_concat(j.value, ' ') FROM json_tree(${ref}) AS j ` +
			`WHERE j.key IN ('text', 'alt', 'caption', 'code') AND j.type = 'text') ` +
			`ELSE ${ref} END`
		);
	}

	/**
	 * Field type per slug for a collection, for choosing the indexed-value
	 * expression. Fields missing from the schema fall back to raw indexing.
	 */
	private async getFieldTypes(collectionSlug: string): Promise<Map<string, string>> {
		const collection = await this.db
			.selectFrom("_emdash_collections")
			.select("id")
			.where("slug", "=", collectionSlug)
			.executeTakeFirst();
		if (!collection) return new Map();

		const rows = await this.db
			.selectFrom("_emdash_fields")
			.select(["slug", "type"])
			.where("collection_id", "=", collection.id)
			.execute();
		return new Map(rows.map((r) => [r.slug, r.type]));
	}

	/**
	 * Create triggers to keep FTS table in sync with content table.
	 *
	 * The insert and update triggers only add rows to the FTS index when
	 * `deleted_at IS NULL`. This keeps soft-deleted content out of the
	 * search index and ensures the FTS row count matches the non-deleted
	 * content count (which `verifyAndRepairIndex` relies on).
	 *
	 * The FTS table stores its own values (no `content=` option), so removal
	 * is a plain `DELETE FROM fts WHERE rowid = OLD.rowid` — a harmless no-op
	 * for rows that were never indexed (soft-deleted content). The
	 * external-content `'delete'`-command choreography and its corruption
	 * modes (migration 039) do not apply to self-contained tables.
	 *
	 * `INSERT OR REPLACE` keeps the insert path idempotent: re-running a
	 * populate (D1 has no migration lock, so two isolates can race) converges
	 * on one index row per content row instead of failing on the rowid
	 * constraint.
	 *
	 * The trigger SQL emitted here MUST stay in lock-step with migration
	 * `064_fts_plain_text.ts`. If this changes again, add a new migration
	 * rather than editing shipped ones — migrations are forward-only.
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
		const fieldTypes = await this.getFieldTypes(collectionSlug);
		const fieldList = searchableFields.join(", ");
		const newValueList = searchableFields
			.map((f) => this.searchValueExpr(`NEW.${f}`, fieldTypes.get(f)))
			.join(", ");

		// Insert trigger - only index non-deleted content
		await sql
			.raw(`
			CREATE TRIGGER IF NOT EXISTS "${ftsTable}_insert"
			AFTER INSERT ON "${contentTable}"
			WHEN NEW.deleted_at IS NULL
			BEGIN
				INSERT OR REPLACE INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
				VALUES (NEW.rowid, NEW.id, NEW.locale, ${newValueList});
			END
		`)
			.execute(this.db);

		// Update trigger - drop the old index row, re-insert when the row is
		// still visible. Trash (deleted_at set) ends at DELETE only; restore
		// ends at DELETE (no-op) + re-insert.
		//
		// The WHEN guard compares raw column values (null-safe IS NOT) so the
		// trigger fires only when an indexed value, the row's locale, or its
		// trash state actually changed. Without it every UPDATE re-tokenizes
		// the whole document — metadata-only saves (status flips, scheduling,
		// version bumps) and the publish path's rewrite-identical-values
		// UPDATEs dominate save CPU and WAL volume. deleted_at must stay in
		// the guard or trash/restore stop syncing the index.
		const changedCondition = ["deleted_at", "locale", ...searchableFields]
			.map((f) => `OLD.${f} IS NOT NEW.${f}`)
			.join(" OR ");
		await sql
			.raw(`
			CREATE TRIGGER IF NOT EXISTS "${ftsTable}_update"
			AFTER UPDATE ON "${contentTable}"
			WHEN ${changedCondition}
			BEGIN
				DELETE FROM "${ftsTable}" WHERE rowid = OLD.rowid;
				INSERT INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
				SELECT NEW.rowid, NEW.id, NEW.locale, ${newValueList}
				WHERE NEW.deleted_at IS NULL;
			END
		`)
			.execute(this.db);

		// Delete trigger
		await sql
			.raw(`
			CREATE TRIGGER IF NOT EXISTS "${ftsTable}_delete"
			AFTER DELETE ON "${contentTable}"
			BEGIN
				DELETE FROM "${ftsTable}" WHERE rowid = OLD.rowid;
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
		tokenize?: SearchTokenizer,
	): Promise<void> {
		resolveSearchTokenizer(tokenize);
		if (!isSqlite(this.db)) return;
		// Drop existing table and triggers
		await this.dropFtsTable(collectionSlug);

		// Recreate table and triggers
		await this.createFtsTable(collectionSlug, searchableFields, weights, tokenize);

		// Populate from existing content
		await this.populateFromContent(collectionSlug, searchableFields);
	}

	/**
	 * Populate the FTS table from existing content.
	 *
	 * `INSERT OR REPLACE` so a concurrent double-populate (D1 has no
	 * migration lock) converges instead of failing on the rowid constraint.
	 */
	async populateFromContent(collectionSlug: string, searchableFields: string[]): Promise<void> {
		if (!isSqlite(this.db)) return;
		this.validateInputs(collectionSlug, searchableFields);
		const ftsTable = this.getFtsTableName(collectionSlug);
		const contentTable = this.getContentTableName(collectionSlug);
		const fieldTypes = await this.getFieldTypes(collectionSlug);
		const fieldList = searchableFields.join(", ");
		// Table-qualified references: json_tree exposes columns named
		// key/value/type/path/..., and inside the extraction subquery a bare
		// column reference binds to those instead of the ec_* column.
		const valueList = searchableFields
			.map((f) => this.searchValueExpr(`"${contentTable}"."${f}"`, fieldTypes.get(f)))
			.join(", ");

		// Insert all existing content into FTS table
		await sql
			.raw(`
			INSERT OR REPLACE INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
			SELECT rowid, id, locale, ${valueList} FROM "${contentTable}"
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
			if ("tokenize" in parsed) {
				if (!isSearchTokenizer(parsed.tokenize)) {
					return null;
				}
				config.tokenize = parsed.tokenize;
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
		if (config.tokenize !== undefined) {
			resolveSearchTokenizer(config.tokenize);
		}
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
		options?: { weights?: Record<string, number>; tokenize?: SearchTokenizer },
	): Promise<void> {
		if (options?.tokenize !== undefined) {
			resolveSearchTokenizer(options.tokenize);
		}
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

		const existing = await this.getSearchConfig(collectionSlug);
		const weights = options?.weights ?? existing?.weights;
		const tokenize = options?.tokenize ?? existing?.tokenize;

		// Rebuild from scratch to ensure clean state (no duplicate rows)
		await this.rebuildIndex(collectionSlug, searchableFields, weights, tokenize);

		// Update search config
		await this.setSearchConfig(collectionSlug, {
			enabled: true,
			weights,
			tokenize,
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
		await this.setSearchConfig(collectionSlug, {
			enabled: false,
			weights: existing?.weights,
			tokenize: existing?.tokenize,
		});
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
			await this.rebuildIndex(collectionSlug, fields, config.weights, config.tokenize);
			return true;
		}

		// Row count parity check against the docsize shadow table, which
		// tracks rows actually present in the full-text index.
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
				await this.rebuildIndex(collectionSlug, fields, config?.weights, config?.tokenize);
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
