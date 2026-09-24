import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { normalizeDatetimeStorage } from "../../src/database/datetime-storage.js";
import { up as up016 } from "../../src/database/migrations/016_api_tokens.js";
import { up as up036 } from "../../src/database/migrations/036_i18n_menus_and_taxonomies.js";
import { up as up078 } from "../../src/database/migrations/078_menu_item_translation_groups.js";
import {
	MIGRATION_COUNT,
	MIGRATION_NAMES,
	createMigrator,
	getExactMigrationStatus,
	runMigrations,
} from "../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../src/database/repositories/options.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { seedPreI18nSchema } from "../utils/pre-i18n-schema.js";
import {
	listColumns,
	listIndexes,
	listTables,
	resetD1Schema,
	seedLegacyCollection,
} from "./d1-schema.js";

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

async function migrateThrough(name: string): Promise<void> {
	const { error } = await createMigrator(db).migrateTo(name);
	if (error) throw error;
}

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

	it("normalizes legacy content and revision datetimes", async () => {
		await runMigrations(db);
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "events", label: "Events" });
		await registry.createField("events", {
			slug: "starts_at",
			label: "Starts at",
			type: "datetime",
		});
		await new OptionsRepository(db).set("site:timezone", "Asia/Tokyo");
		await sql`
			INSERT INTO ec_events (
				id, slug, status, created_at, updated_at, version, locale, translation_group, starts_at
			) VALUES (
				'event-1', 'event-1', 'draft', '2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z', 1, 'en', 'event-1', '2026-08-22T01:00'
			)
		`.execute(db);
		await db
			.insertInto("revisions")
			.values({
				id: "revision-1",
				collection: "events",
				entry_id: "event-1",
				data: JSON.stringify({ starts_at: "2026-08-22T01:00" }),
				author_id: null,
				created_at: "2026-01-01T00:00:00.000Z",
			})
			.execute();

		await normalizeDatetimeStorage(db);

		const content = await sql<{ starts_at: string }>`
			SELECT starts_at FROM ec_events WHERE id = 'event-1'
		`.execute(db);
		expect(content.rows[0]?.starts_at).toBe("2026-08-21T16:00:00.000Z");
		const revision = await db
			.selectFrom("revisions")
			.select("data")
			.where("id", "=", "revision-1")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(revision.data)).toEqual({ starts_at: "2026-08-21T16:00:00.000Z" });
	});
});

describe("retry after a partial run on D1", () => {
	// D1 auto-commits each DDL statement, so a run that dies partway leaves
	// the schema changed and the bookkeeping row missing. The next request
	// reruns the migration against its own output, and an unguarded CREATE
	// there fails on every boot from then on.

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

describe("078 menu item translation groups on D1", () => {
	it("backfills only null translation groups and can be replayed", async () => {
		await runMigrations(db);
		await sql`
			INSERT INTO _emdash_menu_items (
				id, menu_id, sort_order, type, custom_url, label, translation_group
			) VALUES
				('legacy-null', 'main', 0, 'custom', '/', 'Home', NULL),
				('translated-item', 'main', 1, 'custom', '/about', 'About', 'shared-about')
		`.execute(db);

		await up078(db);
		await up078(db);

		const rows = await sql<{ id: string; translation_group: string }>`
			SELECT id, translation_group
			FROM _emdash_menu_items
			ORDER BY sort_order
		`.execute(db);
		expect(rows.rows).toEqual([
			{ id: "legacy-null", translation_group: "legacy-null" },
			{ id: "translated-item", translation_group: "shared-about" },
		]);
	});
});

describe("replay idempotence on D1", () => {
	// Migrations after this one guard their DDL against a replay; most up to it
	// do not, so the replay below starts past it.
	const LAST_UNGUARDED_MIGRATION = "032_rate_limits";

	// A migration that iterates `ec_*` tables is inert on an empty database.
	async function seedCollectionAfterRegistry(): Promise<string[]> {
		await migrateThrough("003_schema_registry");
		await seedLegacyCollection(db);
		return MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf("003_schema_registry") + 1);
	}

	it("applies every migration to a database that already holds a collection", async () => {
		const remaining = await seedCollectionAfterRegistry();

		const { applied } = await runMigrations(db);

		expect(applied).toEqual(remaining);
		expect((await getExactMigrationStatus(db)).pending).toEqual([]);
	});

	it("replays every migration written since the guarded-DDL pattern", async () => {
		const remaining = await seedCollectionAfterRegistry();
		const migrations = new Map(
			(await createMigrator(db).getMigrations()).map((info) => [info.name, info.migration]),
		);
		const guarded = new Set(
			MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf(LAST_UNGUARDED_MIGRATION) + 1),
		);
		const failed: string[] = [];

		for (const name of remaining) {
			await migrateThrough(name);
			if (!guarded.has(name)) continue;
			const migration = migrations.get(name);
			if (!migration) throw new Error(`no migration is registered as ${name}`);
			try {
				await migration.up(db);
			} catch (error) {
				failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		expect(failed).toEqual([]);
	});
});
