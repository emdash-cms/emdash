/**
 * A save carrying `_rev` must not overwrite a write that lands after its
 * `_rev` check.
 */

import { sql } from "kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	handleContentCreate,
	handleContentGet,
	handleContentSchedule,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	asInlineTransaction,
	describeEachDialect,
	setupForDialect,
	setupTestDatabase,
	teardownForDialect,
	teardownTestDatabase,
} from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

describe("handleContentUpdate _rev against an interleaved write", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "plain_posts", label: "Plain Posts", supports: [] });
		await registry.createField("plain_posts", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	/**
	 * Runs `write` inside the second `findByIdOrSlug` call, before that call
	 * reads the row. The first call is the read the runtime validates `_rev`
	 * against, so the write lands after the token check and before the read that
	 * guards the column update. The spy is removed before `write` runs so the
	 * interleaved save sees the real repository.
	 */
	function interleaveBeforeSecondRead(write: () => Promise<unknown>) {
		const original = ContentRepository.prototype.findByIdOrSlug;
		let calls = 0;
		const spy = vi
			.spyOn(ContentRepository.prototype, "findByIdOrSlug")
			.mockImplementation(async function (this: ContentRepository, ...args) {
				if (calls++ === 1) {
					spy.mockRestore();
					await write();
				}
				return original.apply(this, args as Parameters<typeof original>);
			});
	}

	it("returns CONFLICT instead of staging a draft over a write that landed after the _rev check", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live" },
			slug: "live",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		await runtime.handleContentPublish("posts", id);

		const read = await runtime.handleContentGet("posts", id);
		expect(read.success).toBe(true);
		const staleRev = read.data!._rev;

		const stage = ContentRepository.prototype.stageDraftRevision;
		const spy = vi
			.spyOn(ContentRepository.prototype, "stageDraftRevision")
			.mockImplementation(async function (this: ContentRepository, ...args) {
				spy.mockRestore();
				const other = await runtime.handleContentUpdate("posts", id, {
					data: { title: "Other writer" },
				});
				expect(other.success).toBe(true);
				return stage.apply(this, args);
			});

		const stale = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Stale writer" },
			_rev: staleRev,
		});

		expect(stale.success).toBe(false);
		expect(!stale.success && stale.error.code).toBe("CONFLICT");

		const after = await runtime.handleContentGet("posts", id);
		expect(after.data!.item.data.title).toBe("Other writer");
	});

	it("returns CONFLICT instead of staging a draft over a schedule that landed after the _rev check", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Draft" },
			slug: "draft",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		const staleRev = created.data!._rev;

		const stage = ContentRepository.prototype.stageDraftRevision;
		const spy = vi
			.spyOn(ContentRepository.prototype, "stageDraftRevision")
			.mockImplementation(async function (this: ContentRepository, ...args) {
				spy.mockRestore();
				// A second ahead, so updated_at moves even within the create's millisecond.
				const scheduled = await handleContentSchedule(
					db,
					"posts",
					id,
					"2099-01-01T00:00:00.000Z",
					new Date(Date.now() + 1000),
				);
				expect(scheduled.success).toBe(true);
				return stage.apply(this, args);
			});

		const stale = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Stale writer" },
			_rev: staleRev,
		});

		expect(stale.success).toBe(false);
		expect(!stale.success && stale.error.code).toBe("CONFLICT");

		const after = await runtime.handleContentGet("posts", id);
		expect(after.data!.item.status).toBe("scheduled");
		expect(after.data!.item.data.title).toBe("Draft");
	});

	it("saves a draft on an entry without updated_at", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Imported" },
			slug: "imported",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		await sql`UPDATE ec_posts SET updated_at = NULL WHERE id = ${id}`.execute(db);

		const saved = await runtime.handleContentUpdate("posts", id, { data: { title: "Edited" } });

		expect(saved.success).toBe(true);
		const after = await runtime.handleContentGet("posts", id);
		expect(after.data!.item.data.title).toBe("Edited");
	});

	it("returns CONFLICT instead of overwriting columns on a collection without revisions", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			data: { title: "Plain" },
			slug: "plain",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		const staleRev = created.data!._rev;

		interleaveBeforeSecondRead(async () => {
			const other = await runtime.handleContentUpdate("plain_posts", id, {
				data: { title: "Other writer" },
			});
			expect(other.success).toBe(true);
		});

		const stale = await runtime.handleContentUpdate("plain_posts", id, {
			data: { title: "Stale writer" },
			_rev: staleRev,
		});

		expect(stale.success).toBe(false);
		expect(!stale.success && stale.error.code).toBe("CONFLICT");

		const after = await runtime.handleContentGet("plain_posts", id);
		expect(after.data!.item.data.title).toBe("Other writer");
	});
});

describeEachDialect("a save racing another write made from the same _rev", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "notes", label: "Notes", supports: ["seo"] });
		await registry.createField("notes", { slug: "title", label: "Title", type: "string" });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
	});

	it.each([
		{
			name: "a save",
			write: (db: Kysely<Database>, id: string, rev?: string) =>
				handleContentUpdate(db, "notes", id, { data: { title: "First" }, _rev: rev }),
		},
		{
			name: "an SEO-only save",
			write: (db: Kysely<Database>, id: string, rev?: string) =>
				handleContentUpdate(db, "notes", id, { seo: { description: "First" }, _rev: rev }),
		},
		{
			name: "a schedule",
			// A second ahead, so updated_at moves even within the create's millisecond.
			write: (db: Kysely<Database>, id: string, rev?: string) =>
				handleContentSchedule(
					db,
					"notes",
					id,
					"2099-01-01T00:00:00.000Z",
					new Date(Date.now() + 1000),
					rev,
				),
		},
	])(
		"refuses the save when $name lands between its _rev check and its update",
		async ({ write }) => {
			// A SQLite transaction holds the only connection and would block the
			// interleaved write, so SQLite runs the saves inline, as D1 does.
			const db = dialect === "sqlite" ? asInlineTransaction(ctx.db) : ctx.db;
			const created = await handleContentCreate(db, "notes", { data: { title: "Start" } });
			if (!created.success) throw new Error(created.error.message);
			const id = created.data.item.id;
			const rev = created.data._rev;

			let first: Awaited<ReturnType<typeof write>> | undefined;
			let afterFirst: Awaited<ReturnType<typeof handleContentGet>> | undefined;
			const original = ContentRepository.prototype.update;
			const spy = vi
				.spyOn(ContentRepository.prototype, "update")
				.mockImplementation(async function (this: ContentRepository, ...args) {
					spy.mockRestore();
					first = await write(db, id, rev);
					afterFirst = await handleContentGet(ctx.db, "notes", id);
					return original.apply(this, args);
				});

			const second = await handleContentUpdate(db, "notes", id, {
				data: { title: "Second" },
				seo: { description: "Second" },
				_rev: rev,
			});

			expect(first?.success).toBe(true);
			expect(second).toMatchObject({ success: false, error: { code: "CONFLICT" } });
			expect(await handleContentGet(ctx.db, "notes", id)).toEqual(afterFirst);
		},
	);
});
