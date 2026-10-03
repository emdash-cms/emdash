import { afterEach, beforeEach, expect, it } from "vitest";

import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("autosave history", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it.each([false, true])(
		"keeps manual Save checkpoints after repeated autosaves (published: %s)",
		async (published) => {
			const created = await runtime.handleContentCreate("posts", {
				data: { title: "Start" },
				slug: "checkpoint",
			});
			expect(created.success).toBe(true);
			const id = created.data!.item.id;
			let rev = created.data!._rev;
			if (published) {
				const result = await runtime.handleContentPublish("posts", id, { _rev: rev });
				expect(result.success).toBe(true);
				rev = result.data!._rev;
			}

			const saved = await runtime.handleContentUpdate("posts", id, {
				data: { title: "Manual checkpoint" },
				_rev: rev,
			});
			expect(saved.success).toBe(true);
			const checkpointId = saved.data!.item.draftRevisionId!;
			const firstAutosave = await runtime.handleContentUpdate("posts", id, {
				data: { title: "More typing" },
				skipRevision: true,
				_rev: saved.data!._rev,
			});
			expect(firstAutosave.success).toBe(true);
			const secondAutosave = await runtime.handleContentUpdate("posts", id, {
				data: { title: "Latest typing" },
				skipRevision: true,
				_rev: firstAutosave.data!._rev,
			});
			expect(secondAutosave.success).toBe(true);

			const history = await runtime.handleRevisionList("posts", id);
			expect(history.success).toBe(true);
			expect(history.data!.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: checkpointId, data: { title: "Manual checkpoint" } }),
					expect.objectContaining({
						id: secondAutosave.data!.item.draftRevisionId,
						data: { title: "Latest typing" },
					}),
				]),
			);
			expect(history.data!.items.map((revision) => revision.id)).not.toContain(
				firstAutosave.data!.item.draftRevisionId,
			);
		},
	);

	it("keeps a published autosave revision while replacing later autosaves", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Initial" },
			slug: "live-autosave",
		});
		const id = created.data!.item.id;
		const autosaved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Published snapshot" },
			skipRevision: true,
			_rev: created.data!._rev,
		});
		expect(autosaved.success).toBe(true);
		const liveRevisionId = autosaved.data!.item.draftRevisionId!;
		const published = await runtime.handleContentPublish("posts", id, {
			_rev: autosaved.data!._rev,
		});
		expect(published.success).toBe(true);
		let rev = published.data!._rev;
		for (const title of ["First draft", "Second draft"]) {
			const result = await runtime.handleContentUpdate("posts", id, {
				data: { title },
				skipRevision: true,
				_rev: rev,
			});
			expect(result.success).toBe(true);
			rev = result.data!._rev;
		}
		const live = await new RevisionRepository(ctx.db).findById(liveRevisionId);
		expect(live?.data).toEqual({ title: "Published snapshot" });
		const entry = await runtime.handleContentGet("posts", id);
		expect(entry.data!.item.liveRevisionId).toBe(liveRevisionId);
	});
});
