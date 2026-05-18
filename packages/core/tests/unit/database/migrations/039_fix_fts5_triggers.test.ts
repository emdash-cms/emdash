import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { Database } from "../../../../src/database/types.js";
import { SchemaRegistry } from "../../../../src/schema/registry.js";
import { FTSManager } from "../../../../src/search/fts-manager.js";
import { setupTestDatabase, teardownTestDatabase } from "../../../utils/test-db.js";

/**
 * Migration 039 rebuilds every FTS5 index with corruption-safe triggers.
 *
 * The "happy path" cases (fresh install with the fixed triggers in place)
 * are covered by `tests/integration/search/fts-corruption.test.ts`. These
 * tests exercise the migration directly against pre-fix state — the case
 * a real upgrade hits.
 */

describe("migration 039: rebuild FTS5 triggers", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	/**
	 * Replace the FTS update + delete triggers on a collection with the
	 * broken pre-fix form so we can verify migration 039 fixes them.
	 *
	 * Mirrors exactly what `sqlite_master` looked like on every site that
	 * ran a pre-fix EmDash version: the contentless-table sync pattern
	 * (`DELETE FROM "<fts>" WHERE rowid = OLD.rowid`) installed on what is
	 * actually an external-content FTS5 table.
	 */
	async function installPreFixTriggers(collectionSlug: string, fields: string[]): Promise<void> {
		const ftsTable = `_emdash_fts_${collectionSlug}`;
		const contentTable = `ec_${collectionSlug}`;
		const fieldList = fields.join(", ");
		const newFieldList = fields.map((f) => `NEW.${f}`).join(", ");

		await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_update"`).execute(db);
		await sql.raw(`DROP TRIGGER IF EXISTS "${ftsTable}_delete"`).execute(db);

		await sql
			.raw(`
			CREATE TRIGGER "${ftsTable}_update"
			AFTER UPDATE ON "${contentTable}"
			BEGIN
				DELETE FROM "${ftsTable}" WHERE rowid = OLD.rowid;
				INSERT INTO "${ftsTable}"(rowid, id, locale, ${fieldList})
				SELECT NEW.rowid, NEW.id, NEW.locale, ${newFieldList}
				WHERE NEW.deleted_at IS NULL;
			END
		`)
			.execute(db);

		await sql
			.raw(`
			CREATE TRIGGER "${ftsTable}_delete"
			AFTER DELETE ON "${contentTable}"
			BEGIN
				DELETE FROM "${ftsTable}" WHERE rowid = OLD.rowid;
			END
		`)
			.execute(db);
	}

	async function setupSearchEnabledPages(): Promise<void> {
		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts", "revisions", "search"],
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await registry.createField("pages", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});

		const fts = new FTSManager(db);
		await fts.enableSearch("pages");
	}

	async function runMigration039(): Promise<void> {
		const { up } = await import("../../../../src/database/migrations/039_fix_fts5_triggers.js");
		await up(db as unknown as Kysely<unknown>);
	}

	/**
	 * Count FTS5 matches for a single term. We use raw SQL (rather than
	 * `searchWithDb`) because the corruption test inspects the inverted
	 * index directly to prove stale tokens are gone after migration.
	 */
	async function fts5Matches(
		conn: Kysely<Database>,
		ftsTable: string,
		term: string,
	): Promise<number> {
		const result = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM ${sql.ref(ftsTable)}
			WHERE ${sql.ref(ftsTable)} MATCH ${term}
		`.execute(conn);
		return Number(result.rows[0]?.count ?? 0);
	}

	it("is a no-op on databases with no search-enabled collections", async () => {
		// Empty DB — just the system tables, no `_emdash_collections` rows
		// with a `search_config`. Migration must not throw.
		await expect(runMigration039()).resolves.toBeUndefined();
	});

	it("rebuilds the FTS index for every search-enabled collection", async () => {
		await setupSearchEnabledPages();

		const created = await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			publishedAt: new Date().toISOString(),
			data: { title: "About", body: "Some searchable body text." },
		});

		// Simulate the pre-fix state: broken triggers + a published row.
		// The legacy triggers are functional on INSERT (the contentless and
		// external-content forms agree there), so the row is in the index
		// at this point. The migration must replace the triggers without
		// losing that row.
		await installPreFixTriggers("pages", ["title", "body"]);

		await runMigration039();

		// New triggers in place (no `DELETE FROM "<fts>" WHERE rowid = OLD.rowid`).
		const triggers = await sql<{ name: string; sql: string }>`
			SELECT name, sql FROM sqlite_master
			WHERE type = 'trigger' AND tbl_name = 'ec_pages'
		`.execute(db);
		for (const trigger of triggers.rows) {
			expect(trigger.sql).not.toMatch(/DELETE\s+FROM\s+"_emdash_fts_pages"\s+WHERE\s+rowid/i);
		}
		// The new triggers use the `'delete'` command.
		const updateTrigger = triggers.rows.find((r) => r.name === "_emdash_fts_pages_update");
		expect(updateTrigger?.sql).toMatch(/'delete'/);

		// Content row is still in the index after rebuild.
		const docsize = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages_docsize"
		`.execute(db);
		expect(docsize.rows[0]?.count).toBe(1);

		// And an edit + publish on the rebuilt index does not corrupt it
		// (the regression PR #768 was originally trying to fix).
		await repo.update("pages", created.id, {
			data: { title: "About v2", body: "Revised body." },
		});
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();
	});

	it("repairs a database whose FTS index is already corrupted from earlier mutations", async () => {
		await setupSearchEnabledPages();

		const created = await repo.create({
			type: "pages",
			slug: "corrupt-me",
			status: "published",
			publishedAt: new Date().toISOString(),
			data: { title: "Corrupt me", body: "Original aardvark body." },
		});

		// Install the broken triggers and then *fire them* by issuing the
		// kind of UPDATE the publish path does. The broken trigger's
		// `DELETE FROM fts WHERE rowid = OLD.rowid` on an external-content
		// table reads NEW values from the content table when removing
		// tokens, so the OLD tokens are left behind in the inverted index
		// even though the content table no longer holds them. The result
		// is a stale-token leak: searches for words from the OLD body
		// keep matching the (now updated) row, and segment metadata
		// drifts out of sync until SQLite eventually surfaces it as
		// SQLITE_CORRUPT_VTAB.
		await installPreFixTriggers("pages", ["title", "body"]);

		// Sanity check: the OLD content's unique token is indexed before
		// the corrupting UPDATE.
		const preUpdateOldTokenMatches = await fts5Matches(db, "_emdash_fts_pages", "aardvark");
		expect(preUpdateOldTokenMatches).toBe(1);

		try {
			await sql`
				UPDATE ec_pages SET title = 'Updated', body = 'Updated zebra body.' WHERE id = ${created.id}
			`.execute(db);
		} catch {
			// Expected on some SQLite builds -- the corruption surfaces immediately.
		}

		// After the broken UPDATE on an external-content table, the OLD
		// token ("aardvark", no longer present in the row) is still in
		// the inverted index. This is the stale-token leak the migration
		// must fix; assert it exists before running the migration so the
		// post-migration assertion has teeth.
		const postUpdateOldTokenMatches = await fts5Matches(db, "_emdash_fts_pages", "aardvark");
		expect(postUpdateOldTokenMatches).toBe(1);

		// Run the migration. This must succeed regardless of the corrupt state.
		await runMigration039();

		// After the migration the index is consistent: stale OLD token is
		// gone, NEW token from the current row is present.
		const repairedOldTokenMatches = await fts5Matches(db, "_emdash_fts_pages", "aardvark");
		expect(repairedOldTokenMatches).toBe(0);
		const repairedNewTokenMatches = await fts5Matches(db, "_emdash_fts_pages", "zebra");
		expect(repairedNewTokenMatches).toBe(1);

		// And the index itself is structurally clean.
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();

		const docsize = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages_docsize"
		`.execute(db);
		expect(docsize.rows[0]?.count).toBe(1);
	});

	it("disables FTS cleanly when search_config.enabled is true but no fields are searchable", async () => {
		// Edge case: search was enabled, then every searchable field was
		// later unmarked, leaving an FTS table with no columns to index.
		// The migration should drop the FTS table and flip search_config
		// to enabled=false instead of recreating a useless index.
		await registry.createCollection({
			slug: "items",
			label: "Items",
			labelSingular: "Item",
			supports: ["search"],
		});
		await registry.createField("items", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});

		const fts = new FTSManager(db);
		await fts.enableSearch("items");

		// Now unmark the field as searchable directly in the DB so the
		// rebuild path is exercised with `searchableFields.length === 0`.
		await sql`
			UPDATE _emdash_fields SET searchable = 0
			WHERE collection_id = (SELECT id FROM _emdash_collections WHERE slug = 'items')
		`.execute(db);

		await runMigration039();

		const ftsTableExists = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM sqlite_master
			WHERE type = 'table' AND name = '_emdash_fts_items'
		`.execute(db);
		expect(ftsTableExists.rows[0]?.count).toBe(0);

		const config = await sql<{ search_config: string | null }>`
			SELECT search_config FROM _emdash_collections WHERE slug = 'items'
		`.execute(db);
		const parsed = JSON.parse(config.rows[0]?.search_config ?? "{}");
		expect(parsed.enabled).toBe(false);
	});

	it("ignores collections whose search_config has enabled=false", async () => {
		await registry.createCollection({
			slug: "drafts",
			label: "Drafts",
			labelSingular: "Draft",
			supports: ["search"],
		});
		await registry.createField("drafts", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});

		// Explicitly disabled (the normal state for collections that
		// declare `supports: ['search']` but the operator never flipped
		// on). The migration should not touch them.
		await sql`
			UPDATE _emdash_collections SET search_config = '{"enabled":false}'
			WHERE slug = 'drafts'
		`.execute(db);

		await expect(runMigration039()).resolves.toBeUndefined();
	});

	it("is safe to re-run", async () => {
		await setupSearchEnabledPages();
		await repo.create({
			type: "pages",
			slug: "idempotent",
			status: "published",
			publishedAt: new Date().toISOString(),
			data: { title: "Idempotent", body: "Body." },
		});

		await runMigration039();
		await runMigration039();
		await runMigration039();

		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();

		const docsize = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages_docsize"
		`.execute(db);
		expect(docsize.rows[0]?.count).toBe(1);
	});
});
