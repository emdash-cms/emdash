/**
 * Migration 057 recreates FTS sync triggers with change-detection WHEN
 * guards. These tests exercise the upgrade path: a database whose update
 * trigger fires on any UPDATE gets guarded triggers, without touching the
 * index contents.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { Database } from "../../../../src/database/types.js";
import { SchemaRegistry } from "../../../../src/schema/registry.js";
import { FTSManager } from "../../../../src/search/fts-manager.js";
import { setupTestDatabase, teardownTestDatabase } from "../../../utils/test-db.js";

describe("migration 057: FTS trigger WHEN guards", () => {
	let db: Kysely<Database>;
	let entryId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		const repo = new ContentRepository(db);

		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			supports: ["search"],
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await new FTSManager(db).enableSearch("pages");

		const created = await repo.create({
			type: "pages",
			slug: "haunted",
			status: "published",
			data: { title: "The haunted cinema" },
		});
		entryId = created.id;

		// Pre-057 state: the update trigger fires on ANY row UPDATE.
		await sql.raw(`DROP TRIGGER IF EXISTS "_emdash_fts_pages_update"`).execute(db);
		await sql
			.raw(`
			CREATE TRIGGER "_emdash_fts_pages_update"
			AFTER UPDATE ON "ec_pages"
			BEGIN
				DELETE FROM "_emdash_fts_pages" WHERE rowid = OLD.rowid;
				INSERT INTO "_emdash_fts_pages"(rowid, id, locale, title)
				SELECT NEW.rowid, NEW.id, NEW.locale, NEW.title
				WHERE NEW.deleted_at IS NULL;
			END
		`)
			.execute(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function indexSegments(): Promise<string[]> {
		const rows = await sql<{ id: number; block: string }>`
			SELECT id, quote(block) as block FROM "_emdash_fts_pages_data" ORDER BY id
		`.execute(db);
		return rows.rows.map((r) => `${r.id}:${r.block}`);
	}

	async function metadataOnlyUpdate(): Promise<void> {
		await sql`
			UPDATE ec_pages SET version = version + 1 WHERE id = ${entryId}
		`.execute(db);
	}

	async function runMigration057(): Promise<void> {
		const { up } =
			await import("../../../../src/database/migrations/057_fts_trigger_when_guards.js");
		await up(db as unknown as Kysely<unknown>);
	}

	it("stops metadata-only updates from re-tokenizing", async () => {
		// Baseline with teeth: the pre-057 trigger rewrites index segments
		// on a metadata-only update.
		const before = await indexSegments();
		await metadataOnlyUpdate();
		expect(await indexSegments()).not.toEqual(before);

		await runMigration057();

		const guarded = await indexSegments();
		await metadataOnlyUpdate();
		expect(await indexSegments()).toEqual(guarded);
	});

	it("still syncs the index when a searchable field changes", async () => {
		await runMigration057();

		await sql`
			UPDATE ec_pages SET title = 'A midnight screening' WHERE id = ${entryId}
		`.execute(db);

		const matches = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages"
			WHERE "_emdash_fts_pages" MATCH 'midnight'
		`.execute(db);
		expect(Number(matches.rows[0]?.count)).toBe(1);
	});
});
