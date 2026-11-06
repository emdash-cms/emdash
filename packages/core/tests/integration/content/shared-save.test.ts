import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveContent, type ContentSaveSite } from "../../../src/api/content-save.js";
import { PUT as updateContent } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EntryLockRepository } from "../../../src/database/repositories/entry-locks.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = { id: "user_editor", role: Role.EDITOR as RoleLevel };
const AUTHOR = { id: "user_author", role: Role.AUTHOR as RoleLevel };
const CONTRIBUTOR = { id: "user_contributor", role: Role.CONTRIBUTOR as RoleLevel };

describeEachDialect("shared content save", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await ctx.db
			.insertInto("users")
			.values(
				[EDITOR, AUTHOR, CONTRIBUTOR].map((user) => ({
					id: user.id,
					email: `${user.id}@example.com`,
					name: user.id,
					role: user.role,
					email_verified: 1,
				})),
			)
			.execute();
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "starts_at", label: "Starts", type: "datetime" });
		await registry.createCollection({ slug: "note", label: "Notes", supports: [] });
		await registry.createField("note", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createEntry(
		collection = "post",
		options: { authorId?: string; status?: string } = {},
	): Promise<string> {
		const item = await new ContentRepository(ctx.db).create({
			type: collection,
			data: { title: "Original" },
			slug: `entry-${Math.random().toString(36).slice(2, 8)}`,
			status: options.status ?? "draft",
			authorId: options.authorId ?? AUTHOR.id,
		});
		return item.id;
	}

	async function read(collection: string, id: string) {
		const result = await runtime.handleContentGet(collection, id, undefined, undefined, {
			includeStagedSlug: true,
		});
		if (!result.success) throw new Error(result.error.message);
		return result.data;
	}

	async function revisionCount(id: string): Promise<number> {
		const rows = await ctx.db
			.selectFrom("revisions")
			.select("id")
			.where("entry_id", "=", id)
			.execute();
		return rows.length;
	}

	describe("own write", () => {
		it("returns the draft save's own _rev and stored values", async () => {
			const id = await createEntry();

			const result = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				body: {
					data: { title: "Edited", starts_at: "2026-11-04T10:00:00+02:00" },
					slug: "renamed",
				},
			});

			expect(result.success).toBe(true);
			const fresh = await read("post", id);
			expect(result.saved).toEqual({
				rev: fresh._rev,
				data: fresh.item.data,
				slug: fresh.item.slug,
			});
			expect(result.saved?.slug).toBe("renamed");
			expect(result.saved?.data.starts_at).toBe("2026-11-04T08:00:00.000Z");
		});

		it("returns the live slug when no slug is staged, for a save that passes editedBy", async () => {
			const id = await createEntry();
			const first = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				body: { data: { title: "First" } },
			});
			expect(first.success).toBe(true);

			const second = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				editedBy: [EDITOR.id, AUTHOR.id],
				body: { data: { title: "Second" }, skipRevision: true, _rev: first.saved?.rev },
			});

			expect(second.success).toBe(true);
			const fresh = await read("post", id);
			expect(second.saved).toEqual({
				rev: fresh._rev,
				data: fresh.item.data,
				slug: fresh.item.slug,
			});
			expect(second.saved?.data.title).toBe("Second");
			const draft = await ctx.db
				.selectFrom("revisions")
				.select("edited_by")
				.where("id", "=", fresh.item.draftRevisionId!)
				.executeTakeFirstOrThrow();
			expect(JSON.parse(draft.edited_by!)).toEqual([EDITOR.id, AUTHOR.id]);
		});

		it("returns the live values the draft doesn't hold, as a fresh read does", async () => {
			await new SchemaRegistry(ctx.db).createField("post", {
				slug: "summary",
				label: "Summary",
				type: "string",
			});
			const repo = new ContentRepository(ctx.db);
			const item = await repo.create({
				type: "post",
				data: { title: "Original", summary: "Live summary" },
				slug: "with-summary",
				authorId: AUTHOR.id,
			});
			const draft = await new RevisionRepository(ctx.db).create({
				collection: "post",
				entryId: item.id,
				data: { title: "Draft without the summary" },
			});
			await repo.setDraftRevision("post", item.id, draft.id);

			const result = await saveContent(runtime, {
				collection: "post",
				id: item.id,
				user: EDITOR,
				body: { data: { title: "Edited" } },
			});

			expect(result.success).toBe(true);
			expect(result.saved?.data).toEqual((await read("post", item.id)).item.data);
			expect(result.saved?.data).toMatchObject({ title: "Edited", summary: "Live summary" });
		});

		it("returns its own write's _rev when the entry is scheduled during the save", async () => {
			const id = await createEntry();
			const originalCreate = RevisionRepository.prototype.create;
			const create = vi
				.spyOn(RevisionRepository.prototype, "create")
				.mockImplementationOnce(async function (input) {
					const revision = await originalCreate.call(this, input);
					// Scheduling moves updated_at but leaves version and the draft pointer alone, so
					// the staging write still lands after it.
					await new ContentRepository(ctx.db).schedule(
						"post",
						id,
						"2099-01-01T00:00:00.000Z",
						new Date(Date.now() + 60_000),
					);
					return revision;
				});

			const first = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				body: { data: { title: "First" } },
			});
			create.mockRestore();

			expect(first.success).toBe(true);
			const fresh = await read("post", id);
			expect(fresh.item.status).toBe("scheduled");
			expect(first.saved?.rev).toBe(fresh._rev);

			const second = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				body: { data: { title: "Second" }, _rev: first.saved?.rev },
			});

			expect(second.success).toBe(true);
			expect(second.saved?.rev).toBe((await read("post", id))._rev);
		});

		it("returns no own write for a save that writes live metadata", async () => {
			const id = await createEntry();

			const result = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				body: { data: { title: "Edited" }, publishedAt: "2026-01-01T00:00:00.000Z" },
			});

			expect(result.success).toBe(true);
			expect(result.liveContentChanged).toBe(true);
			expect(result.saved).toBeUndefined();
		});

		it("returns no own write on a collection without revisions", async () => {
			const id = await createEntry("note");

			const result = await saveContent(runtime, {
				collection: "note",
				id,
				user: EDITOR,
				body: { data: { title: "Edited" } },
			});

			expect(result.success).toBe(true);
			expect((await read("note", id)).item.data.title).toBe("Edited");
			expect(result.saved).toBeUndefined();
		});
	});

	describe("site-write fence", () => {
		it("refuses a fenced save during a site import and writes nothing", async () => {
			const id = await createEntry();
			const before = await read("post", id);
			const revisionsBefore = await revisionCount(id);
			const { operation } = await new TransferOperationRepository(ctx.db).create({
				kind: "import",
				createdBy: EDITOR.id,
			});
			await ctx.db
				.updateTable("_emdash_transfer_operations")
				.set({ state: "running", mutation_started_at: "2026-01-01T00:00:00.000Z" })
				.where("id", "=", operation.id)
				.execute();

			const result = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				fence: true,
				body: { data: { title: "Blocked" } },
			});

			expect(result).toEqual({
				success: false,
				error: {
					code: "TRANSFER_IMPORT_IN_PROGRESS",
					message: "A site import is in progress or incomplete; writes are disabled",
				},
			});
			expect(await read("post", id)).toEqual(before);
			expect(await revisionCount(id)).toBe(revisionsBefore);
		});

		it("records a fenced save for a running export once it succeeds", async () => {
			const id = await createEntry();
			const transfers = new TransferOperationRepository(ctx.db);
			const { operation } = await transfers.create({ kind: "export", createdBy: EDITOR.id });
			await ctx.db
				.updateTable("_emdash_transfer_operations")
				.set({ state: "running" })
				.where("id", "=", operation.id)
				.execute();
			const stale = (await read("post", id))._rev;
			const first = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				fence: true,
				body: { data: { title: "First" } },
			});
			expect(first.success).toBe(true);
			expect((await transfers.require(operation.id)).writeEpoch).toBe(1);

			const conflicted = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				fence: true,
				body: { data: { title: "Stale" }, _rev: stale },
			});

			expect(conflicted).toMatchObject({ success: false, error: { code: "CONFLICT" } });
			expect((await transfers.require(operation.id)).writeEpoch).toBe(1);
		});
	});

	describe("access", () => {
		it("saves through another user's edit lock without beforeWrite", async () => {
			const id = await createEntry();
			await new EntryLockRepository(ctx.db).acquire({
				collection: "post",
				entryId: id,
				userId: AUTHOR.id,
				token: "tab-author",
				leaseSeconds: 300,
			});

			const result = await saveContent(runtime, {
				collection: "post",
				id,
				user: EDITOR,
				body: { data: { title: "Through the lock" } },
			});

			expect(result.success).toBe(true);
			expect((await read("post", id)).item.data.title).toBe("Through the lock");
		});

		it("refuses a user without edit access before beforeWrite runs", async () => {
			const id = await createEntry();
			const beforeWrite = vi.fn(async () => null);

			const forbidden = await saveContent(runtime, {
				collection: "post",
				id,
				user: CONTRIBUTOR,
				beforeWrite,
				body: { data: { title: "Not mine" } },
			});
			const anonymous = await saveContent(runtime, {
				collection: "post",
				id,
				user: null,
				beforeWrite,
				body: { data: { title: "Nobody" } },
			});

			expect(forbidden).toEqual({
				success: false,
				error: { code: "FORBIDDEN", message: "Insufficient permissions" },
			});
			expect(anonymous).toEqual({
				success: false,
				error: { code: "UNAUTHORIZED", message: "Authentication required" },
			});
			expect(beforeWrite).not.toHaveBeenCalled();
			expect((await read("post", id)).item.data.title).toBe("Original");
		});

		it("fails a draft-only editor's save when the entry is published after the check", async () => {
			const id = await createEntry("note", { authorId: CONTRIBUTOR.id });
			const handlers = handlersFromRuntime(runtime);
			const site: ContentSaveSite = {
				db: ctx.db,
				handleContentUpdate: handlers.handleContentUpdate,
				handleContentGet: async (...args) => {
					const result = await handlers.handleContentGet(...args);
					const published = await runtime.handleContentPublish("note", id, {});
					if (!published.success) throw new Error(published.error.message);
					return result;
				},
			};

			const result = await saveContent(site, {
				collection: "note",
				id,
				user: CONTRIBUTOR,
				body: { data: { title: "Edited" } },
			});

			expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
			expect((await new ContentRepository(ctx.db).findById("note", id))?.data.title).toBe(
				"Original",
			);
		});
	});

	it("PUT answers a user without edit access with 403 while another user holds the lock", async () => {
		const id = await createEntry();
		await new EntryLockRepository(ctx.db).acquire({
			collection: "post",
			entryId: id,
			userId: AUTHOR.id,
			token: "tab-author",
			leaseSeconds: 300,
		});

		const response = await updateContent({
			params: { collection: "post", id },
			request: new Request(`http://localhost/_emdash/api/content/post/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Not mine" } }),
			}),
			locals: { emdash: handlersFromRuntime(runtime), user: CONTRIBUTOR },
			cache: { enabled: false, invalidate: vi.fn() },
		} as unknown as Parameters<typeof updateContent>[0]);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "FORBIDDEN", message: "Insufficient permissions" },
		});
	});
});
