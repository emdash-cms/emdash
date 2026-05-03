/**
 * Regression test for SQLITE_CORRUPT_VTAB on publish.
 *
 * Reproduces the corruption pattern reported in the issue: create a content
 * item, publish it, edit and publish again. The FTS5 update trigger uses the
 * external-content-safe `'delete'` command, so the index stays consistent and
 * `pragma integrity_check` (which FTS5 hooks via `'integrity-check'`) does not
 * report a malformed disk image.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("FTS corruption on publish (SQLITE_CORRUPT_VTAB)", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;
	let ftsManager: FTSManager;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);
		ftsManager = new FTSManager(db);

		// Mirror the default `pages` collection: search enabled, title + content
		// (portableText, stored as JSON) both searchable.
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
			required: true,
			searchable: true,
		});
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
			searchable: true,
		});

		await ftsManager.enableSearch("pages");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("does not corrupt the FTS index when a published page is edited and re-published", async () => {
		const created = await repo.create({
			type: "pages",
			slug: "about",
			status: "draft",
			data: {
				title: "About",
				content: [
					{
						_type: "block",
						_key: "a",
						style: "normal",
						children: [{ _type: "span", _key: "s", text: "Initial about page body." }],
					},
				],
			},
		});

		// First publish — promotes draft into the live columns and fires the
		// update trigger on `ec_pages`. With the broken triggers from
		// pre-fix versions this is the operation that begins corrupting
		// the index.
		await repo.publish("pages", created.id);

		// Edit the content (this is what the `publish` API route does after
		// a draft is saved — it issues an UPDATE against `ec_pages`). The
		// previously broken AFTER UPDATE trigger then issues
		// `DELETE FROM fts WHERE rowid = OLD.rowid`, which reads NEW
		// column values out of the (already updated) content table and
		// corrupts the inverted index.
		await repo.update("pages", created.id, {
			data: {
				title: "About v2",
				content: [
					{
						_type: "block",
						_key: "a",
						style: "normal",
						children: [
							{
								_type: "span",
								_key: "s",
								text: "Revised body with different searchable terms.",
							},
						],
					},
				],
			},
		});

		// FTS5 exposes integrity-check as a special command. With the broken
		// triggers it throws SQLITE_CORRUPT_VTAB after the UPDATE above.
		// This assertion is the actual regression test for the reported bug.
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();

		// Republish — this is the call from the issue trace
		// (`Content publish error: ... SQLITE_CORRUPT_VTAB`). With the
		// broken triggers it throws on the first UPDATE inside `publish`.
		await expect(repo.publish("pages", created.id)).resolves.toBeDefined();

		// And one more integrity-check after the republish.
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();

		// FTS docsize must still match the content table (one non-deleted row).
		const docsize = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages_docsize"
		`.execute(db);
		expect(docsize.rows[0]?.count).toBe(1);
	});

	it("auto-repairs sites that have legacy unsafe triggers from a pre-fix version", async () => {
		// Recreate the broken trigger pattern that previously shipped (the
		// contentless-table sync form, applied to an external-content FTS5
		// table). This is what every site that ran a pre-fix EmDash version
		// has in `sqlite_master` today.
		await sql.raw(`DROP TRIGGER IF EXISTS "_emdash_fts_pages_update"`).execute(db);
		await sql.raw(`DROP TRIGGER IF EXISTS "_emdash_fts_pages_delete"`).execute(db);
		await sql
			.raw(`
			CREATE TRIGGER "_emdash_fts_pages_update"
			AFTER UPDATE ON "ec_pages"
			BEGIN
				DELETE FROM "_emdash_fts_pages" WHERE rowid = OLD.rowid;
				INSERT INTO "_emdash_fts_pages"(rowid, id, locale, title, content)
				SELECT NEW.rowid, NEW.id, NEW.locale, NEW.title, NEW.content
				WHERE NEW.deleted_at IS NULL;
			END
		`)
			.execute(db);
		await sql
			.raw(`
			CREATE TRIGGER "_emdash_fts_pages_delete"
			AFTER DELETE ON "ec_pages"
			BEGIN
				DELETE FROM "_emdash_fts_pages" WHERE rowid = OLD.rowid;
			END
		`)
			.execute(db);

		// `verifyAndRepairAll` should detect the legacy triggers and rebuild
		// the index, replacing them with the corruption-safe form.
		await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(1);

		// After repair, edit + publish must not corrupt the index.
		const created = await repo.create({
			type: "pages",
			slug: "post-repair",
			status: "draft",
			data: { title: "Hello", content: [] },
		});
		await repo.publish("pages", created.id);
		await repo.update("pages", created.id, { data: { title: "Hello v2" } });

		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();
	});

	it("survives the full trash lifecycle (soft-delete -> restore -> integrity-check)", async () => {
		// The INSERT trigger only indexes rows where `deleted_at IS NULL`, so
		// the UPDATE/DELETE triggers must gate `'delete'` on the same
		// condition. Without that gate, restoring a row from trash issues
		// `'delete'` for a rowid that's not in the FTS index, which raises
		// `SQLITE_CORRUPT_VTAB`. Reproduces the regression introduced
		// alongside the original fix.
		const created = await repo.create({
			type: "pages",
			slug: "trashable",
			status: "draft",
			data: {
				title: "Trashable",
				content: [
					{
						_type: "block",
						_key: "a",
						style: "normal",
						children: [{ _type: "span", _key: "s", text: "Body before trash." }],
					},
				],
			},
		});

		await repo.publish("pages", created.id);

		// Soft-delete -- this UPDATE moves OLD (in-index) -> NEW (deleted).
		await expect(repo.delete("pages", created.id)).resolves.toBe(true);
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();

		// Restore -- OLD has `deleted_at IS NOT NULL` (not in index), NEW
		// has `deleted_at IS NULL`. The UPDATE trigger must NOT issue
		// `'delete'` here.
		await expect(repo.restore("pages", created.id)).resolves.toBe(true);
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();

		// After restore the row should be back in the index.
		const docsizeAfterRestore = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages_docsize"
		`.execute(db);
		expect(docsizeAfterRestore.rows[0]?.count).toBe(1);

		// Edit after restore -- exercises the normal indexed-OLD path again.
		await repo.update("pages", created.id, {
			data: {
				title: "Restored and edited",
				content: [
					{
						_type: "block",
						_key: "a",
						style: "normal",
						children: [{ _type: "span", _key: "s", text: "Body after restore." }],
					},
				],
			},
		});
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();
	});

	it("survives permanent delete of a soft-deleted row without corrupting the index", async () => {
		// `permanentDelete` is a hard `DELETE FROM ec_pages WHERE id = ?`
		// applied to a row that's already soft-deleted (i.e. not in the FTS
		// index). The DELETE trigger must not issue `'delete'` for this
		// rowid -- otherwise SQLITE_CORRUPT_VTAB.
		const created = await repo.create({
			type: "pages",
			slug: "purgeable",
			status: "draft",
			data: {
				title: "Purgeable",
				content: [
					{
						_type: "block",
						_key: "a",
						style: "normal",
						children: [{ _type: "span", _key: "s", text: "Will be purged." }],
					},
				],
			},
		});
		await repo.publish("pages", created.id);
		await expect(repo.delete("pages", created.id)).resolves.toBe(true);

		// Permanent delete of a soft-deleted row.
		await expect(repo.permanentDelete("pages", created.id)).resolves.toBe(true);
		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();

		const docsize = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM "_emdash_fts_pages_docsize"
		`.execute(db);
		expect(docsize.rows[0]?.count).toBe(0);
	});

	it("survives editing a row while it's in the trash without corrupting the index", async () => {
		// An UPDATE on a row whose OLD.deleted_at is set should not issue
		// `'delete'` to the FTS index (the row was never indexed). The
		// regression hit any UPDATE on a soft-deleted row, including the
		// ones the API issues when restoring metadata.
		const created = await repo.create({
			type: "pages",
			slug: "edit-while-trashed",
			status: "draft",
			data: {
				title: "Trashed",
				content: [],
			},
		});
		await repo.publish("pages", created.id);
		await expect(repo.delete("pages", created.id)).resolves.toBe(true);

		// Update directly via SQL -- repo.update filters out deleted rows,
		// but other paths (admin tooling, migrations) can UPDATE in place.
		await sql`
			UPDATE ec_pages
			SET title = 'edited while trashed'
			WHERE id = ${created.id}
		`.execute(db);

		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();
	});

	it("survives many edit/publish cycles without corrupting the index", async () => {
		const created = await repo.create({
			type: "pages",
			slug: "stress",
			status: "draft",
			data: { title: "Stress", content: [] },
		});

		await repo.publish("pages", created.id);

		// Many cycles is what tends to surface FTS5 corruption -- a single
		// bad UPDATE leaves a small amount of garbage; repeated bad UPDATEs
		// compound it until SQLite refuses to read the segment.
		for (let i = 0; i < 25; i++) {
			await repo.update("pages", created.id, {
				data: {
					title: `Stress ${i}`,
					content: [
						{
							_type: "block",
							_key: `b${i}`,
							style: "normal",
							children: [
								{
									_type: "span",
									_key: `s${i}`,
									text: `Iteration ${i} unique-token-${i} alpha beta gamma`,
								},
							],
						},
					],
				},
			});
			await repo.publish("pages", created.id);
		}

		await expect(
			sql
				.raw(`INSERT INTO _emdash_fts_pages(_emdash_fts_pages) VALUES('integrity-check')`)
				.execute(db),
		).resolves.toBeDefined();
	});
});
