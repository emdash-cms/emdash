/**
 * FTS triggers only re-tokenize when an indexed value actually changed.
 *
 * The update trigger fires on ANY row UPDATE. Without a WHEN guard it
 * rewrites the document's index entry even when no searchable column
 * changed — metadata-only saves (status flips, scheduling, version bumps)
 * re-tokenize the full document, dominating save CPU and WAL volume. The
 * FTS `_data` shadow table holds the index segments, so a byte-identical
 * dump across a metadata-only update proves no re-tokenization happened.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("FTS write amplification", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;
	let entryId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);

		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts", "revisions", "search"],
		});
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
			searchable: true,
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
			data: {
				title: "Opening Night",
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
		entryId = created.id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	/** Byte-level dump of the FTS index segments. */
	async function indexSegments(): Promise<string[]> {
		const rows = await sql<{ id: number; block: string }>`
			SELECT id, quote(block) as block FROM "_emdash_fts_pages_data" ORDER BY id
		`.execute(db);
		return rows.rows.map((r) => `${r.id}:${r.block}`);
	}

	it("does not re-tokenize on a metadata-only update", async () => {
		const before = await indexSegments();

		await sql`
			UPDATE ec_pages SET scheduled_at = '2027-01-01T00:00:00.000Z', version = version + 1
			WHERE id = ${entryId}
		`.execute(db);

		expect(await indexSegments()).toEqual(before);
	});

	it("does not re-tokenize when publish rewrites identical data values", async () => {
		const before = await indexSegments();

		// publish() SETs every data column from the revision even when the
		// values are unchanged; only value comparison suppresses those
		// re-tokenizations.
		await repo.publish("pages", entryId);

		expect(await indexSegments()).toEqual(before);
	});

	it("still re-indexes when a searchable field changes", async () => {
		await repo.update("pages", entryId, {
			data: { title: "Closing Night", content: null },
		});

		const { items } = await searchWithDb(db, "closing", { collections: ["pages"] });
		expect(items).toHaveLength(1);
		const stale = await searchWithDb(db, "opening", { collections: ["pages"] });
		expect(stale.items).toEqual([]);
	});

	it("still removes trashed entries from the index and restores them", async () => {
		await sql`UPDATE ec_pages SET deleted_at = datetime('now') WHERE id = ${entryId}`.execute(db);
		expect((await searchWithDb(db, "haunted", { collections: ["pages"] })).items).toEqual([]);

		await sql`UPDATE ec_pages SET deleted_at = NULL WHERE id = ${entryId}`.execute(db);
		expect((await searchWithDb(db, "haunted", { collections: ["pages"] })).items).toHaveLength(1);
	});
});
