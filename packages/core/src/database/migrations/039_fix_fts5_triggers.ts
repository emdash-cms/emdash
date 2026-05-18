import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isSqlite } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

/**
 * Migration: Rebuild FTS5 indexes with corruption-safe triggers
 *
 * Background: FTS5 virtual tables created with `content='ec_<slug>'` are
 * *external content* tables. Pre-fix versions of EmDash used the
 * *contentless*-table sync pattern in their triggers
 * (`DELETE FROM fts WHERE rowid = OLD.rowid`), which is unsafe for
 * external-content FTS5 because FTS5 then reads the *current* row from
 * `ec_<slug>` to compute the tokens to remove. By the time
 * `AFTER UPDATE` fires the row already holds NEW values, so the wrong
 * tokens are removed and the inverted index drifts out of sync until
 * SQLite raises `SQLITE_CORRUPT_VTAB` on the next mutation
 * (see issue #649, PR #768).
 *
 * The fix that ships in the same release rewrites the triggers to use
 * the documented external-content-safe form:
 *
 *     INSERT INTO fts(fts, rowid, col1, col2)
 *     VALUES('delete', OLD.rowid, OLD.col1, OLD.col2);
 *
 * gated on `OLD.deleted_at IS NULL` so we don't try to remove rows that
 * were never indexed (which would itself raise `SQLITE_CORRUPT_VTAB`).
 *
 * This migration finalises the fix for *upgrading* sites. New triggers
 * alone are not enough: existing sites still carry the broken triggers in
 * `sqlite_master` and, in many cases, an already-corrupted FTS shadow
 * index. We:
 *
 *   1. Find every collection with FTS enabled
 *      (`_emdash_collections.search_config -> enabled = true`).
 *   2. Drop its three sync triggers and the FTS5 virtual table itself
 *      (which removes the shadow tables `<fts>_data`, `<fts>_idx`,
 *      `<fts>_docsize`, `<fts>_config`, `<fts>_content`).
 *   3. Recreate the FTS5 table and triggers with the corruption-safe
 *      `'delete'` form.
 *   4. Repopulate from `ec_<slug> WHERE deleted_at IS NULL`.
 *
 * The trigger SQL emitted here MUST stay in lock-step with
 * `FTSManager.createTriggers` in `src/search/fts-manager.ts`. The two
 * code paths build the same triggers from the same field list; keeping
 * them aligned means a fresh install (via FTSManager) and an upgraded
 * install (via this migration) end up with identical schemas. If
 * `createTriggers` ever changes again, add a new migration rather than
 * editing this one -- migrations are forward-only.
 *
 * Postgres: no-op. FTS5 is SQLite-only; the `FTSManager` already
 * short-circuits on non-SQLite, and there are no FTS tables to rebuild.
 *
 * D1: the migration is idempotent at the granularity we care about
 * (drop-then-create + repopulate). A partial re-apply that gets as far
 * as dropping the FTS table but not recreating it leaves the collection
 * without an index; the next runtime call to `verifyAndRepairIndex`
 * (e.g. on a search request) detects the missing table and rebuilds.
 * Re-running this migration in full is also safe -- it always replaces
 * the index from `ec_<slug>` content.
 */

interface CollectionRow {
	slug: string;
	search_config: string | null;
}

interface FieldRow {
	slug: string;
}

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isSqlite(db)) return;

	const collections = await sql<CollectionRow>`
		SELECT slug, search_config FROM _emdash_collections
		WHERE search_config IS NOT NULL
	`.execute(db);

	for (const collection of collections.rows) {
		if (!isSearchEnabled(collection.search_config)) continue;

		// Slug came from `_emdash_collections.slug`, where the schema
		// registry validates it against the same identifier rules on
		// write. Re-validate here defensively before interpolating it
		// into raw SQL -- this is a migration, so a malformed slug
		// that somehow landed in the DB must not become an injection
		// vector.
		try {
			validateIdentifier(collection.slug, "collection slug");
		} catch (error) {
			console.warn(
				`[migration 039] skipping FTS rebuild for collection "${collection.slug}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			continue;
		}

		const fields = await getSearchableFields(db, collection.slug);
		if (fields.length === 0) {
			// `search_config.enabled = true` but no searchable fields:
			// disable search and drop any orphan FTS objects. This
			// matches FTSManager's "no fields -> disable" behavior.
			await dropFtsObjects(db, collection.slug);
			await sql`
				UPDATE _emdash_collections
				SET search_config = json_set(search_config, '$.enabled', json('false'))
				WHERE slug = ${collection.slug}
			`.execute(db);
			continue;
		}

		await rebuildIndex(db, collection.slug, fields);
	}
}

/**
 * Forward-only migration. Down is a no-op: we cannot meaningfully
 * "restore the broken triggers" and there is no migration-level state
 * to roll back. The FTS tables themselves are managed by `FTSManager`
 * at runtime, not by this migration, so leaving them in their
 * corruption-safe state on rollback is correct.
 */
export async function down(_db: Kysely<unknown>): Promise<void> {
	// no-op
}

function isSearchEnabled(searchConfig: string | null): boolean {
	if (!searchConfig) return false;
	try {
		const parsed: unknown = JSON.parse(searchConfig);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"enabled" in parsed &&
			(parsed as { enabled: unknown }).enabled === true
		);
	} catch {
		return false;
	}
}

async function getSearchableFields(db: Kysely<unknown>, collectionSlug: string): Promise<string[]> {
	const rows = await sql<FieldRow>`
		SELECT f.slug FROM _emdash_fields f
		INNER JOIN _emdash_collections c ON c.id = f.collection_id
		WHERE c.slug = ${collectionSlug} AND f.searchable = 1
	`.execute(db);

	const out: string[] = [];
	for (const row of rows.rows) {
		try {
			validateIdentifier(row.slug, "searchable field name");
			out.push(row.slug);
		} catch {
			console.warn(
				`[migration 039] skipping invalid searchable field "${row.slug}" on collection "${collectionSlug}"`,
			);
		}
	}
	return out;
}

async function rebuildIndex(
	db: Kysely<unknown>,
	collectionSlug: string,
	fields: string[],
): Promise<void> {
	const ftsTable = `_emdash_fts_${collectionSlug}`;
	const contentTable = `ec_${collectionSlug}`;
	const columnList = ["id UNINDEXED", "locale UNINDEXED", ...fields].join(", ");
	const fieldList = fields.join(", ");
	const newFieldList = fields.map((f) => `NEW.${f}`).join(", ");
	const oldFieldList = fields.map((f) => `OLD.${f}`).join(", ");

	await dropFtsObjects(db, collectionSlug);

	// `IF NOT EXISTS` on all CREATE statements so two isolates running
	// the migration concurrently (D1 has no advisory lock, so this can
	// happen on cold starts of a fresh deploy) don't fail each other
	// with "table already exists" / "trigger already exists" errors.
	// The drop-then-create sequence is benign across isolates: FTS5
	// silently dedupes duplicate-rowid INSERTs via the docsize shadow
	// table, so a double populate ends with one row per content row.
	await sql
		.raw(`
		CREATE VIRTUAL TABLE IF NOT EXISTS "${ftsTable}" USING fts5(
			${columnList},
			content='${contentTable}',
			content_rowid='rowid',
			tokenize='porter unicode61'
		)
	`)
		.execute(db);

	// Insert trigger -- only index non-deleted content.
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
		.execute(db);

	// Update trigger -- corruption-safe external-content `'delete'` form,
	// gated on OLD.deleted_at IS NULL so we never issue `'delete'` for a
	// rowid that was never indexed.
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
		.execute(db);

	// Delete trigger -- same corruption-safe form, same gate.
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
		.execute(db);

	// Populate from existing content (non-deleted rows only). Concurrent
	// re-population is safe -- FTS5 INSERT into an external-content table
	// dedupes by rowid; a second pass over the same content rows leaves
	// the index with one entry per row, matching what we'd get from a
	// single populate.
	await sql
		.raw(`
		INSERT INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
		SELECT rowid, id, locale, ${fieldList} FROM "${contentTable}"
		WHERE deleted_at IS NULL
	`)
		.execute(db);
}

async function dropFtsObjects(db: Kysely<unknown>, collectionSlug: string): Promise<void> {
	const ftsTable = `_emdash_fts_${collectionSlug}`;

	await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_insert"`).execute(db);
	await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_update"`).execute(db);
	await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_delete"`).execute(db);
	await sql.raw(`DROP TABLE IF EXISTS "${ftsTable}"`).execute(db);
}
