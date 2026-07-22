/**
 * Concurrent draft-revision saves silently drop an edit (comment on emdash
 * issue #1158, reported against 0.28.1/0.29.0 after #1119 fixed the original
 * TipTap-dispatch cause of #1158 itself).
 *
 * `EmDashRuntime.handleContentUpdate`'s draft-revision path is a
 * read-existing -> merge -> create-revision -> flip-pointer sequence with no
 * wrapping transaction (D1 doesn't support multi-statement transactions) and,
 * before this fix, an unconditional pointer-flip UPDATE. Two concurrent saves
 * that both read `draft_revision_id: null` before either writes both create a
 * new revision and race to flip the pointer; whichever UPDATE lands last wins
 * regardless of which read the fresher data, so the other save's edit is
 * silently discarded even though the API reported it as successful.
 *
 * This test forces that exact interleaving (both saves reach
 * `RevisionRepository.create` before either one's create/flip completes) and
 * asserts both edits survive.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("concurrent draft-revision saves (issue #1158 follow-up)", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		setI18nConfig(null);
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		// Default supports = ["drafts", "revisions"] — exercises the draft
		// revision path under test.
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "subtitle", label: "Subtitle", type: "string" });
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("does not drop an edit when two saves race to create the first draft revision", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "race-post",
			data: { title: "Original title", subtitle: "Original subtitle" },
			status: "published",
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		const contentId = created.data.item.id;

		// Gate RevisionRepository.create so the first call to reach it blocks
		// until the second call also reaches it. Both handleContentUpdate
		// calls read `existing` (draftRevisionId: null) before calling
		// create(), so by the time either is released, both have already
		// computed their mergedData off the same stale base — reproducing the
		// concurrent-PUT race from the report regardless of driver/dialect
		// timing.
		let arrivals = 0;
		let releaseFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const originalCreate = RevisionRepository.prototype.create;
		const spy = vi.spyOn(RevisionRepository.prototype, "create").mockImplementation(async function (
			this: RevisionRepository,
			...args: Parameters<typeof originalCreate>
		) {
			arrivals++;
			if (arrivals === 1) {
				await gate;
			} else {
				releaseFirst?.();
			}
			return originalCreate.apply(this, args);
		});

		let resultA: Awaited<ReturnType<typeof runtime.handleContentUpdate>>;
		let resultB: Awaited<ReturnType<typeof runtime.handleContentUpdate>>;
		try {
			[resultA, resultB] = await Promise.all([
				runtime.handleContentUpdate("posts", contentId, {
					data: { title: "Title from save A" },
				}),
				runtime.handleContentUpdate("posts", contentId, {
					data: { subtitle: "Subtitle from save B" },
				}),
			]);
		} finally {
			spy.mockRestore();
		}

		expect(resultA.success).toBe(true);
		expect(resultB.success).toBe(true);
		// At least the forced first collision; the fix's CAS retry adds more.
		expect(arrivals).toBeGreaterThanOrEqual(2);

		const final = await runtime.handleContentGet("posts", contentId);
		expect(final.success).toBe(true);
		if (!final.success) throw new Error("expected success");

		// Neither edit was silently discarded by the losing side of the race.
		expect(final.data.item.data.title).toBe("Title from save A");
		expect(final.data.item.data.subtitle).toBe("Subtitle from save B");
	});
});
