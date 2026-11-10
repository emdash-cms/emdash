import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { ContentMutationConflictError } from "../../../src/database/repositories/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("an entry's starting content in Revisions", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "pages", label: "Pages", supports: [] });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function create(collection: string, status?: string): Promise<string> {
		const created = await runtime.handleContentCreate(collection, {
			data: { title: "Lorem ipsum dolor sit amet." },
			slug: "lorem-ipsum",
			status,
		});
		if (!created.success) throw new Error(created.error.message);
		return created.data.item.id;
	}

	async function duplicate(): Promise<string> {
		const duplicated = await runtime.handleContentDuplicate("posts", await create("posts"));
		if (!duplicated.success) throw new Error(duplicated.error.message);
		return duplicated.data.item.id;
	}

	async function save(collection: string, id: string, title: string, autosave = false) {
		const saved = await runtime.handleContentUpdate(collection, id, {
			data: { title },
			skipRevision: autosave,
		});
		expect(saved.success).toBe(true);
	}

	async function revisionTitles(collection: string, id: string): Promise<unknown[]> {
		const revisions = await runtime.handleRevisionList(collection, id);
		if (!revisions.success) throw new Error(revisions.error.message);
		return revisions.data.items.map((revision) => revision.data.title);
	}

	it.each([
		["a new entry", () => create("posts"), "Lorem ipsum dolor sit amet."],
		["a duplicate", duplicate, "Lorem ipsum dolor sit amet. (Copy)"],
	])("keeps %s's starting content through autosave and save", async (_, start, title) => {
		const id = await start();

		await save("posts", id, "Lorem ipsum dolor sit amet. Duis aute irure dolor.", true);
		await save("posts", id, "Duis aute irure dolor in reprehenderit.", true);
		await save("posts", id, "Excepteur sint occaecat cupidatat.");

		const titles = await revisionTitles("posts", id);
		expect(titles.at(-1)).toBe(title);
		expect(titles[0]).toBe("Excepteur sint occaecat cupidatat.");
	});

	it("keeps a new entry's starting content through plugin edits", async () => {
		const id = await create("posts");
		const repo = new ContentRepository(ctx.db);

		await repo.updateDraftAware("posts", id, { data: { title: "Duis aute irure dolor." } });
		await repo.updateDraftAware("posts", id, { data: { title: "Excepteur sint occaecat." } });

		const titles = await revisionTitles("posts", id);
		expect(titles.at(-1)).toBe("Lorem ipsum dolor sit amet.");
		expect(titles[0]).toBe("Excepteur sint occaecat.");
	});

	type FirstSave = (id: string, title: string) => Promise<void>;

	const firstSaves: Record<string, FirstSave> = {
		"the admin": async (id, title) => {
			const current = await runtime.handleContentGet("posts", id);
			if (!current.success) throw new Error(current.error.message);
			await runtime.handleContentUpdate("posts", id, { data: { title }, _rev: current.data._rev });
		},
		"the API without _rev": (id, title) => save("posts", id, title),
		"a plugin": async (id, title) => {
			await new ContentRepository(ctx.db).updateDraftAware("posts", id, { data: { title } });
		},
	};

	const overlapPoints: Record<string, (overlap: () => Promise<void>) => { mockRestore(): void }> = {
		"checked for revisions": (overlap) => {
			const findLatest = RevisionRepository.prototype.findLatest;
			return vi
				.spyOn(RevisionRepository.prototype, "findLatest")
				.mockImplementationOnce(async function (this: RevisionRepository, collection, entryId) {
					const latest = await findLatest.call(this, collection, entryId);
					await overlap();
					return latest;
				});
		},
		"wrote its draft": (overlap) => {
			const createRevision = RevisionRepository.prototype.create;
			return vi
				.spyOn(RevisionRepository.prototype, "create")
				.mockImplementationOnce(async function (this: RevisionRepository, input) {
					const revision = await createRevision.call(this, input);
					await overlap();
					return revision;
				});
		},
	};

	it.each(
		Object.keys(firstSaves).flatMap((source) =>
			Object.keys(overlapPoints).map((point) => [source, point]),
		),
	)(
		"keeps the starting content once when a first save from %s overlaps another after it %s",
		async (source, point) => {
			const firstSave = firstSaves[source]!;
			const id = await create("posts");
			const spy = overlapPoints[point]!(() =>
				firstSave(id, "Duis aute irure dolor in reprehenderit."),
			);

			await firstSave(id, "Excepteur sint occaecat cupidatat.");
			spy.mockRestore();
			await save("posts", id, "Ut enim ad minim veniam.", true);
			const published = await runtime.handleContentPublish("posts", id);
			expect(published.success).toBe(true);

			const titles = await revisionTitles("posts", id);
			expect(titles.filter((title) => title === "Lorem ipsum dolor sit amet.")).toHaveLength(1);
			expect(titles.at(-1)).toBe("Lorem ipsum dolor sit amet.");
		},
	);

	it.each(Object.keys(firstSaves))(
		"keeps the starting content when a first save from %s is refused while another save's draft is not staged yet",
		async (source) => {
			const firstSave = firstSaves[source]!;
			const id = await create("posts");
			const createRevision = RevisionRepository.prototype.create;
			const spy = vi
				.spyOn(RevisionRepository.prototype, "create")
				.mockImplementationOnce(async function (this: RevisionRepository, input) {
					const revision = await createRevision.call(this, input);
					await sql`UPDATE ec_posts SET version = version + 1 WHERE id = ${id}`.execute(ctx.db);
					await createRevision.call(this, {
						collection: "posts",
						entryId: id,
						data: { title: "Duis aute irure dolor in reprehenderit." },
					});
					return revision;
				});

			await firstSave(id, "Excepteur sint occaecat cupidatat.");
			spy.mockRestore();

			const titles = await revisionTitles("posts", id);
			expect(titles.filter((title) => title === "Lorem ipsum dolor sit amet.")).toHaveLength(1);
			expect(titles.at(-1)).toBe("Lorem ipsum dolor sit amet.");
		},
	);

	it.each(Object.keys(firstSaves))(
		"keeps the starting content when two more saves finish while a first save from %s waits to stage its draft",
		async (source) => {
			const firstSave = firstSaves[source]!;
			const id = await create("posts");
			const spy = overlapPoints["wrote its draft"]!(async () => {
				await save("posts", id, "Duis aute irure dolor in reprehenderit.");
				await save("posts", id, "Ut enim ad minim veniam.");
			});

			await firstSave(id, "Excepteur sint occaecat cupidatat.");
			spy.mockRestore();
			const published = await runtime.handleContentPublish("posts", id);
			expect(published.success).toBe(true);

			const titles = await revisionTitles("posts", id);
			expect(titles.filter((title) => title === "Lorem ipsum dolor sit amet.")).toHaveLength(1);
			expect(titles.at(-1)).toBe("Lorem ipsum dolor sit amet.");
		},
	);

	it("keeps the starting content of entries that share a custom id in two collections", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "notes", label: "Notes" });
		await registry.createField("notes", { slug: "title", label: "Title", type: "string" });
		const repo = new ContentRepository(ctx.db);

		for (const collection of ["posts", "notes"]) {
			await repo.create({
				type: collection,
				id: "about",
				slug: "about",
				data: { title: collection },
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			await save(collection, "about", "Duis aute irure dolor in reprehenderit.");
			await save(collection, "about", "Excepteur sint occaecat cupidatat.");
		}

		for (const collection of ["posts", "notes"]) {
			const titles = await revisionTitles(collection, "about");
			expect(titles.at(-1)).toBe(collection);
		}
	});

	it("keeps the starting content of entries created at the same moment", async () => {
		const repo = new ContentRepository(ctx.db);
		const ids = Array.from({ length: 33 }, (_, index) => `entry-${index}`);

		for (const id of ids) {
			await repo.create({
				type: "posts",
				id,
				slug: id,
				data: { title: id },
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			await save("posts", id, "Duis aute irure dolor in reprehenderit.");
		}

		for (const id of ids) {
			expect((await revisionTitles("posts", id)).at(-1)).toBe(id);
		}
	});

	it("keeps the starting content of an entry whose custom id only looks like a ULID", async () => {
		const id = "8ZZZZZZZZZZZZZZZZZZZZZZZZZ";
		await new ContentRepository(ctx.db).create({
			type: "posts",
			id,
			slug: "custom",
			data: { title: "Lorem ipsum dolor sit amet." },
		});

		await save("posts", id, "Duis aute irure dolor in reprehenderit.");

		expect((await revisionTitles("posts", id)).at(-1)).toBe("Lorem ipsum dolor sit amet.");
	});

	it("writes no starting revision for an entry that already has revisions", async () => {
		const id = await create("posts");
		await new RevisionRepository(ctx.db).create({
			collection: "posts",
			entryId: id,
			data: { title: "Duis aute irure dolor in reprehenderit." },
		});

		await save("posts", id, "Excepteur sint occaecat cupidatat.");

		expect(await revisionTitles("posts", id)).toEqual([
			"Excepteur sint occaecat cupidatat.",
			"Duis aute irure dolor in reprehenderit.",
		]);
	});

	it("writes the starting content once when a draft is discarded and saved again", async () => {
		const id = await create("posts");

		await save("posts", id, "Duis aute irure dolor in reprehenderit.");
		const discarded = await runtime.handleContentDiscardDraft("posts", id);
		expect(discarded.success).toBe(true);
		await save("posts", id, "Excepteur sint occaecat cupidatat.");

		const titles = await revisionTitles("posts", id);
		expect(titles.filter((title) => title === "Lorem ipsum dolor sit amet.")).toHaveLength(1);
	});

	it("keeps a published entry's created content after an edit is published", async () => {
		const id = await create("posts", "published");

		await save("posts", id, "Duis aute irure dolor in reprehenderit.", true);
		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(true);

		expect(await revisionTitles("posts", id)).toEqual([
			"Duis aute irure dolor in reprehenderit.",
			"Lorem ipsum dolor sit amet.",
		]);
	});

	it("keeps the starting content when a publish outside a transaction loses to a first save", async () => {
		const id = await create("posts");
		const findById = RevisionRepository.prototype.findById;
		const spy = vi
			.spyOn(RevisionRepository.prototype, "findById")
			.mockImplementationOnce(async function (this: RevisionRepository, revisionId) {
				await save("posts", id, "Duis aute irure dolor in reprehenderit.");
				return findById.call(this, revisionId);
			});

		await expect(new ContentRepository(ctx.db).publish("posts", id)).rejects.toThrow(
			ContentMutationConflictError,
		);
		spy.mockRestore();
		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(true);

		expect(await revisionTitles("posts", id)).toEqual([
			"Duis aute irure dolor in reprehenderit.",
			"Lorem ipsum dolor sit amet.",
		]);
	});

	it("publishes the stored content of an entry restored from trash, not its starting content", async () => {
		const id = await create("posts");
		await save("posts", id, "Duis aute irure dolor in reprehenderit.");
		expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);
		expect((await runtime.handleContentDelete("posts", id)).success).toBe(true);
		expect((await runtime.handleContentRestore("posts", id)).success).toBe(true);

		expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);

		const entry = await new ContentRepository(ctx.db).findById("posts", id);
		expect(entry?.data.title).toBe("Duis aute irure dolor in reprehenderit.");
	});

	it("publishes the stored content when it changed after a refused first save", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("posts", {
			slug: "category",
			label: "Category",
			type: "string",
			translatable: false,
		});
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Lorem ipsum dolor sit amet.", category: "Blog" },
			slug: "lorem-ipsum",
		});
		if (!created.success) throw new Error(created.error.message);
		const id = created.data.item.id;
		const createRevision = RevisionRepository.prototype.create;
		const spy = vi
			.spyOn(RevisionRepository.prototype, "create")
			.mockImplementationOnce(async function (this: RevisionRepository, input) {
				const revision = await createRevision.call(this, input);
				await sql`UPDATE ec_posts SET version = version + 1 WHERE id = ${id}`.execute(ctx.db);
				return revision;
			});
		await firstSaves["the admin"]!(id, "Duis aute irure dolor in reprehenderit.");
		spy.mockRestore();
		const repo = new ContentRepository(ctx.db);
		const group = (await repo.findById("posts", id))?.translationGroup;
		await repo.syncNonTranslatableFields("posts", "another-locale", group!, { category: "News" });

		expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);

		expect((await repo.findById("posts", id))?.data.category).toBe("News");
	});

	it("records an entry published before its first edit once", async () => {
		const id = await create("posts");

		const published = await runtime.handleContentPublish("posts", id);
		expect(published.success).toBe(true);
		await save("posts", id, "Duis aute irure dolor in reprehenderit.", true);

		expect(await revisionTitles("posts", id)).toEqual([
			"Duis aute irure dolor in reprehenderit.",
			"Lorem ipsum dolor sit amet.",
		]);
	});

	it("writes no starting revision in a collection without revisions", async () => {
		const id = await create("pages");
		await save("pages", id, "Duis aute irure dolor in reprehenderit.");
		expect(await revisionTitles("pages", id)).toEqual([]);

		expect((await runtime.handleContentPublish("pages", id)).success).toBe(true);
		expect(await revisionTitles("pages", id)).toEqual(["Duis aute irure dolor in reprehenderit."]);
	});
});
