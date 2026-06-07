import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate, handleContentList } from "../../../src/api/handlers/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// Regression for #1219: content list search was client-side over the loaded
// page only, so an entry far back in a large collection could not be found.
// The list query now accepts a server-side `q` substring filter.
describeEachDialect("content list server-side search (#1219)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		// Seed 60 ordinary posts plus a "deep" needle far past the first page.
		for (let i = 0; i < 60; i++) {
			const created = await handleContentCreate(ctx.db, "posts", {
				slug: `post-${String(i).padStart(3, "0")}`,
				data: { title: `Ordinary Post ${i}` },
			});
			if (!created.success) throw new Error("seed failed");
		}
		const needle = await handleContentCreate(ctx.db, "posts", {
			slug: "the-needle-post",
			data: { title: "zzz Needle Headline" },
		});
		if (!needle.success) throw new Error("needle seed failed");

		// A title containing a literal % to prove wildcards are escaped.
		const pct = await handleContentCreate(ctx.db, "posts", {
			slug: "percent-post",
			data: { title: "50% off sale" },
		});
		if (!pct.success) throw new Error("percent seed failed");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function titlesOf(result: {
		success: boolean;
		data?: { items: { data: Record<string, unknown> }[] };
	}) {
		if (!result.success || !result.data) throw new Error("list failed");
		return result.data.items.map((i) => i.data.title as string);
	}

	it("finds an entry that lives far past the first page", async () => {
		const result = await handleContentList(ctx.db, "posts", { q: "Needle", limit: 20 });
		expect(titlesOf(result)).toContain("zzz Needle Headline");
	});

	it("matches case-insensitively", async () => {
		const result = await handleContentList(ctx.db, "posts", { q: "needle", limit: 20 });
		expect(titlesOf(result)).toContain("zzz Needle Headline");

		const upper = await handleContentList(ctx.db, "posts", { q: "NEEDLE", limit: 20 });
		expect(titlesOf(upper)).toContain("zzz Needle Headline");
	});

	it("searches the slug as well as the title", async () => {
		const result = await handleContentList(ctx.db, "posts", { q: "the-needle-post", limit: 20 });
		expect(titlesOf(result)).toContain("zzz Needle Headline");
	});

	it("treats LIKE wildcards in the query literally", async () => {
		// "50%" must match only the "50% off sale" title — not every row (which
		// is what an unescaped trailing % wildcard would do).
		const result = await handleContentList(ctx.db, "posts", { q: "50%", limit: 100 });
		const titles = titlesOf(result);
		expect(titles).toContain("50% off sale");
		expect(titles).not.toContain("Ordinary Post 0");
	});

	it("returns the full unfiltered list when no query is given", async () => {
		const result = await handleContentList(ctx.db, "posts", { limit: 20 });
		if (!result.success) throw new Error("list failed");
		// 62 total rows; first page capped at the limit.
		expect(result.data.items).toHaveLength(20);
		expect(result.data.total).toBe(62);
	});
});
