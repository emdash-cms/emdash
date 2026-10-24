import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("first revision of a duplicated entry", (dialect) => {
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

	async function duplicate(collection: string): Promise<string> {
		const original = await runtime.handleContentCreate(collection, {
			data: { title: "Lorem ipsum dolor sit amet." },
			slug: "original",
		});
		if (!original.success) throw new Error(original.error.message);
		const duplicated = await runtime.handleContentDuplicate(collection, original.data.item.id);
		if (!duplicated.success) throw new Error(duplicated.error.message);
		return duplicated.data.item.id;
	}

	async function revisionTitles(collection: string, id: string): Promise<unknown[]> {
		const revisions = await runtime.handleRevisionList(collection, id);
		if (!revisions.success) throw new Error(revisions.error.message);
		return revisions.data.items.map((revision) => revision.data.title);
	}

	it("keeps the copied content as the oldest revision through autosave and save", async () => {
		const duplicateId = await duplicate("posts");

		const autosaved = await runtime.handleContentUpdate("posts", duplicateId, {
			data: { title: "Lorem ipsum dolor sit amet. Duis aute irure dolor in reprehenderit." },
			skipRevision: true,
		});
		expect(autosaved.success).toBe(true);

		const saved = await runtime.handleContentUpdate("posts", duplicateId, {
			data: { title: "Duis aute irure dolor in reprehenderit." },
		});
		expect(saved.success).toBe(true);

		const titles = await revisionTitles("posts", duplicateId);
		expect(titles.at(-1)).toBe("Lorem ipsum dolor sit amet. (Copy)");
		expect(titles[0]).toBe("Duis aute irure dolor in reprehenderit.");
	});

	it("writes no revision in a collection without revisions", async () => {
		const duplicateId = await duplicate("pages");

		expect(await revisionTitles("pages", duplicateId)).toEqual([]);
	});
});
