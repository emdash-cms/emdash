import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isSqlite, listTablesLike } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

/**
 * Migration: i18n support (row-per-locale model)
 *
 * Each piece of content can exist in multiple locales. Translations of the
 * same content share a `translation_group` ULID while each row carries its
 * own `locale` code. Slugs are unique per-locale, not globally.
 *
 * Changes:
 * 1. For every ec_* content table:
 *    - Rebuild the table to replace inline `slug TEXT UNIQUE` with
 *      `slug TEXT` + a compound `UNIQUE(slug, locale)` constraint.
 *    - Add `locale TEXT NOT NULL DEFAULT 'en'`
 *    - Add `translation_group TEXT`
 *    - Backfill `translation_group = id` for existing rows
 *    - Recreate all standard indexes plus new locale/translation_group indexes
 *
 * 2. Add `translatable` column to `_emdash_fields`
 *
 * The table-rebuild approach is required because SQLite cannot drop an inline
 * UNIQUE constraint via ALTER TABLE. We use PRAGMA table_info to discover all
 * columns (including dynamic user-defined fields) and rebuild dynamically.
 */

// Column info returned by PRAGMA table_info
interface ColumnInfo {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

// Index info returned by PRAGMA index_list
interface IndexInfo {
	seq: number;
	name: string;
	unique: number;
	origin: string;
	partial: number;
}

// Index column info returned by PRAGMA index_info
interface IndexColumnInfo {
	seqno: number;
	cid: number;
	name: string;
}

/**
 * Quote an identifier for use in raw SQL. Escapes embedded double-quotes
 * per SQL standard (double them). The name should first pass
 * validateIdentifier() or validateTableName() for defense-in-depth.
 */
const DOUBLE_QUOTE_RE = /"/g;
function quoteIdent(name: string): string {
	return `"${name.replace(DOUBLE_QUOTE_RE, '""')}"`;
}

/** Suffix added to tmp tables during i18n migration rebuild. */
const I18N_TMP_SUFFIX = /_i18n_tmp$/;

/** Table names from sqlite_master are ec_{slug} — validate the pattern. */
const TABLE_NAME_PATTERN = /^ec_[a-z][a-z0-9_]*$/;
function validateTableName(name: string): void {
	if (!TABLE_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid content table name: "${name}"`);
	}
}

/** SQLite column types produced by EmDash's schema registry. */
const ALLOWED_COLUMN_TYPES = new Set(["TEXT", "INTEGER", "REAL", "BLOB", "JSON", "NUMERIC", ""]);
function validateColumnType(type: string, colName: string): void {
	if (!ALLOWED_COLUMN_TYPES.has(type.toUpperCase())) {
		throw new Error(`Unexpected column type "${type}" for column "${colName}"`);
	}
}

/**
 * Validate that a default value expression from PRAGMA table_info is safe
 * to interpolate into DDL. Allows: string literals, numeric literals,
 * NULL, and known function calls like datetime('now').
 *
 * Note: PRAGMA table_info strips the outer parens from expression defaults,
 * so `DEFAULT (datetime('now'))` is reported as `datetime('now')`.
 * We accept both forms and re-wrap in parens via normalizeDdlDefault().
 */
const SAFE_DEFAULT_PATTERN =
	/^(?:'[^']*'|NULL|-?\d+(?:\.\d+)?|\(?datetime\('now'\)\)?|\(?json\('[^']*'\)\)?|0|1)$/i;
function validateDefaultValue(value: string, colName: string): void {
	if (!SAFE_DEFAULT_PATTERN.test(value)) {
		throw new Error(`Unexpected default value "${value}" for column "${colName}"`);
	}
}

/**
 * Normalize a PRAGMA table_info default value for use in DDL.
 * Function-call defaults (e.g. `datetime('now')`) must be wrapped in parens
 * to form valid expression defaults: `DEFAULT (datetime('now'))`.
 * PRAGMA strips the outer parens, so we re-add them here.
 */
const FUNCTION_DEFAULT_PATTERN = /^(?:datetime|json)\(/i;
function normalizeDdlDefault(value: string): string {
	// Already wrapped in parens — return as-is
	if (value.startsWith("(")) return value;
	if (FUNCTION_DEFAULT_PATTERN.test(value)) return `(${value})`;
	return value;
}

/**
 * Validate that a CREATE INDEX statement from sqlite_master is safe to replay.
 * Must start with CREATE [UNIQUE] INDEX and not contain suspicious patterns.
 */
const CREATE_INDEX_PATTERN = /^CREATE\s+(UNIQUE\s+)?INDEX\s+/i;
function validateCreateIndexSql(sqlStr: string, idxName: string): void {
	if (!CREATE_INDEX_PATTERN.test(sqlStr)) {
		throw new Error(`Unexpected index SQL for "${idxName}": does not match CREATE INDEX pattern`);
	}
	// Reject semicolons which could allow statement injection
	if (sqlStr.includes(";")) {
		throw new Error(`Unexpected index SQL for "${idxName}": contains semicolon`);
	}
}

/**
 * PostgreSQL path: ALTER TABLE supports ADD COLUMN and DROP CONSTRAINT directly.
 * No table rebuild needed.
 */
async function upPostgres(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const t of tableNames) {
		validateTableName(t);

		// Check if already migrated (idempotency)
		const hasLocale = await sql<{ exists: boolean }>`
			SELECT EXISTS(
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema() AND table_name = ${t} AND column_name = 'locale'
			) as exists
		`.execute(db);
		if (hasLocale.rows[0]?.exists === true) continue;

		// Add i18n columns
		await sql`ALTER TABLE ${sql.ref(t)} ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'`.execute(db);
		await sql`ALTER TABLE ${sql.ref(t)} ADD COLUMN translation_group TEXT`.execute(db);

		// Drop existing unique constraint on slug (Postgres auto-names these)
		// Find the constraint name first
		const constraints = await sql<{ conname: string }>`
			SELECT conname FROM pg_constraint
			WHERE conrelid = ${t}::regclass
			AND contype = 'u'
			AND array_length(conkey, 1) = 1
			AND conkey[1] = (
				SELECT attnum FROM pg_attribute
				WHERE attrelid = ${t}::regclass AND attname = 'slug'
			)
		`.execute(db);

		for (const c of constraints.rows) {
			await sql`ALTER TABLE ${sql.ref(t)} DROP CONSTRAINT ${sql.ref(c.conname)}`.execute(db);
		}

		// Add compound unique constraint
		await sql`
			ALTER TABLE ${sql.ref(t)}
			ADD CONSTRAINT ${sql.ref(`${t}_slug_locale_unique`)} UNIQUE (slug, locale)
		`.execute(db);

		// Backfill translation_group
		await sql`UPDATE ${sql.ref(t)} SET translation_group = id`.execute(db);

		// Create indexes
		await sql`CREATE INDEX ${sql.ref(`idx_${t}_locale`)} ON ${sql.ref(t)} (locale)`.execute(db);
		await sql`
			CREATE INDEX ${sql.ref(`idx_${t}_translation_group`)}
			ON ${sql.ref(t)} (translation_group)
		`.execute(db);
	}

	// Add translatable flag to fields table
	const hasTranslatable = await sql<{ exists: boolean }>`
		SELECT EXISTS(
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = '_emdash_fields' AND column_name = 'translatable'
		) as exists
	`.execute(db);
	if (hasTranslatable.rows[0]?.exists !== true) {
		await sql`
			ALTER TABLE _emdash_fields
			ADD COLUMN translatable INTEGER NOT NULL DEFAULT 1
		`.execute(db);
	}
}

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isSqlite(db)) {
		return upPostgres(db);
	}

	// Clean up orphaned tmp tables from a previous partial run.
	// On D1 (no transactions), a crash mid-migration can leave these behind.
	const orphanedTmps = await listTablesLike(db, "ec_%_i18n_tmp");
	for (const tmpName of orphanedTmps) {
		validateTableName(tmpName.replace(I18N_TMP_SUFFIX, ""));
		await sql`DROP TABLE IF EXISTS ${sql.ref(tmpName)}`.execute(db);
	}

	// Discover all ec_* content tables
	const tableNames = await listTablesLike(db, "ec_%");
	const tables = { rows: tableNames.map((name) => ({ name })) };

	for (const table of tables.rows) {
		const t = table.name;
		validateTableName(t);
		const tmp = `${t}_i18n_tmp`;

		// Note: no transaction wrapper — D1 doesn't support transactions,
		// and SQLite/better-sqlite3 is single-writer so crash-safety is
		// handled by the journal mode. The tmp table approach is already
		// crash-recoverable (orphaned tmp tables are harmless).
		{
			const trx = db;
			// ── 1. Read existing column definitions ──────────────────────
			const colResult = await sql<ColumnInfo>`
				PRAGMA table_info(${sql.ref(t)})
			`.execute(trx);
			const columns = colResult.rows;

			// ── Idempotency: skip tables already migrated ───────────────
			// On D1, the migrator can't use transactions, so a partially-
			// applied migration may not be recorded. If the table already
			// has a `locale` column, it was already rebuilt — skip it.
			if (columns.some((col) => col.name === "locale")) {
				continue;
			}

			// ── 2. Read existing indexes (to recreate after rebuild) ─────
			const idxResult = await sql<IndexInfo>`
				PRAGMA index_list(${sql.ref(t)})
			`.execute(trx);

			// Collect non-autoindex, non-primary-key indexes for recreation
			const indexDefs: { name: string; unique: boolean; columns: string[]; partial: number }[] = [];
			for (const idx of idxResult.rows) {
				// Skip autoindexes (created by inline UNIQUE) — we're removing them
				if (idx.origin === "pk" || idx.name.startsWith("sqlite_autoindex_")) continue;

				const idxColResult = await sql<IndexColumnInfo>`
					PRAGMA index_info(${sql.ref(idx.name)})
				`.execute(trx);

				indexDefs.push({
					name: idx.name,
					unique: idx.unique === 1,
					columns: idxColResult.rows.map((c) => c.name),
					partial: idx.partial,
				});
			}

			// For partial indexes we need the original CREATE statement
			const partialSqls = new Map<string, string>();
			for (const idx of indexDefs) {
				if (idx.partial) {
					const createResult = await sql<{ sql: string }>`
						SELECT sql FROM sqlite_master 
						WHERE type = 'index' AND name = ${idx.name}
					`.execute(trx);
					if (createResult.rows[0]?.sql) {
						partialSqls.set(idx.name, createResult.rows[0].sql);
					}
				}
			}

			// ── 3. Build column defs for the new table ──────────────────
			// Validate all column names from PRAGMA before using them in raw SQL.
			// These originate from our own schema, but defense-in-depth matters.
			for (const col of columns) {
				validateIdentifier(col.name, "column name");
			}

			// Replace slug's inline UNIQUE with a table-level UNIQUE(slug, locale)
			const colDefs: string[] = [];
			const colNames: string[] = [];

			for (const col of columns) {
				validateColumnType(col.type || "TEXT", col.name);
				colNames.push(quoteIdent(col.name));
				let def = `${quoteIdent(col.name)} ${col.type || "TEXT"}`;

				if (col.pk) {
					def += " PRIMARY KEY";
				} else if (col.name === "slug") {
					// Intentionally omit UNIQUE — compound unique below
				} else {
					if (col.notnull) def += " NOT NULL";
				}

				if (col.dflt_value !== null) {
					validateDefaultValue(col.dflt_value, col.name);
					def += ` DEFAULT ${normalizeDdlDefault(col.dflt_value)}`;
				}

				colDefs.push(def);
			}

			// Append new i18n columns
			colDefs.push("\"locale\" TEXT NOT NULL DEFAULT 'en'");
			colDefs.push('"translation_group" TEXT');

			// Compound unique: same slug + locale must be unique
			colDefs.push('UNIQUE("slug", "locale")');

			const createColsSql = colDefs.join(",\n\t\t\t\t");
			const selectColsSql = colNames.join(", ");

			// ── 4. Rebuild the table ────────────────────────────────────
			// Drop all existing indexes first (they reference the old table)
			for (const idx of indexDefs) {
				await sql`DROP INDEX IF EXISTS ${sql.ref(idx.name)}`.execute(trx);
			}

			// Create new table with updated schema
			await sql
				.raw(`CREATE TABLE ${quoteIdent(tmp)} (\n\t\t\t\t${createColsSql}\n\t\t\t)`)
				.execute(trx);

			// Copy existing data, backfilling locale='en' and translation_group=id
			await sql
				.raw(
					`INSERT INTO ${quoteIdent(tmp)} (${selectColsSql}, "locale", "translation_group")\n\t\t\t SELECT ${selectColsSql}, 'en', "id" FROM ${quoteIdent(t)}`,
				)
				.execute(trx);

			// Swap tables
			await sql`DROP TABLE ${sql.ref(t)}`.execute(trx);
			await sql.raw(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(t)}`).execute(trx);

			// ── 5. Recreate all original indexes ────────────────────────
			for (const idx of indexDefs) {
				// Skip the old slug-only index — replaced by slug_locale below
				if (idx.name === `idx_${t}_slug`) continue;

				if (idx.partial && partialSqls.has(idx.name)) {
					// Partial indexes — validate the SQL before replaying
					const idxSql = partialSqls.get(idx.name)!;
					validateCreateIndexSql(idxSql, idx.name);
					await sql.raw(idxSql).execute(trx);
				} else {
					// Validate index column names before interpolation
					for (const c of idx.columns) {
						validateIdentifier(c, "index column name");
					}
					const cols = idx.columns.map((c) => quoteIdent(c)).join(", ");
					const unique = idx.unique ? "UNIQUE " : "";
					await sql
						.raw(`CREATE ${unique}INDEX ${quoteIdent(idx.name)} ON ${quoteIdent(t)} (${cols})`)
						.execute(trx);
				}
			}

			// ── 6. Create new i18n indexes ──────────────────────────────
			// slug_locale unique is handled by the table constraint above,
			// but we still want a regular slug index for non-locale-aware queries
			await sql`
				CREATE INDEX ${sql.ref(`idx_${t}_slug`)} 
				ON ${sql.ref(t)} (slug)
			`.execute(trx);

			await sql`
				CREATE INDEX ${sql.ref(`idx_${t}_locale`)} 
				ON ${sql.ref(t)} (locale)
			`.execute(trx);

			await sql`
				CREATE INDEX ${sql.ref(`idx_${t}_translation_group`)} 
				ON ${sql.ref(t)} (translation_group)
			`.execute(trx);
		}
	}

	// ── 7. Add translatable flag to fields table ────────────────────
	// Guard against duplicate column — on D1 the migration may have
	// partially applied without being recorded (no transaction support).
	const fieldCols = await sql<ColumnInfo>`
		PRAGMA table_info(_emdash_fields)
	`.execute(db);
	if (!fieldCols.rows.some((col) => col.name === "translatable")) {
		await sql`
			ALTER TABLE _emdash_fields 
			ADD COLUMN translatable INTEGER NOT NULL DEFAULT 1
		`.execute(db);
	}
}

/**
 * PostgreSQL down path: straightforward ALTER TABLE operations.
 */
async function downPostgres(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE _emdash_fields DROP COLUMN translatable`.execute(db);

	const tableNames = await listTablesLike(db, "ec_%");
	for (const t of tableNames) {
		validateTableName(t);

		// Drop i18n indexes
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${t}_locale`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${t}_translation_group`)}`.execute(db);

		// Drop compound unique constraint
		await sql`ALTER TABLE ${sql.ref(t)} DROP CONSTRAINT IF EXISTS ${sql.ref(`${t}_slug_locale_unique`)}`.execute(
			db,
		);

		// Restore simple unique constraint on slug
		await sql`ALTER TABLE ${sql.ref(t)} ADD CONSTRAINT ${sql.ref(`${t}_slug_unique`)} UNIQUE (slug)`.execute(
			db,
		);

		// Drop i18n columns
		await sql`ALTER TABLE ${sql.ref(t)} DROP COLUMN locale`.execute(db);
		await sql`ALTER TABLE ${sql.ref(t)} DROP COLUMN translation_group`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (!isSqlite(db)) {
		return downPostgres(db);
	}

	// Remove translatable column from fields table
	await sql`
		ALTER TABLE _emdash_fields
		DROP COLUMN translatable
	`.execute(db);

	// Discover all ec_* content tables
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const t = tableName;
		validateTableName(t);
		const tmp = `${t}_i18n_tmp`;

		// No transaction — see comment in up() above.
		{
			const trx = db;
			// ── 1. Read current column definitions ──────────────────────
			const colResult = await sql<ColumnInfo>`
				PRAGMA table_info(${sql.ref(t)})
			`.execute(trx);
			const columns = colResult.rows;

			// ── 2. Read current indexes ─────────────────────────────────
			const idxResult = await sql<IndexInfo>`
				PRAGMA index_list(${sql.ref(t)})
			`.execute(trx);

			const indexDefs: { name: string; unique: boolean; columns: string[]; partial: number }[] = [];
			for (const idx of idxResult.rows) {
				if (idx.origin === "pk" || idx.name.startsWith("sqlite_autoindex_")) continue;

				const idxColResult = await sql<IndexColumnInfo>`
					PRAGMA index_info(${sql.ref(idx.name)})
				`.execute(trx);

				indexDefs.push({
					name: idx.name,
					unique: idx.unique === 1,
					columns: idxColResult.rows.map((c) => c.name),
					partial: idx.partial,
				});
			}

			// Save partial index SQL
			const partialSqls = new Map<string, string>();
			for (const idx of indexDefs) {
				if (idx.partial) {
					const createResult = await sql<{ sql: string }>`
						SELECT sql FROM sqlite_master 
						WHERE type = 'index' AND name = ${idx.name}
					`.execute(trx);
					if (createResult.rows[0]?.sql) {
						partialSqls.set(idx.name, createResult.rows[0].sql);
					}
				}
			}

			// ── 3. Build column defs WITHOUT locale/translation_group ───
			// Validate all column names
			for (const col of columns) {
				if (col.name === "locale" || col.name === "translation_group") continue;
				validateIdentifier(col.name, "column name");
			}

			// Restore slug's inline UNIQUE
			const colDefs: string[] = [];
			const colNames: string[] = [];

			for (const col of columns) {
				// Skip i18n columns
				if (col.name === "locale" || col.name === "translation_group") continue;

				validateColumnType(col.type || "TEXT", col.name);
				colNames.push(quoteIdent(col.name));
				let def = `${quoteIdent(col.name)} ${col.type || "TEXT"}`;

				if (col.pk) {
					def += " PRIMARY KEY";
				} else if (col.name === "slug") {
					// Restore inline UNIQUE
					def += " UNIQUE";
				} else {
					if (col.notnull) def += " NOT NULL";
				}

				if (col.dflt_value !== null) {
					validateDefaultValue(col.dflt_value, col.name);
					def += ` DEFAULT ${normalizeDdlDefault(col.dflt_value)}`;
				}

				colDefs.push(def);
			}

			const createColsSql = colDefs.join(",\n\t\t\t\t");
			const selectColsSql = colNames.join(", ");

			// ── 4. Rebuild the table ────────────────────────────────────
			// Drop all existing indexes first
			for (const idx of indexDefs) {
				await sql`DROP INDEX IF EXISTS ${sql.ref(idx.name)}`.execute(trx);
			}

			// Create table with original schema (slug UNIQUE, no i18n columns)
			await sql
				.raw(`CREATE TABLE ${quoteIdent(tmp)} (\n\t\t\t\t${createColsSql}\n\t\t\t)`)
				.execute(trx);

			// Copy data — keep only one row per content item.
			// Prefer locale='en' rows. For items without an 'en' row, pick the
			// row with the smallest locale code (deterministic, unlike bare GROUP BY).
			// Handle NULL translation_group by treating each such row as its own group.
			// INSERT OR IGNORE skips any duplicate slugs from the fallback pass.
			await sql
				.raw(
					`INSERT OR IGNORE INTO ${quoteIdent(tmp)} (${selectColsSql})
			 SELECT ${selectColsSql} FROM ${quoteIdent(t)}
			 WHERE "locale" = 'en'`,
				)
				.execute(trx);

			await sql
				.raw(
					`INSERT OR IGNORE INTO ${quoteIdent(tmp)} (${selectColsSql})
			 SELECT ${selectColsSql} FROM ${quoteIdent(t)}
			 WHERE "id" NOT IN (SELECT "id" FROM ${quoteIdent(tmp)})
			 AND "id" IN (
				SELECT "id" FROM ${quoteIdent(t)} AS t2
				WHERE t2."translation_group" IS NOT NULL
				AND t2."locale" = (
					SELECT MIN(t3."locale") FROM ${quoteIdent(t)} AS t3
					WHERE t3."translation_group" = t2."translation_group"
				)
			 )`,
				)
				.execute(trx);

			// Pick up any rows with NULL translation_group that weren't already copied
			await sql
				.raw(
					`INSERT OR IGNORE INTO ${quoteIdent(tmp)} (${selectColsSql})
			 SELECT ${selectColsSql} FROM ${quoteIdent(t)}
			 WHERE "id" NOT IN (SELECT "id" FROM ${quoteIdent(tmp)})
			 AND "translation_group" IS NULL`,
				)
				.execute(trx);

			// Swap tables
			await sql`DROP TABLE ${sql.ref(t)}`.execute(trx);
			await sql.raw(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(t)}`).execute(trx);

			// ── 5. Recreate indexes ─────────────────────────────────────
			for (const idx of indexDefs) {
				// Skip i18n-specific indexes — they don't exist in the old schema
				if (idx.name === `idx_${t}_locale`) continue;
				if (idx.name === `idx_${t}_translation_group`) continue;

				if (idx.partial && partialSqls.has(idx.name)) {
					// Partial indexes — validate the SQL before replaying
					const idxSql = partialSqls.get(idx.name)!;
					validateCreateIndexSql(idxSql, idx.name);
					await sql.raw(idxSql).execute(trx);
				} else {
					// Filter out i18n columns from any index that might reference them
					const cols = idx.columns.filter((c) => c !== "locale" && c !== "translation_group");
					if (cols.length === 0) continue;

					// Validate column names
					for (const c of cols) {
						validateIdentifier(c, "index column name");
					}
					const colsSql = cols.map((c) => quoteIdent(c)).join(", ");
					const unique = idx.unique ? "UNIQUE " : "";
					await sql
						.raw(`CREATE ${unique}INDEX ${quoteIdent(idx.name)} ON ${quoteIdent(t)} (${colsSql})`)
						.execute(trx);
				}
			}
		}
	}
}
