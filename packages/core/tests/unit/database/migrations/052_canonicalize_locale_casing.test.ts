import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { up } from "../../../../src/database/migrations/052_canonicalize_locale_casing.js";
import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { Database } from "../../../../src/database/types.js";
import { getI18nConfig, setI18nConfig } from "../../../../src/i18n/config.js";
import { createPostFixture } from "../../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

/**
 * Regression coverage for #1572.
 *
 * `contentCreateBody` used to lowercase every explicit `locale` value, so a
 * site with a configured locale like `zh-TW` could have existing rows stored
 * as `zh-tw`. Removing that transform fixed new queries against the
 * canonical casing, but pre-existing rows would still be missed by an exact
 * `locale = 'zh-TW'` filter without a data backfill.
 */
describe("migration 052: canonicalize locale casing (#1572)", () => {
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
		await repo.create(
			createPostFixture({ slug: "guide", status: "published", data: { title: "Guide" } }),
		);
		// Simulate a pre-fix row: written under the lowercased locale.
		await sql`UPDATE ec_post SET locale = 'zh-tw' WHERE slug = 'guide'`.execute(db);

		await up(db);

		const row = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "guide")
			.executeTakeFirstOrThrow();
		expect(row.locale).toBe("zh-TW");
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
