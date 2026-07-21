import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { up } from "../../../../src/database/migrations/054_canonicalize_locale_casing.js";
import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { Database } from "../../../../src/database/types.js";
import { getI18nConfig, setI18nConfig } from "../../../../src/i18n/config.js";
import { createPostFixture } from "../../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

describe("migration 054: canonicalize locale casing", () => {
	let db: Kysely<Database>;
	const previousI18nConfig = getI18nConfig();

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		setI18nConfig(previousI18nConfig);
		await teardownTestDatabase(db);
	});

	it("rewrites rows stored in the wrong case to the configured locale's canonical casing", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "zh-TW"] });

		const repo = new ContentRepository(db);
		const post = await repo.create(
			createPostFixture({ slug: "guide", status: "published", data: { title: "Guide" } }),
		);
		// Simulate a row saved under the lowercased locale.
		await sql`UPDATE ec_post SET locale = 'zh-tw' WHERE slug = 'guide'`.execute(db);
		await db
			.insertInto("taxonomies")
			.values({
				id: "category-news",
				name: "category",
				slug: "news",
				label: "News",
				parent_id: null,
				data: null,
				locale: "en",
				translation_group: "category-news",
			})
			.execute();
		await db
			.insertInto("content_taxonomies")
			.values({
				collection: "post",
				entry_id: post.id,
				taxonomy_id: "category-news",
				locale: "zh-tw",
			})
			.execute();

		await up(db);

		const contentRow = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "guide")
			.executeTakeFirstOrThrow();
		const pivotRow = await db
			.selectFrom("content_taxonomies")
			.select("locale")
			.where("entry_id", "=", post.id)
			.executeTakeFirstOrThrow();
		expect(contentRow.locale).toBe("zh-TW");
		expect(pivotRow.locale).toBe("zh-TW");
	});

	it("preserves case-variant rows when canonicalizing would violate slug uniqueness", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "zh-TW"] });

		const repo = new ContentRepository(db);
		await repo.create(createPostFixture({ slug: "guide", locale: "zh-tw" }));
		await repo.create(createPostFixture({ slug: "guide", locale: "zh-TW" }));

		await expect(up(db)).resolves.toBeUndefined();

		const rows = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "guide")
			.orderBy("locale")
			.execute();
		expect(rows.map((row) => row.locale)).toEqual(["zh-TW", "zh-tw"]);
	});

	it("leaves rows already in canonical casing untouched", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "zh-TW"] });

		const repo = new ContentRepository(db);
		await repo.create(
			createPostFixture({
				slug: "already-correct",
				status: "published",
				data: { title: "Correct" },
				locale: "zh-TW",
			}),
		);

		await up(db);

		const row = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "already-correct")
			.executeTakeFirstOrThrow();
		expect(row.locale).toBe("zh-TW");
	});

	it("does nothing when i18n is not configured", async () => {
		setI18nConfig(null);

		const repo = new ContentRepository(db);
		await repo.create(
			createPostFixture({ slug: "no-i18n", status: "published", data: { title: "No i18n" } }),
		);
		await sql`UPDATE ec_post SET locale = 'zh-tw' WHERE slug = 'no-i18n'`.execute(db);

		await up(db);

		const row = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "no-i18n")
			.executeTakeFirstOrThrow();
		expect(row.locale).toBe("zh-tw");
	});
});
