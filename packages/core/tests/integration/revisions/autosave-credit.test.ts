import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import {
	RevisionRepository,
	startingRevisionId,
} from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ANA = { id: "user_ana", role: 30 };
const BEN = { id: "user_ben", role: 30 };
const CARA = { id: "user_cara", role: 30 };

describeEachDialect("autosave revision credit", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
	});

	/** A new post, and the revision its first save keeps of its starting content. */
	async function createPost(): Promise<{ id: string; start: string }> {
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Start" },
			slug: "credit",
		});
		expect(created.success).toBe(true);
		const { item } = created.data!;
		return { id: item.id, start: startingRevisionId("post", item.id, item.createdAt) };
	}

	async function save(
		id: string,
		actor: { id: string; role: number },
		title: string,
		options: { autosave?: boolean; editedBy?: string[] } = {},
	): Promise<string> {
		const result = await runtime.handleContentUpdate("post", id, {
			data: { title },
			skipRevision: options.autosave,
			actor,
			editedBy: options.editedBy,
		});
		expect(result.success).toBe(true);
		return result.data!.item.draftRevisionId!;
	}

	const autosave = (id: string, actor: { id: string; role: number }, title: string) =>
		save(id, actor, title, { autosave: true });

	async function revisionIds(id: string): Promise<string[]> {
		const list = await runtime.handleRevisionList("post", id);
		expect(list.success).toBe(true);
		return list.data!.items.map((item) => item.id);
	}

	async function credit(revisionId: string) {
		const row = await ctx.db
			.selectFrom("revisions")
			.select(["kind", "edited_by", "author_id"])
			.where("id", "=", revisionId)
			.executeTakeFirstOrThrow();
		return {
			kind: row.kind,
			editedBy: row.edited_by === null ? null : (JSON.parse(row.edited_by) as unknown),
			authorId: row.author_id,
		};
	}

	it("keeps a manual save when the next autosave lands", async () => {
		const { id, start } = await createPost();
		const manual = await save(id, ANA, "Saved by hand");

		const autosaved = await autosave(id, ANA, "Typed after saving");

		expect(autosaved).not.toBe(manual);
		expect(await revisionIds(id)).toEqual([autosaved, manual, start]);
		const kept = await runtime.handleRevisionGet(manual);
		expect(kept.data?.item.data.title).toBe("Saved by hand");
	});

	it("replaces one user's autosave with the next", async () => {
		const { id, start } = await createPost();
		await autosave(id, ANA, "First");

		const second = await autosave(id, ANA, "Second");

		expect(await revisionIds(id)).toEqual([second, start]);
		expect(await credit(second)).toEqual({
			kind: "autosave",
			editedBy: [ANA.id],
			authorId: ANA.id,
		});
	});

	it("keeps an autosave a room marks kept while an outside autosave is replacing it", async () => {
		const { id } = await createPost();
		const byAna = await autosave(id, ANA, "Ana");
		const repo = new ContentRepository(ctx.db);
		const findDraftBase = RevisionRepository.prototype.findDraftBase;
		vi.spyOn(RevisionRepository.prototype, "findDraftBase").mockImplementationOnce(async function (
			this: RevisionRepository,
			revisionId: string,
		) {
			const base = await findDraftBase.call(this, revisionId);
			const entry = await repo.findById("post", id);
			expect(await repo.markDraftRevisionKept("post", id, entry!)).toBe(true);
			return base;
		});

		await autosave(id, BEN, "Ben");

		expect(await revisionIds(id)).toContain(byAna);
		expect(await credit(byAna)).toMatchObject({ kind: null, editedBy: [ANA.id] });
	});

	it("names everyone who autosaved into a version, latest first, once each", async () => {
		const { id, start } = await createPost();
		await autosave(id, ANA, "Ana types");

		const byBen = await autosave(id, BEN, "Ben types");
		expect(await revisionIds(id)).toEqual([byBen, start]);
		expect(await credit(byBen)).toEqual({
			kind: "autosave",
			editedBy: [BEN.id, ANA.id],
			authorId: BEN.id,
		});

		const byAna = await autosave(id, ANA, "Ana types again");
		expect(await revisionIds(id)).toEqual([byAna, start]);
		expect(await credit(byAna)).toMatchObject({ editedBy: [ANA.id, BEN.id], authorId: ANA.id });
	});

	it("stores no names on a manual save", async () => {
		const { id } = await createPost();
		await autosave(id, ANA, "Ana types");

		const manual = await save(id, BEN, "Ben saves");

		expect(await credit(manual)).toEqual({ kind: null, editedBy: null, authorId: BEN.id });
	});

	it("starts a new list of names when an autosave follows a manual save", async () => {
		const { id, start } = await createPost();
		const byAna = await autosave(id, ANA, "Ana types");
		const manual = await save(id, BEN, "Ben saves");

		const autosaved = await autosave(id, CARA, "Cara types");

		expect(await revisionIds(id)).toEqual([autosaved, manual, byAna, start]);
		expect(await credit(autosaved)).toEqual({
			kind: "autosave",
			editedBy: [CARA.id],
			authorId: CARA.id,
		});
	});

	it("stores the editors a caller passes, ahead of the names it carries", async () => {
		const { id, start } = await createPost();
		await autosave(id, CARA, "Cara types");

		const autosaved = await save(id, ANA, "Room autosave", {
			autosave: true,
			editedBy: [BEN.id, ANA.id],
		});
		expect(await credit(autosaved)).toEqual({
			kind: "autosave",
			editedBy: [BEN.id, ANA.id, CARA.id],
			authorId: ANA.id,
		});

		const kept = await save(id, ANA, "Room checkpoint", { editedBy: [BEN.id, ANA.id] });
		expect(await revisionIds(id)).toEqual([kept, autosaved, start]);
		expect(await credit(kept)).toEqual({
			kind: null,
			editedBy: [BEN.id, ANA.id],
			authorId: ANA.id,
		});
	});

	it("credits the actor when a caller passes an empty list of editors", async () => {
		const { id } = await createPost();

		const autosaved = await save(id, ANA, "Room autosave", { autosave: true, editedBy: [] });

		expect(await credit(autosaved)).toEqual({
			kind: "autosave",
			editedBy: [ANA.id],
			authorId: ANA.id,
		});
	});

	it("names each editor a kept save passes once", async () => {
		const { id } = await createPost();

		const kept = await save(id, ANA, "Room checkpoint", { editedBy: [BEN.id, ANA.id, BEN.id] });

		expect(await credit(kept)).toEqual({
			kind: null,
			editedBy: [BEN.id, ANA.id],
			authorId: ANA.id,
		});
	});

	it("neither replaces nor carries the names of a draft that is also the live version", async () => {
		const { id, start } = await createPost();
		const byAna = await autosave(id, ANA, "Ana types");
		const published = await runtime.handleContentPublish("post", id);
		expect(published.data!.item.liveRevisionId).toBe(byAna);
		await new ContentRepository(ctx.db).setDraftRevision("post", id, byAna);

		const byBen = await autosave(id, BEN, "Ben types");

		expect(await revisionIds(id)).toEqual([byBen, byAna, start]);
		expect(await credit(byAna)).toMatchObject({ kind: "autosave", editedBy: [ANA.id] });
		expect(await credit(byBen)).toEqual({
			kind: "autosave",
			editedBy: [BEN.id],
			authorId: BEN.id,
		});
	});

	it("never replaces a revision written before revisions had a kind", async () => {
		const { id, start } = await createPost();
		const older = await autosave(id, ANA, "Autosaved before the upgrade");
		await ctx.db
			.updateTable("revisions")
			.set({ kind: null, edited_by: null })
			.where("id", "=", older)
			.execute();

		const autosaved = await autosave(id, BEN, "Autosaved after the upgrade");

		expect(await revisionIds(id)).toEqual([autosaved, older, start]);
		expect(await credit(autosaved)).toMatchObject({ editedBy: [BEN.id] });
	});

	it("carries the author of a replaced autosave that stores no names", async () => {
		const { id, start } = await createPost();
		const byAna = await autosave(id, ANA, "Ana types");
		await ctx.db
			.updateTable("revisions")
			.set({ edited_by: null })
			.where("id", "=", byAna)
			.execute();

		const byBen = await autosave(id, BEN, "Ben types");

		expect(await revisionIds(id)).toEqual([byBen, start]);
		expect(await credit(byBen)).toMatchObject({ editedBy: [BEN.id, ANA.id] });
	});

	it("keeps a draft save that passes editors from touching live content", async () => {
		const { id } = await createPost();
		await runtime.handleContentPublish("post", id);

		const result = await runtime.handleContentUpdate("post", id, {
			data: { title: "Room draft" },
			skipRevision: true,
			actor: ANA,
			editedBy: [BEN.id, ANA.id],
		});

		expect(result.success).toBe(true);
		expect(result.liveContentChanged).toBe(false);
		expect(result.data!.item.data.title).toBe("Room draft");
	});
});
