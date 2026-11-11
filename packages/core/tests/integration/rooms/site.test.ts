import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { runInFreshRequestContext } from "../../../src/request-context.js";
import { createRoomSite } from "../../../src/rooms/site.js";
import type { CheckpointInput, EntryRef, LoadedEntry, RoomSite } from "../../../src/rooms/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = { id: "user_editor", role: Role.EDITOR as RoleLevel };
const AUTHOR = { id: "user_author", role: Role.AUTHOR as RoleLevel };
const CONTRIBUTOR = { id: "user_contributor", role: Role.CONTRIBUTOR as RoleLevel };
const DISABLED = { id: "user_disabled", role: Role.EDITOR as RoleLevel };

const callouts = definePlugin({
	id: "callouts",
	version: "1.0.0",
	admin: { portableTextBlocks: [{ type: "callout", label: "Callout" }] },
});

describeEachDialect("RoomSite", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let site: RoomSite;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await ctx.db
			.insertInto("users")
			.values(
				[EDITOR, AUTHOR, CONTRIBUTOR, DISABLED].map((user) => ({
					id: user.id,
					email: `${user.id}@example.com`,
					name: user.id,
					role: user.role,
					email_verified: 1,
					disabled: user === DISABLED ? 1 : 0,
				})),
			)
			.execute();
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "starts_at", label: "Starts", type: "datetime" });
		await registry.createCollection({ slug: "note", label: "Notes", supports: [] });
		await registry.createField("note", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(ctx.db, { plugins: [callouts] });
		site = createRoomSite((fn) => runInFreshRequestContext(() => fn(runtime)));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createEntry(
		options: { collection?: string; status?: string; authorId?: string } = {},
	): Promise<EntryRef> {
		const collection = options.collection ?? "post";
		const item = await new ContentRepository(ctx.db).create({
			type: collection,
			data: { title: "Original" },
			slug: `entry-${Math.random().toString(36).slice(2, 8)}`,
			status: options.status ?? "draft",
			authorId: options.authorId ?? AUTHOR.id,
		});
		return { collection, id: item.id };
	}

	async function load(entry: EntryRef): Promise<LoadedEntry> {
		const loaded = await site.load(entry);
		if (!loaded) throw new Error("The entry is gone");
		return loaded;
	}

	function checkpoint(overrides: Partial<CheckpointInput> & { rev: string }): CheckpointInput {
		return {
			actorId: EDITOR.id,
			data: {},
			kept: false,
			editedBy: [overrides.actorId ?? EDITOR.id],
			...overrides,
		};
	}

	function revisions(entry: EntryRef) {
		return ctx.db
			.selectFrom("revisions")
			.select(["id", "kind", "data", "author_id", "edited_by"])
			.where("entry_id", "=", entry.id)
			.orderBy("id")
			.execute();
	}

	async function draftKind(entry: EntryRef): Promise<string | null> {
		const row = await new ContentRepository(ctx.db).findById(entry.collection, entry.id);
		const draft = await ctx.db
			.selectFrom("revisions")
			.select("kind")
			.where("id", "=", row!.draftRevisionId!)
			.executeTakeFirstOrThrow();
		return draft.kind;
	}

	async function startImport(): Promise<void> {
		const { operation } = await new TransferOperationRepository(ctx.db).create({
			kind: "import",
			createdBy: EDITOR.id,
		});
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "running", mutation_started_at: "2026-01-01T00:00:00.000Z" })
			.where("id", "=", operation.id)
			.execute();
	}

	describe("load", () => {
		it("loads the entry with the inputs the editor schema takes", async () => {
			const entry = await createEntry();

			const loaded = await load(entry);

			expect(loaded).toMatchObject({
				status: "draft",
				authorId: AUTHOR.id,
				trashed: false,
				data: { title: "Original" },
				hash: (await runtime.getManifest()).hash,
				pluginTypes: ["callout"],
			});
			expect(loaded.fields).toEqual(
				expect.arrayContaining([
					{ slug: "title", type: "string" },
					{ slug: "content", type: "portableText" },
					{ slug: "starts_at", type: "datetime" },
				]),
			);
		});

		it("loads what a save stored exactly as the save's own write", async () => {
			const entry = await createEntry();
			const before = await load(entry);

			const autosaved = await site.save(
				entry,
				checkpoint({
					rev: before.rev,
					data: { title: "Edited", starts_at: "2026-11-04T10:00:00+02:00" },
					slug: "renamed",
				}),
			);
			const afterAutosave = await load(entry);
			const kept = await site.save(
				entry,
				checkpoint({ rev: afterAutosave.rev, data: { title: "Kept" }, kept: true }),
			);
			const afterKept = await load(entry);

			expect(autosaved).toEqual({
				ok: true,
				rev: afterAutosave.rev,
				data: afterAutosave.data,
				slug: afterAutosave.slug,
			});
			expect(afterAutosave).toMatchObject({
				slug: "renamed",
				data: { starts_at: "2026-11-04T08:00:00.000Z" },
			});
			expect(kept).toEqual({ ok: true, rev: afterKept.rev, data: afterKept.data, slug: "renamed" });
		});

		it("takes block types from every plugin, enabled or not", async () => {
			await runtime.setPluginStatus("callouts", "inactive");

			expect((await load(await createEntry())).pluginTypes).toEqual(["callout"]);
		});

		it("loads an entry in Trash as trashed, and none once it's gone", async () => {
			const entry = await createEntry();
			const repo = new ContentRepository(ctx.db);
			await repo.delete(entry.collection, entry.id);

			expect(await load(entry)).toMatchObject({ trashed: true, data: { title: "Original" } });

			await repo.permanentDelete(entry.collection, entry.id);
			expect(await site.load(entry)).toBeNull();
			expect(await site.load({ collection: "gone", id: entry.id })).toBeNull();
		});
	});

	describe("save", () => {
		it("maps the site's refusals to the room's reasons, keeping the code", async () => {
			const entry = await createEntry();
			const { rev } = await load(entry);
			const published = await createEntry({ status: "published" });
			const note = await createEntry({ collection: "note" });
			const trashed = await createEntry();
			await new ContentRepository(ctx.db).delete(trashed.collection, trashed.id);
			const edit = { data: { title: "Edited" } };

			const results = {
				stale: await site.save(entry, checkpoint({ ...edit, rev: "c3RhbGU=" })),
				contributor: await site.save(
					published,
					checkpoint({ ...edit, actorId: CONTRIBUTOR.id, rev: (await load(published)).rev }),
				),
				disabled: await site.save(entry, checkpoint({ ...edit, actorId: DISABLED.id, rev })),
				deleted: await site.save(entry, checkpoint({ ...edit, actorId: "user_gone", rev })),
				trashed: await site.save(trashed, checkpoint({ ...edit, rev })),
				noRevisions: await site.save(note, checkpoint({ ...edit, rev: (await load(note)).rev })),
			};

			expect(results).toMatchObject({
				stale: { ok: false, reason: "CONFLICT", code: "CONFLICT" },
				contributor: { ok: false, reason: "FORBIDDEN", code: "FORBIDDEN" },
				disabled: { ok: false, reason: "FORBIDDEN", code: "FORBIDDEN" },
				deleted: { ok: false, reason: "FORBIDDEN", code: "FORBIDDEN" },
				trashed: { ok: false, reason: "NOT_FOUND", code: "NOT_FOUND" },
				noRevisions: { ok: false, reason: "REFUSED", code: "DRAFT_NOT_STAGED" },
			});
		});

		it("applies the site-write fence, as a refusal", async () => {
			const entry = await createEntry();
			const { rev } = await load(entry);
			await startImport();

			expect(await site.save(entry, checkpoint({ rev, data: { title: "Blocked" } }))).toMatchObject(
				{
					ok: false,
					reason: "REFUSED",
					code: "TRANSFER_IMPORT_IN_PROGRESS",
				},
			);
			expect(await site.save(entry, checkpoint({ rev, kept: true }))).toMatchObject({
				ok: false,
				reason: "REFUSED",
				code: "TRANSFER_IMPORT_IN_PROGRESS",
			});
			expect((await load(entry)).rev).toBe(rev);
		});
	});

	describe("the kept mark", () => {
		it("marks an autosaved draft kept without changing _rev or adding a revision", async () => {
			const entry = await createEntry();
			const before = await load(entry);
			const autosaved = await site.save(
				entry,
				checkpoint({ rev: before.rev, data: { title: "Typed" } }),
			);
			if (!autosaved.ok) throw new Error(autosaved.message);
			expect(await draftKind(entry)).toBe("autosave");
			const count = (await revisions(entry)).length;

			const kept = await site.save(entry, checkpoint({ rev: autosaved.rev, kept: true }));

			expect(kept).toEqual(autosaved);
			expect(await draftKind(entry)).toBeNull();
			expect(await revisions(entry)).toHaveLength(count);
			expect((await load(entry)).rev).toBe(autosaved.rev);
			expect(await site.save(entry, checkpoint({ rev: autosaved.rev, kept: true }))).toEqual(
				autosaved,
			);
			expect(await site.save(entry, checkpoint({ rev: before.rev, kept: true }))).toMatchObject({
				ok: false,
				reason: "CONFLICT",
			});
		});

		it("resolves to the stored entry when there is no draft to mark", async () => {
			const entry = await createEntry();
			const loaded = await load(entry);

			expect(await site.save(entry, checkpoint({ rev: loaded.rev, kept: true }))).toEqual({
				ok: true,
				rev: loaded.rev,
				data: loaded.data,
				slug: loaded.slug,
			});
			expect(await revisions(entry)).toEqual([]);
		});

		it("checks edit access", async () => {
			const entry = await createEntry({ status: "published" });
			const { rev } = await load(entry);

			expect(
				await site.save(entry, checkpoint({ rev, kept: true, actorId: CONTRIBUTOR.id })),
			).toMatchObject({ ok: false, reason: "FORBIDDEN" });
		});
	});

	describe("saveRecovery", () => {
		it("saves a recovery revision for an entry in Trash, moving no pointer", async () => {
			const entry = await createEntry();
			await new ContentRepository(ctx.db).delete(entry.collection, entry.id);

			await site.saveRecovery(entry, {
				data: { title: "Recovered" },
				slug: "recovered",
				editedBy: [EDITOR.id, AUTHOR.id],
			});

			const [revision] = await revisions(entry);
			expect(revision).toMatchObject({ kind: "recovery", author_id: null });
			expect(JSON.parse(revision!.data)).toEqual({ title: "Recovered", _slug: "recovered" });
			expect(JSON.parse(revision!.edited_by!)).toEqual([EDITOR.id, AUTHOR.id]);
			const row = await new ContentRepository(ctx.db).findByIdIncludingTrashed("post", entry.id);
			expect(row).toMatchObject({ draftRevisionId: null, liveRevisionId: null });
		});

		it("saves nothing once the entry is gone, and throws when the fence refuses", async () => {
			const gone = await createEntry();
			const repo = new ContentRepository(ctx.db);
			await repo.delete(gone.collection, gone.id);
			await repo.permanentDelete(gone.collection, gone.id);
			const recovery = { data: { title: "Recovered" }, slug: null, editedBy: [EDITOR.id] };

			await site.saveRecovery(gone, recovery);
			expect(await revisions(gone)).toEqual([]);

			const entry = await createEntry();
			await startImport();
			await expect(site.saveRecovery(entry, recovery)).rejects.toThrow();
			expect(await revisions(entry)).toEqual([]);
		});
	});
});
