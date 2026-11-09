import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function ok<T>(
	result: { success: true; data: T } | { success: false; error: { message: string } },
): T {
	if (!result.success) throw new Error(result.error.message);
	return result.data;
}

describeEachDialect("content list draft data", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		await new SchemaRegistry(db).createField("post", {
			slug: "summary",
			label: "Summary",
			type: "string",
		});
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function listItem(id: string) {
		const list = ok(await runtime.handleContentList("post", {}));
		const item = list.items.find((entry) => entry.id === id);
		if (!item) throw new Error("Entry missing from list");
		return item;
	}

	it("shows the latest saved draft fields without changing the base row", async () => {
		const created = ok(
			await runtime.handleContentCreate("post", {
				data: { title: "Title A", summary: "Original body" },
				slug: "original",
			}),
		).item;
		ok(
			await runtime.handleContentUpdate("post", created.id, {
				data: { title: "Title B" },
				slug: "staged-slug",
			}),
		);
		ok(
			await runtime.handleContentUpdate("post", created.id, {
				data: { summary: "Updated body" },
				skipRevision: true,
			}),
		);

		const editor = ok(await runtime.handleContentGet("post", created.id)).item;
		const listed = await listItem(created.id);
		expect(listed.liveRevisionId).toBeNull();
		expect(listed.data).toEqual(editor.data);
		expect(listed.data).toMatchObject({ title: "Title B", summary: "Updated body" });
		expect(Object.keys(listed.data).some((key) => key.startsWith("_"))).toBe(false);
		expect((await new ContentRepository(db).findById("post", created.id))?.data.title).toBe(
			"Title A",
		);

		ok(await runtime.handleContentDiscardDraft("post", created.id));
		expect((await listItem(created.id)).data.title).toBe("Title A");
	});

	it("keeps published list data live until publishing, then overlays drafts after unpublish", async () => {
		const created = ok(
			await runtime.handleContentCreate("post", {
				data: { title: "Live title" },
				slug: "live",
			}),
		).item;
		ok(await runtime.handleContentPublish("post", created.id));
		ok(await runtime.handleContentUpdate("post", created.id, { data: { title: "Pending title" } }));
		expect((await listItem(created.id)).data.title).toBe("Live title");

		ok(await runtime.handleContentPublish("post", created.id));
		expect((await listItem(created.id)).data.title).toBe("Pending title");
		ok(
			await runtime.handleContentUpdate("post", created.id, {
				data: { title: "Unpublished title" },
			}),
		);
		ok(await runtime.handleContentUnpublish("post", created.id));
		expect((await listItem(created.id)).data.title).toBe("Unpublished title");
	});

	it("does not expose pending edits for published entries created without a live revision", async () => {
		const created = ok(
			await runtime.handleContentCreate("post", {
				data: { title: "Imported live title" },
				slug: "imported",
				status: "published",
			}),
		).item;
		expect(created.liveRevisionId).toBeNull();
		ok(await runtime.handleContentUpdate("post", created.id, { data: { title: "Private edit" } }));
		const editor = ok(await runtime.handleContentGet("post", created.id)).item;
		expect(editor.draftRevisionId).not.toBeNull();
		expect(editor.data.title).toBe("Private edit");

		const list = ok(await runtime.handleContentList("post", { status: "published" }));
		expect(list.items).toHaveLength(1);
		expect(list.items[0]?.data.title).toBe("Imported live title");
		expect((await listItem(created.id)).data.title).toBe("Imported live title");
	});

	it("leaves newly created entries without a draft revision unchanged", async () => {
		const created = ok(
			await runtime.handleContentCreate("post", { data: { title: "Initial" }, slug: "initial" }),
		).item;
		expect((await listItem(created.id)).data.title).toBe("Initial");
	});
});
