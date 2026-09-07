import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { up as up016 } from "../../src/database/migrations/016_api_tokens.js";
import { up as up036 } from "../../src/database/migrations/036_i18n_menus_and_taxonomies.js";
import {
	MIGRATION_COUNT,
	MIGRATION_NAMES,
	createMigrator,
	getExactMigrationStatus,
	runMigrations,
} from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { seedPreI18nSchema } from "../utils/pre-i18n-schema.js";
import { listColumns, listIndexes, listTables, resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
});

afterAll(async () => {
	await db.destroy();
});

describe("core migrations on D1", () => {
	it("applies every registered migration to an empty database", async () => {
		const { applied } = await runMigrations(db);

		expect(applied).toEqual([...MIGRATION_NAMES]);
		const status = await getExactMigrationStatus(db);
		expect(status.pending).toEqual([]);
		expect(status.unknownApplied).toEqual([]);
		expect(status.knownApplied).toHaveLength(MIGRATION_COUNT);
	});

	it("applies nothing on a second run", async () => {
		await runMigrations(db);

		const { applied } = await runMigrations(db);

		expect(applied).toEqual([]);
		const rows = await db.selectFrom("_emdash_migrations").selectAll().execute();
		expect(rows).toHaveLength(MIGRATION_COUNT);
	});
});

describe("retry after a partial run on D1", () => {
	// D1 auto-commits each DDL statement, so a run that dies partway leaves
	// the schema changed and the bookkeeping row missing. The next request
	// reruns the migration against its own output, and an unguarded CREATE
	// there fails on every boot from then on.
	async function migrateThrough(name: string): Promise<void> {
		const { error } = await createMigrator(db).migrateTo(name);
		if (error) throw error;
	}

	it("finishes 016 after a run that stopped after its first statement", async () => {
		await migrateThrough("015_indexes");
		await up016(db);
		await sql`DROP INDEX idx_api_tokens_user_id`.execute(db);
		await sql`DROP INDEX idx_api_tokens_token_hash`.execute(db);
		await sql`DROP TABLE _emdash_device_codes`.execute(db);
		await sql`DROP TABLE _emdash_oauth_tokens`.execute(db);

		const { applied } = await runMigrations(db);

		expect(applied).toEqual(MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf("016_api_tokens")));
		expect(await listTables(db)).toEqual(
			expect.arrayContaining([
				"_emdash_api_tokens",
				"_emdash_oauth_tokens",
				"_emdash_device_codes",
			]),
		);
		expect(await listIndexes(db, "_emdash_api_tokens")).toEqual([
			"idx_api_tokens_token_hash",
			"idx_api_tokens_user_id",
		]);
		expect((await getExactMigrationStatus(db)).pending).toEqual([]);
	});

	it("records 016 after a run that stopped before its bookkeeping row", async () => {
		await migrateThrough("015_indexes");
		await up016(db);

		const { applied } = await runMigrations(db);

		expect(applied[0]).toBe("016_api_tokens");
		expect((await getExactMigrationStatus(db)).pending).toEqual([]);
	});
});

describe("036 taxonomy rebuild on D1", () => {
	it("keeps content_taxonomies rows the FK cascade would take", async () => {
		// D1 enforces foreign keys and ignores `PRAGMA foreign_keys = OFF`,
		// so dropping `taxonomies` during the rebuild cascades into
		// `content_taxonomies` unless the FK is physically removed first.
		await seedPreI18nSchema(db);
		await sql`PRAGMA foreign_keys = OFF`.execute(db);
		const pragma = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
		expect(pragma.rows[0]?.foreign_keys).toBe(1);

		await sql`INSERT INTO taxonomies (id, name, slug, label) VALUES ('news', 'category', 'news', 'News')`.execute(
			db,
		);
		await sql`INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id) VALUES ('posts', 'p1', 'news')`.execute(
			db,
		);

		await up036(db);

		const rows = await sql<{ entry_id: string }>`
			SELECT entry_id FROM content_taxonomies
		`.execute(db);
		expect(rows.rows).toEqual([{ entry_id: "p1" }]);
	});

	it("keeps menu items the menus rebuild would cascade away", async () => {
		await seedPreI18nSchema(db);
		await sql`INSERT INTO _emdash_menus (id, name, label) VALUES ('main', 'main', 'Main')`.execute(
			db,
		);
		await sql`
			INSERT INTO _emdash_menu_items (id, menu_id, type, label)
			VALUES ('item-1', 'main', 'custom', 'Home')
		`.execute(db);

		await up036(db);

		const rows = await sql<{ id: string }>`SELECT id FROM _emdash_menu_items`.execute(db);
		expect(rows.rows).toEqual([{ id: "item-1" }]);
	});

	it("restores idx_content_taxonomies_term when a first run stopped after the drop", async () => {
		// A first run that committed the content_taxonomies rebuild and died
		// before the index recreate leaves the table with no FK and no index;
		// the retry finds nothing to strip and must still recreate the index.
		await seedPreI18nSchema(db);
		await sql`DROP TABLE content_taxonomies`.execute(db);
		await sql`
			CREATE TABLE content_taxonomies (
				collection TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				taxonomy_id TEXT NOT NULL,
				PRIMARY KEY (collection, entry_id, taxonomy_id)
			)
		`.execute(db);

		await up036(db);

		expect(await listIndexes(db, "content_taxonomies")).toContain("idx_content_taxonomies_term");
	});
});

describe("040 byline rebuild on D1", () => {
	it("renames the staged table back when 040 stopped between drop and rename", async () => {
		// 040 drops `_emdash_content_bylines` and renames the staged copy in
		// two auto-committed statements. When only the drop lands, a rerun
		// finds no FKs to strip and skips the rebuild, leaving the credits in
		// `_emdash_content_bylines_new`; 071 repairs that state.
		await runMigrations(db);
		await sql`
			INSERT INTO _emdash_content_bylines (collection_slug, content_id, byline_id, sort_order)
			VALUES ('posts', 'p1', 'b1', 0)
		`.execute(db);
		await sql`ALTER TABLE _emdash_content_bylines RENAME TO _emdash_content_bylines_new`.execute(
			db,
		);
		const trailing = MIGRATION_NAMES.slice(
			MIGRATION_NAMES.indexOf("071_restore_content_bylines_table"),
		);
		await db.deleteFrom("_emdash_migrations").where("name", "in", trailing).execute();

		await runMigrations(db);

		expect(await listTables(db)).toContain("_emdash_content_bylines");
		expect(await listTables(db)).not.toContain("_emdash_content_bylines_new");
		expect(await listIndexes(db, "_emdash_content_bylines")).toEqual([
			"idx_content_bylines_byline",
			"idx_content_bylines_content",
		]);
		const credits = await sql<{ content_id: string }>`
			SELECT content_id FROM _emdash_content_bylines
		`.execute(db);
		expect(credits.rows).toEqual([{ content_id: "p1" }]);
	});

	it("carries the i18n columns 040 adds to the bylines table", async () => {
		await runMigrations(db);

		const columns = await listColumns(db, "_emdash_bylines");
		expect(columns).toContain("locale");
		expect(columns).toContain("translation_group");
	});
});
