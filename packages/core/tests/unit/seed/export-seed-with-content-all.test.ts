import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * Regression for #1329: `emdash export-seed --with-content all` exported
 * nothing because the literal string "all" was treated as a collection name.
 * Only the bare flag and `--with-content=true` were honoured as the
 * "include every collection" sentinel, contradicting the args help text:
 *
 *     "with-content": {
 *       description: "Include content (all or comma-separated collection names)",
 *     }
 */
describe("exportSeed: --with-content sentinel handling", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		setI18nConfig(null);
		db = await setupTestDatabase();

		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });

		const contentRepo = new ContentRepository(db);
		await contentRepo.create({
			type: "posts",
			slug: "hello-post",
			status: "published",
			data: { title: "Hello Post" },
		});
		await contentRepo.create({
			type: "pages",
			slug: "hello-page",
			status: "published",
			data: { title: "Hello Page" },
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		setI18nConfig(null);
	});

	it("treats `all` as a synonym for include-every-collection", async () => {
		const seed = await exportSeed(db, "all");

		expect(seed.content).toBeDefined();
		expect(Object.keys(seed.content ?? {}).toSorted()).toEqual(["pages", "posts"]);
		expect(seed.content?.posts?.[0]?.slug).toBe("hello-post");
		expect(seed.content?.pages?.[0]?.slug).toBe("hello-page");
	});

	it("matches the bare flag's behaviour (empty string)", async () => {
		const seedAll = await exportSeed(db, "all");
		const seedBare = await exportSeed(db, "");

		expect(Object.keys(seedAll.content ?? {}).toSorted()).toEqual(
			Object.keys(seedBare.content ?? {}).toSorted(),
		);
	});

	it("matches the explicit `true` sentinel's behaviour", async () => {
		const seedAll = await exportSeed(db, "all");
		const seedTrue = await exportSeed(db, "true");

		expect(Object.keys(seedAll.content ?? {}).toSorted()).toEqual(
			Object.keys(seedTrue.content ?? {}).toSorted(),
		);
	});

	it("still treats a comma-separated list as a collection-name filter", async () => {
		const seed = await exportSeed(db, "posts");

		expect(seed.content).toBeDefined();
		expect(Object.keys(seed.content ?? {})).toEqual(["posts"]);
		expect(seed.content?.posts?.[0]?.slug).toBe("hello-post");
	});
});
