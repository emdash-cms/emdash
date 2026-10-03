import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { ContentMutationConflictError } from "../../../src/database/repositories/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function createGate() {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { entered, released, enter, release };
}

describeEachDialect("revision-preconditioned saves", (dialect) => {
	let context: DialectTestContext;
	let runtime: EmDashRuntime;
	let slowSave: ReturnType<typeof createGate>;

	beforeEach(async () => {
		context = await setupForDialect(dialect);
		const registry = new SchemaRegistry(context.db);
		for (const collection of ["posts", "pages"]) {
			await registry.createCollection({
				slug: collection,
				label: collection,
				hasSeo: true,
				...(collection === "pages" ? { supports: [] } : {}),
			});
			await registry.createField(collection, { slug: "title", label: "Title", type: "string" });
			await registry.createField(collection, { slug: "summary", label: "Summary", type: "string" });
		}
		slowSave = createGate();
		const plugin = definePlugin({
			id: "slow-hook",
			version: "1.0.0",
			capabilities: ["content:read", "content:write"],
			hooks: {
				"content:beforeSave": {
					handler: async (event) => {
						if (event.content.title === "Editor A") {
							slowSave.enter();
							await slowSave.released;
						}
						return event.content;
					},
				},
			},
		}) as ResolvedPlugin;
		runtime = createTestRuntime(context.db, { plugins: [plugin] });
	});

	afterEach(async () => {
		slowSave.release();
		await teardownForDialect(context);
	});

	it.each(["posts", "pages"])(
		"refuses a save that becomes stale during a hook on %s",
		async (collection) => {
			const created = await runtime.handleContentCreate(collection, {
				data: { title: "Original" },
				slug: "entry",
				seo: { title: "Original SEO" },
			});
			expect(created.success).toBe(true);
			const id = created.data!.item.id;
			const revision = created.data!._rev;
			const editorA = runtime.handleContentUpdate(collection, id, {
				data: { title: "Editor A" },
				seo: { title: "Editor A SEO" },
				_rev: revision,
			});
			await slowSave.entered;
			let editorB: Awaited<ReturnType<typeof runtime.handleContentUpdate>>;
			try {
				editorB = await runtime.handleContentUpdate(collection, id, {
					data: { title: "Editor B" },
					seo: { title: "Editor B SEO" },
					_rev: revision,
				});
			} finally {
				slowSave.release();
			}
			const resultA = await editorA;
			expect(editorB.success).toBe(true);
			expect(resultA).toMatchObject({ success: false, error: { code: "CONFLICT" } });
			const stored = await runtime.handleContentGet(collection, id);
			expect(stored.data!.item.data.title).toBe("Editor B");
			expect(stored.data!.item.seo?.title).toBe("Editor B SEO");
		},
	);

	it("keeps NOT_FOUND for a blind save of a missing draft entry", async () => {
		const result = await runtime.handleContentUpdate("posts", "missing-entry", {
			data: { title: "Missing entry" },
		});
		expect(result).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
	});

	it("accepts only one concurrent repository write using the same revision", async () => {
		const repo = new ContentRepository(context.db);
		const original = await repo.create({ type: "pages", data: { title: "Original" } });
		const results = await Promise.allSettled([
			repo.update("pages", original.id, { data: { title: "Editor A" } }, original),
			repo.update("pages", original.id, { data: { title: "Editor B" } }, original),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.reason).toBeInstanceOf(ContentMutationConflictError);
		const stored = await repo.findById("pages", original.id);
		expect(["Editor A", "Editor B"]).toContain(stored?.data.title);
		expect(stored?.version).toBe(original.version + 1);
	});

	it("rejects a timestamp mismatch even when the version matches", async () => {
		const repo = new ContentRepository(context.db);
		const original = await repo.create({ type: "pages", data: { title: "Original" } });
		await expect(
			repo.update(
				"pages",
				original.id,
				{ data: { title: "Stale" } },
				{ ...original, updatedAt: "2000-01-01T00:00:00.000Z" },
			),
		).rejects.toBeInstanceOf(ContentMutationConflictError);
		expect((await repo.findById("pages", original.id))?.data.title).toBe("Original");
	});

	it("preserves blind draft saves and merges a newer edit to another field", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Original", summary: "Original summary" },
			slug: "entry",
		});
		const id = created.data!.item.id;
		const editorA = runtime.handleContentUpdate("posts", id, { data: { title: "Editor A" } });
		await slowSave.entered;
		try {
			const editorB = await runtime.handleContentUpdate("posts", id, {
				data: { summary: "Editor B summary" },
			});
			expect(editorB.success).toBe(true);
		} finally {
			slowSave.release();
		}
		expect((await editorA).success).toBe(true);
		const stored = await runtime.handleContentGet("posts", id);
		expect(stored.data!.item.data).toMatchObject({
			title: "Editor A",
			summary: "Editor B summary",
		});
	});
});
