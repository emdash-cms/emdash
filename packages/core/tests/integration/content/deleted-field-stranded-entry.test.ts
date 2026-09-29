/**
 * Deleting a field can strand a pending draft: the revision stores the whole `data`,
 * so the deleted field's value stays there and every read hands it back. Writing that
 * data back was refused as an unknown field, an explicit null was refused too, and
 * omitting the key was accepted but left the merge carrying it, so no request body
 * got the entry out of the state.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect(
	"an entry with a pending draft when one of its fields is deleted",
	(dialect) => {
		let ctx: DialectTestContext;
		let runtime: EmDashRuntime;
		let id: string;

		beforeEach(async () => {
			ctx = await setupForDialect(dialect);
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			await registry.createField("posts", { slug: "hits", label: "Hits", type: "integer" });
			runtime = createTestRuntime(ctx.db);

			const created = await runtime.handleContentCreate("posts", {
				slug: "p1",
				data: { title: "p1", hits: 42 },
				status: "published",
			});
			if (!created.success) throw new Error("setup: create failed");
			id = created.data.item.id;

			// A pending draft, as an editor leaves behind by saving without publishing.
			const draft = await runtime.handleContentUpdate("posts", id, {
				data: { title: "p1 draft", hits: 43 },
			});
			if (!draft.success) throw new Error("setup: draft update failed");

			await registry.deleteField("posts", "hits");
		});

		afterEach(async () => {
			await teardownForDialect(ctx);
		});

		it("saves the data it just read, and sheds the deleted field", async () => {
			const got = await runtime.handleContentGet("posts", id);
			expect(got.success).toBe(true);
			if (!got.success) return;
			const data = { ...(got.data.item.data as Record<string, unknown>), title: "edited" };
			expect(data.hits).toBe(43); // the draft still carries it, which is what a client sends back

			const saved = await runtime.handleContentUpdate("posts", id, { data });
			expect(saved.success).toBe(true);
			if (!saved.success) return;
			expect(saved.data.item.data).toMatchObject({ title: "edited" });
			expect(Object.hasOwn(saved.data.item.data as Record<string, unknown>, "hits")).toBe(false);
		});

		it("accepts an explicit null for the deleted field, and refuses it once the entry is clean", async () => {
			const cleared = await runtime.handleContentUpdate("posts", id, {
				data: { title: "edited", hits: null },
			});
			expect(cleared.success).toBe(true);

			// The entry no longer stores the key, so sending it again is an unknown field like any other.
			const again = await runtime.handleContentUpdate("posts", id, {
				data: { title: "edited twice", hits: null },
			});
			expect(again.success).toBe(false);
		});

		it("drops the value from the merged data even when the key is omitted", async () => {
			const saved = await runtime.handleContentUpdate("posts", id, { data: { title: "edited" } });
			expect(saved.success).toBe(true);
			if (!saved.success) return;
			expect(Object.hasOwn(saved.data.item.data as Record<string, unknown>, "hits")).toBe(false);
		});

		it("still refuses a key the entry does not already store", async () => {
			const saved = await runtime.handleContentUpdate("posts", id, {
				data: { title: "edited", titel: "typo" },
			});
			expect(saved.success).toBe(false);
			if (saved.success) return;
			expect(saved.error.message).toContain("unknown field on collection");
		});

		// The plugin context and both sandbox bridges write through the repository rather than
		// the runtime handler, so the same entry has to be saveable from there too.
		describe("through ContentRepository.updateDraftAware", () => {
			it("saves the data it just read, and sheds the deleted field", async () => {
				const repo = new ContentRepository(ctx.db);
				const got = await runtime.handleContentGet("posts", id);
				expect(got.success).toBe(true);
				if (!got.success) return;
				const read = got.data.item.data as Record<string, unknown>;
				expect(read.hits).toBe(43); // the draft still carries it, which is what a caller sends back

				const updated = await repo.updateDraftAware("posts", id, {
					data: { ...read, title: "edited" },
				});
				expect(updated.data).toMatchObject({ title: "edited" });
				expect(Object.hasOwn(updated.data, "hits")).toBe(false);
			});

			it("still refuses a key the entry does not already store", async () => {
				const repo = new ContentRepository(ctx.db);
				await expect(
					repo.updateDraftAware("posts", id, { data: { title: "edited", titel: "typo" } }),
				).rejects.toThrow(/Unknown field/);
			});
		});
	},
);
