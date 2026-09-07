/**
 * Migration 064 rebuilds FTS indexes as self-contained tables indexing
 * extracted Portable Text prose. These tests exercise the migration against
 * the pre-fix state a real upgrade hits: an external-content FTS table whose
 * index holds raw Portable Text JSON, so structural tokens ("normal",
 * "span") match documents whose prose never contains them.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { Database } from "../../../../src/database/types.js";
import { SchemaRegistry } from "../../../../src/schema/registry.js";
import { FTSManager } from "../../../../src/search/fts-manager.js";
import { setupTestDatabase, teardownTestDatabase } from "../../../utils/test-db.js";

describe("migration 064: FTS indexes extracted Portable Text prose", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);

		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			supports: ["search"],
		});
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
			searchable: true,
		});
		await new FTSManager(db).enableSearch("pages");

		await repo.create({
			type: "pages",
			slug: "haunted",
			status: "published",
			data: {
				content: [
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						children: [{ _type: "span", _key: "s1", text: "The haunted cinema." }],
					},
				],
			},
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	/**
	 * Rebuild the pages FTS table in the pre-064 shape: external-content
	 * FTS5 indexing the raw column values (Portable Text JSON included).
	 */
	async function installPreFixFts(tokenizer = "porter unicode61"): Promise<void> {
		await sql.raw(`DROP TRIGGER IF EXISTS "_emdash_fts_pages_insert"`).execute(db);
		await sql.raw(`DROP TRIGGER IF EXISTS "_emdash_fts_pages_update"`).execute(db);
		await sql.raw(`DROP TRIGGER IF EXISTS "_emdash_fts_pages_delete"`).execute(db);
		await sql.raw(`DROP TABLE IF EXISTS "_emdash_fts_pages"`).execute(db);
		await sql
			.raw(`
			CREATE VIRTUAL TABLE "_emdash_fts_pages" USING fts5(
				id UNINDEXED, locale UNINDEXED, content,
				content='ec_pages',
				content_rowid='rowid',
				tokenize='${tokenizer}'
			)
		`)
			.execute(db);
		await sql
			.raw(`
			INSERT INTO "_emdash_fts_pages"(rowid, id, locale, content)
			SELECT rowid, id, locale, content FROM "ec_pages"
			WHERE deleted_at IS NULL
		`)
			.execute(db);
	}

	async function matches(term: string): Promise<number> {
		const result = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages"
			WHERE "_emdash_fts_pages" MATCH ${term}
		`.execute(db);
		return Number(result.rows[0]?.count ?? 0);
	}

	/** Byte-level dump of the FTS index segments; identical dumps prove no re-tokenization. */
	async function segments(): Promise<string[]> {
		const result = await sql<{ id: number; block: string }>`
			SELECT id, quote(block) as block FROM "_emdash_fts_pages_data" ORDER BY id
		`.execute(db);
		return result.rows.map((r) => `${r.id}:${r.block}`);
	}

	async function runMigration064(): Promise<void> {
		const { up } = await import("../../../../src/database/migrations/064_fts_plain_text.js");
		await up(db as unknown as Kysely<unknown>);
	}

	it("replaces the JSON-polluted index with extracted prose", async () => {
		await installPreFixFts();

		// Pre-migration: structural tokens match — the pollution being fixed.
		expect(await matches("normal")).toBe(1);
		expect(await matches("span")).toBe(1);

		await runMigration064();

		expect(await matches("normal")).toBe(0);
		expect(await matches("span")).toBe(0);
		expect(await matches("haunted")).toBe(1);
	});

	it("installs working sync triggers alongside the rebuilt index", async () => {
		await installPreFixFts();
		await runMigration064();

		const rows = await sql<{ id: string }>`SELECT id FROM ec_pages`.execute(db);
		await repo.update("pages", rows.rows[0]!.id, {
			data: {
				content: [
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						children: [{ _type: "span", _key: "s1", text: "A midnight screening." }],
					},
				],
			},
		});

		expect(await matches("midnight")).toBe(1);
		expect(await matches("haunted")).toBe(0);
		expect(await matches("normal")).toBe(0);
	});

	it("installs the update-trigger WHEN guard alongside the rebuild", async () => {
		await installPreFixFts();
		await runMigration064();

		const before = await segments();
		await sql`
			UPDATE ec_pages SET updated_at = datetime('now', '+1 hour') WHERE slug = 'haunted'
		`.execute(db);
		expect(await segments()).toEqual(before);
	});

	it("keeps legacy scalar values searchable across the rebuild", async () => {
		await repo.create({
			type: "pages",
			slug: "legacy-scalar",
			status: "published",
			data: { content: null },
		});
		await sql`UPDATE ec_pages SET content = '2024' WHERE slug = 'legacy-scalar'`.execute(db);
		await installPreFixFts();
		expect(await matches("2024")).toBe(1);

		await runMigration064();

		expect(await matches("2024")).toBe(1);
	});

	it("honors a configured non-default tokenizer when rebuilding", async () => {
		await new FTSManager(db).enableSearch("pages", { tokenize: "trigram" });
		await installPreFixFts("trigram");

		await runMigration064();

		// trigram matches substrings; porter unicode61 would not match "aunted".
		expect(await matches("aunted")).toBe(1);
		expect(await matches("normal")).toBe(0);
	});

	it("is a no-op on databases with no search-enabled collections", async () => {
		await new FTSManager(db).disableSearch("pages");
		await expect(runMigration064()).resolves.toBeUndefined();
	});
});
