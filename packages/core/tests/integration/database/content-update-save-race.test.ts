/**
 * Concurrent draft-revision saves should not silently drop an edit.
 *
 * `EmDashRuntime.handleContentUpdate`'s draft-revision path is a
 * read-existing -> merge -> create-revision -> flip-pointer sequence. Two
 * concurrent saves that both read `draft_revision_id: null` before either
 * writes can both create a revision and race to flip the pointer; the
 * slower save's edit must not be silently discarded even though the API
 * reports success.
 */

import { sql } from "kysely";
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

describeEachDialect("concurrent draft-revision saves", (dialect) => {
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

	it("returns a conflict instead of silently dropping the edit when every CAS retry loses", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "race-post-exhausted",
			data: { title: "Original title", subtitle: "Original subtitle" },
			status: "published",
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		const contentId = created.data.item.id;

		// Simulate another save winning the pointer flip on every attempt: right
		// after our revision is created, flip draft_revision_id out from under
		// us so the CAS UPDATE always affects zero rows.
		const originalCreate = RevisionRepository.prototype.create;
		let calls = 0;
		const spy = vi.spyOn(RevisionRepository.prototype, "create").mockImplementation(async function (
			this: RevisionRepository,
			...args: Parameters<typeof originalCreate>
		) {
			const revision = await originalCreate.apply(this, args);
			calls++;
			// A real revision row (FK-valid), standing in for the other save's
			// winning pointer flip.
			const decoy = await originalCreate.apply(this, [
				{
					collection: "posts",
					entryId: contentId,
					data: { title: `external winner ${calls}` },
				},
			]);
			await sql`
				UPDATE ec_posts
				SET draft_revision_id = ${decoy.id}
				WHERE id = ${contentId}
			`.execute(ctx.db);
			return revision;
		});

		let result: Awaited<ReturnType<typeof runtime.handleContentUpdate>>;
		try {
			result = await runtime.handleContentUpdate("posts", contentId, {
				data: { title: "Title that must not be silently dropped" },
			});
		} finally {
			spy.mockRestore();
		}

		expect(calls).toBe(8);
		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected failure");
		expect(result.error.code).toBe("DRAFT_SAVE_CONFLICT");

		// The edit was rejected, not silently discarded behind a success
		// response — the draft still reflects the last CAS winner, not our
		// attempted edit.
		const final = await runtime.handleContentGet("posts", contentId);
		expect(final.success).toBe(true);
		if (!final.success) throw new Error("expected success");
		expect(final.data.item.data.title).not.toBe("Title that must not be silently dropped");
		expect(final.data.item.data.title).toBe(`external winner ${calls}`);
	});
});
