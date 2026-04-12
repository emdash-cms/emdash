import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("RedirectRepository", () => {
	let db: Kysely<Database>;
	let repo: RedirectRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new RedirectRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// --- CRUD ---------------------------------------------------------------

	describe("create", () => {
		it("creates a redirect with defaults", async () => {
			const redirect = await repo.create({
				source: "/old",
				destination: "/new",
			});

			expect(redirect.source).toBe("/old");
			expect(redirect.destination).toBe("/new");
			expect(redirect.type).toBe(301);
			expect(redirect.isPattern).toBe(false);
			expect(redirect.enabled).toBe(true);
			expect(redirect.hits).toBe(0);
			expect(redirect.lastHitAt).toBeNull();
			expect(redirect.auto).toBe(false);
			expect(redirect.id).toBeTruthy();
		});

		it("creates a redirect with custom values", async () => {
			const redirect = await repo.create({
				source: "/temp",
				destination: "/target",
				type: 302,
				enabled: false,
				groupName: "Temporary",
				auto: true,
			});

			expect(redirect.type).toBe(302);
			expect(redirect.enabled).toBe(false);
			expect(redirect.groupName).toBe("Temporary");
			expect(redirect.auto).toBe(true);
		});

		it("auto-detects pattern sources", async () => {
			const redirect = await repo.create({
				source: "/old-blog/[...path]",
				destination: "/blog/[...path]",
			});

			expect(redirect.isPattern).toBe(true);
		});

		it("respects explicit isPattern=false override", async () => {
			const redirect = await repo.create({
				source: "/literal-with-brackets",
				destination: "/target",
				isPattern: false,
			});

			expect(redirect.isPattern).toBe(false);
		});
	});

	describe("findById", () => {
		it("returns null for non-existent id", async () => {
			expect(await repo.findById("nonexistent")).toBeNull();
		});

		it("finds a redirect by id", async () => {
			const created = await repo.create({
				source: "/a",
				destination: "/b",
			});
			const found = await repo.findById(created.id);
			expect(found?.source).toBe("/a");
		});
	});

	describe("findBySource", () => {
		it("returns null for non-existent source", async () => {
			expect(await repo.findBySource("/nope")).toBeNull();
		});

		it("finds a redirect by source", async () => {
			await repo.create({ source: "/old", destination: "/new" });
			const found = await repo.findBySource("/old");
			expect(found?.destination).toBe("/new");
		});
	});

	describe("update", () => {
		it("returns null for non-existent id", async () => {
			expect(await repo.update("nonexistent", { destination: "/x" })).toBeNull();
		});

		it("updates destination", async () => {
			const created = await repo.create({
				source: "/a",
				destination: "/b",
			});
			const updated = await repo.update(created.id, { destination: "/c" });
			expect(updated?.destination).toBe("/c");
		});

		it("updates type and enabled", async () => {
			const created = await repo.create({
				source: "/a",
				destination: "/b",
				type: 301,
			});
			const updated = await repo.update(created.id, {
				type: 302,
				enabled: false,
			});
			expect(updated?.type).toBe(302);
			expect(updated?.enabled).toBe(false);
		});

		it("auto-detects isPattern when source changes", async () => {
			const created = await repo.create({
				source: "/literal",
				destination: "/target",
			});
			expect(created.isPattern).toBe(false);

			const updated = await repo.update(created.id, {
				source: "/[slug]",
			});
			expect(updated?.isPattern).toBe(true);
		});
	});

	describe("delete", () => {
		it("returns false for non-existent id", async () => {
			expect(await repo.delete("nonexistent")).toBe(false);
		});

		it("deletes and returns true", async () => {
			const created = await repo.create({
				source: "/a",
				destination: "/b",
			});
			expect(await repo.delete(created.id)).toBe(true);
			expect(await repo.findById(created.id)).toBeNull();
		});
	});

	describe("findMany", () => {
		it("returns empty list when no redirects", async () => {
			const result = await repo.findMany({});
			expect(result.items).toEqual([]);
			expect(result.nextCursor).toBeUndefined();
		});

		it("returns all redirects", async () => {
			await repo.create({ source: "/a", destination: "/b" });
			await repo.create({ source: "/c", destination: "/d" });
			const result = await repo.findMany({});
			expect(result.items).toHaveLength(2);
		});

		it("paginates with cursor", async () => {
			for (let i = 0; i < 5; i++) {
				await repo.create({ source: `/s${i}`, destination: `/d${i}` });
			}

			const page1 = await repo.findMany({ limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.nextCursor).toBeTruthy();

			const page2 = await repo.findMany({ limit: 2, cursor: page1.nextCursor });
			expect(page2.items).toHaveLength(2);
			expect(page2.nextCursor).toBeTruthy();

			// Ensure no overlap
			const page1Ids = new Set(page1.items.map((r) => r.id));
			for (const item of page2.items) {
				expect(page1Ids.has(item.id)).toBe(false);
			}
		});

		it("filters by search term", async () => {
			await repo.create({ source: "/blog/hello", destination: "/new/hello" });
			await repo.create({ source: "/about", destination: "/info" });

			const result = await repo.findMany({ search: "blog" });
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.source).toBe("/blog/hello");
		});

		it("filters by enabled status", async () => {
			await repo.create({ source: "/a", destination: "/b", enabled: true });
			await repo.create({ source: "/c", destination: "/d", enabled: false });

			const enabled = await repo.findMany({ enabled: true });
			expect(enabled.items).toHaveLength(1);
			expect(enabled.items[0]!.source).toBe("/a");

			const disabled = await repo.findMany({ enabled: false });
			expect(disabled.items).toHaveLength(1);
			expect(disabled.items[0]!.source).toBe("/c");
		});

		it("filters by group", async () => {
			await repo.create({
				source: "/a",
				destination: "/b",
				groupName: "wp-import",
			});
			await repo.create({ source: "/c", destination: "/d" });

			const result = await repo.findMany({ group: "wp-import" });
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.groupName).toBe("wp-import");
		});

		it("filters by auto flag", async () => {
			await repo.create({ source: "/a", destination: "/b", auto: true });
			await repo.create({ source: "/c", destination: "/d", auto: false });

			const autoOnly = await repo.findMany({ auto: true });
			expect(autoOnly.items).toHaveLength(1);
			expect(autoOnly.items[0]!.auto).toBe(true);
		});

		it("clamps limit to 1-100", async () => {
			for (let i = 0; i < 3; i++) {
				await repo.create({ source: `/s${i}`, destination: `/d${i}` });
			}

			// limit=0 should clamp to 1
			const min = await repo.findMany({ limit: 0 });
			expect(min.items.length).toBeLessThanOrEqual(1);

			// limit=200 should clamp to 100
			const max = await repo.findMany({ limit: 200 });
			expect(max.items).toHaveLength(3); // only 3 exist
		});
	});

	// --- findAllEnabled -----------------------------------------------------

	describe("findAllEnabled", () => {
		it("returns only enabled redirects", async () => {
			await repo.create({ source: "/a", destination: "/b", enabled: true });
			await repo.create({ source: "/c", destination: "/d", enabled: false });
			await repo.create({ source: "/e", destination: "/f", enabled: true });

			const result = await repo.findAllEnabled();
			expect(result).toHaveLength(2);
			expect(result.every((r) => r.enabled)).toBe(true);
		});

		it("returns empty array when no enabled redirects", async () => {
			await repo.create({ source: "/a", destination: "/b", enabled: false });
			const result = await repo.findAllEnabled();
			expect(result).toHaveLength(0);
		});
	});

	// --- Matching -----------------------------------------------------------

	describe("matchPath", () => {
		it("returns null when no redirects exist", async () => {
			expect(await repo.matchPath("/anything")).toBeNull();
		});

		it("matches exact paths", async () => {
			await repo.create({ source: "/old", destination: "/new" });
			const match = await repo.matchPath("/old");
			expect(match).not.toBeNull();
			expect(match!.resolvedDestination).toBe("/new");
		});

		it("does not match disabled redirects", async () => {
			await repo.create({
				source: "/old",
				destination: "/new",
				enabled: false,
			});
			expect(await repo.matchPath("/old")).toBeNull();
		});

		it("matches pattern redirects", async () => {
			await repo.create({
				source: "/old-blog/[...path]",
				destination: "/blog/[...path]",
			});
			const match = await repo.matchPath("/old-blog/2024/01/post");
			expect(match).not.toBeNull();
			expect(match!.resolvedDestination).toBe("/blog/2024/01/post");
		});

		it("prefers exact match over pattern match", async () => {
			await repo.create({
				source: "/blog/[slug]",
				destination: "/articles/[slug]",
			});
			await repo.create({
				source: "/blog/special",
				destination: "/special-page",
			});

			const match = await repo.matchPath("/blog/special");
			expect(match!.resolvedDestination).toBe("/special-page");
		});

		it("matches [param] in single segment", async () => {
			await repo.create({
				source: "/category/[slug]",
				destination: "/tags/[slug]",
			});
			const match = await repo.matchPath("/category/typescript");
			expect(match!.resolvedDestination).toBe("/tags/typescript");

			// Should not match multi-segment
			expect(await repo.matchPath("/category/a/b")).toBeNull();
		});
	});

	// --- Hit tracking -------------------------------------------------------

	describe("recordHit", () => {
		it("increments hit count and updates lastHitAt", async () => {
			const redirect = await repo.create({
				source: "/a",
				destination: "/b",
			});
			expect(redirect.hits).toBe(0);
			expect(redirect.lastHitAt).toBeNull();

			await repo.recordHit(redirect.id);
			const updated = await repo.findById(redirect.id);
			expect(updated!.hits).toBe(1);
			expect(updated!.lastHitAt).toBeTruthy();

			await repo.recordHit(redirect.id);
			const again = await repo.findById(redirect.id);
			expect(again!.hits).toBe(2);
		});
	});

	// --- Auto-redirects -----------------------------------------------------

	describe("createAutoRedirect", () => {
		it("creates a redirect for slug change with url pattern", async () => {
			const redirect = await repo.createAutoRedirect(
				"posts",
				"old-title",
				"new-title",
				"id1",
				"/blog/{slug}",
			);

			expect(redirect.source).toBe("/blog/old-title");
			expect(redirect.destination).toBe("/blog/new-title");
			expect(redirect.auto).toBe(true);
			expect(redirect.groupName).toBe("Auto: slug change");
			expect(redirect.type).toBe(301);
		});

		it("uses fallback URL when no url pattern", async () => {
			const redirect = await repo.createAutoRedirect("posts", "old-slug", "new-slug", "id1", null);

			expect(redirect.source).toBe("/posts/old-slug");
			expect(redirect.destination).toBe("/posts/new-slug");
		});

		it("collapses existing chains", async () => {
			// First rename: A -> B
			await repo.createAutoRedirect("posts", "title-a", "title-b", "id1", "/blog/{slug}");

			// Second rename: B -> C (should update A's destination to C)
			await repo.createAutoRedirect("posts", "title-b", "title-c", "id1", "/blog/{slug}");

			// Check that the A -> B redirect now points to C
			const aRedirect = await repo.findBySource("/blog/title-a");
			expect(aRedirect!.destination).toBe("/blog/title-c");

			// And B -> C also exists
			const bRedirect = await repo.findBySource("/blog/title-b");
			expect(bRedirect!.destination).toBe("/blog/title-c");
		});

		it("updates existing redirect from same source instead of duplicating", async () => {
			// Create A -> B
			await repo.createAutoRedirect("posts", "a", "b", "id1", "/blog/{slug}");

			// Create A -> C (same source /blog/a, different dest)
			// This calls collapseChains first, which doesn't touch /blog/a since
			// nothing points to /blog/a as destination.
			// Then it finds existing source=/blog/a and updates its destination.
			await repo.createAutoRedirect("posts", "a", "c", "id1", "/blog/{slug}");

			const all = await repo.findMany({});
			// Should only have one redirect from /blog/a
			const fromA = all.items.filter((r) => r.source === "/blog/a");
			expect(fromA).toHaveLength(1);
			expect(fromA[0]!.destination).toBe("/blog/c");
		});
	});

	// --- 404 log ------------------------------------------------------------

	describe("log404", () => {
		it("logs a 404 entry", async () => {
			await repo.log404({ path: "/missing" });
			const result = await repo.find404s({});
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.path).toBe("/missing");
		});

		it("logs with metadata", async () => {
			await repo.log404({
				path: "/missing",
				referrer: "https://google.com",
				userAgent: "Mozilla/5.0",
				ip: "1.2.3.4",
			});
			const result = await repo.find404s({});
			const entry = result.items[0]!;
			expect(entry.referrer).toBe("https://google.com");
			expect(entry.userAgent).toBe("Mozilla/5.0");
			expect(entry.ip).toBe("1.2.3.4");
		});
	});

	describe("find404s", () => {
		it("filters by search", async () => {
			await repo.log404({ path: "/missing-blog-post" });
			await repo.log404({ path: "/about-us" });

			const result = await repo.find404s({ search: "blog" });
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.path).toBe("/missing-blog-post");
		});

		it("paginates", async () => {
			for (let i = 0; i < 5; i++) {
				await repo.log404({ path: `/missing-${i}` });
			}

			const page1 = await repo.find404s({ limit: 2 });
			expect(page1.items).toHaveLength(2);
			expect(page1.nextCursor).toBeTruthy();

			const page2 = await repo.find404s({ limit: 2, cursor: page1.nextCursor });
			expect(page2.items).toHaveLength(2);
		});
	});

	describe("get404Summary", () => {
		it("groups by path and counts", async () => {
			await repo.log404({ path: "/a" });
			await repo.log404({ path: "/a" });
			await repo.log404({ path: "/a" });
			await repo.log404({ path: "/b" });

			const summary = await repo.get404Summary();
			expect(summary).toHaveLength(2);
			// Ordered by count desc
			expect(summary[0]!.path).toBe("/a");
			expect(summary[0]!.count).toBe(3);
			expect(summary[1]!.path).toBe("/b");
			expect(summary[1]!.count).toBe(1);
		});

		it("includes top referrer", async () => {
			await repo.log404({ path: "/x", referrer: "https://google.com" });
			await repo.log404({ path: "/x", referrer: "https://google.com" });
			await repo.log404({ path: "/x", referrer: "https://bing.com" });

			const summary = await repo.get404Summary();
			expect(summary[0]!.topReferrer).toBe("https://google.com");
		});
	});

	describe("delete404", () => {
		it("deletes a single 404 entry", async () => {
			await repo.log404({ path: "/a" });
			await repo.log404({ path: "/b" });

			const all = await repo.find404s({});
			expect(all.items).toHaveLength(2);

			await repo.delete404(all.items[0]!.id);
			const remaining = await repo.find404s({});
			expect(remaining.items).toHaveLength(1);
		});
	});

	describe("clear404s", () => {
		it("removes all 404 entries", async () => {
			await repo.log404({ path: "/a" });
			await repo.log404({ path: "/b" });

			const count = await repo.clear404s();
			expect(count).toBe(2);

			const result = await repo.find404s({});
			expect(result.items).toHaveLength(0);
		});
	});

	describe("prune404s", () => {
		it("removes entries older than cutoff", async () => {
			await repo.log404({ path: "/old" });
			// All entries were just created, so pruning with a future date should clear them
			const count = await repo.prune404s("2099-01-01T00:00:00.000Z");
			expect(count).toBe(1);
		});

		it("keeps entries newer than cutoff", async () => {
			await repo.log404({ path: "/new" });
			const count = await repo.prune404s("2000-01-01T00:00:00.000Z");
			expect(count).toBe(0);

			const result = await repo.find404s({});
			expect(result.items).toHaveLength(1);
		});
	});
});
