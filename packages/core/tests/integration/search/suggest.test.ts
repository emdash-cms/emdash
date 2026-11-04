import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { getSuggestions, searchWithDb } from "../../../src/search/query.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("getSuggestions (Integration)", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		const ftsManager = new FTSManager(db);
		await registry.updateField("post", "title", { searchable: true });
		await ftsManager.enableSearch("post");

		await repo.create(
			createPostFixture({
				slug: "designing-things",
				status: "published",
				data: { title: "Designing things" },
			}),
		);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownTestDatabase(db);
	});

	it("returns matching suggestions for a plain prefix query", async () => {
		const suggestions = await getSuggestions(db, "des", {
			collections: ["post"],
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toMatchObject({
			collection: "post",
			slug: "designing-things",
			title: "Designing things",
		});
	});

	it("does not return draft content", async () => {
		await repo.create(
			createPostFixture({
				slug: "designing-secret-things",
				status: "draft",
				data: { title: "Designing secret things" },
			}),
		);

		const suggestions = await getSuggestions(db, "des", {
			collections: ["post"],
		});

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.title).toBe("Designing things");
	});

	it("returns empty array for a non-matching query", async () => {
		const suggestions = await getSuggestions(db, "zzz", {
			collections: ["post"],
		});

		expect(suggestions).toEqual([]);
	});

	it("searches using the configured locale casing", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "zh-TW"] });
		await repo.create(
			createPostFixture({
				slug: "taiwan-design",
				status: "published",
				locale: "zh-TW",
				data: { title: "Taiwan design" },
			}),
		);

		const results = await searchWithDb(db, "Taiwan", {
			collections: ["post"],
			locale: "zh-tw",
		});

		expect(results.items.map((item) => item.slug)).toEqual(["taiwan-design"]);
	});

	it("suggests using the configured locale casing", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "zh-TW"] });
		await repo.create(
			createPostFixture({
				slug: "taiwan-design",
				status: "published",
				locale: "zh-TW",
				data: { title: "Taiwan design" },
			}),
		);

		const suggestions = await getSuggestions(db, "Tai", {
			collections: ["post"],
			locale: "zh-tw",
		});

		expect(suggestions.map((suggestion) => suggestion.slug)).toEqual(["taiwan-design"]);
	});
});
