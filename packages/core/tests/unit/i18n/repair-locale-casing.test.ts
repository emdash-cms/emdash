import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentGet,
	handleContentList,
} from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { getI18nConfig, setI18nConfig } from "../../../src/i18n/config.js";
import { repairLocaleCasing } from "../../../src/i18n/repair-locale-casing.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { validateSeed } from "../../../src/seed/validate.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("repairLocaleCasing", () => {
	let db: Kysely<Database>;
	const previousI18nConfig = getI18nConfig();

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		setI18nConfig(previousI18nConfig);
		await teardownTestDatabase(db);
	});

	it("rewrites content and taxonomy pivots to configured locale casing", async () => {
		const repo = new ContentRepository(db);
		const post = await repo.create(
			createPostFixture({ slug: "guide", status: "published", data: { title: "Guide" } }),
		);
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

		await repairLocaleCasing(db, ["en", "zh-TW"]);

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
		const repo = new ContentRepository(db);
		await repo.create(createPostFixture({ slug: "guide", locale: "zh-tw" }));
		await repo.create(createPostFixture({ slug: "guide", locale: "zh-TW" }));

		await expect(repairLocaleCasing(db, ["en", "zh-TW"])).resolves.toBeUndefined();

		const rows = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "guide")
			.orderBy("locale")
			.execute();
		expect(rows.map((row) => row.locale)).toEqual(["zh-TW", "zh-tw"]);
	});

	it("uses lowercase configured casing as authoritative", async () => {
		const repo = new ContentRepository(db);
		await repo.create(createPostFixture({ slug: "guide", locale: "zh-TW" }));

		await repairLocaleCasing(db, ["en", "zh-tw"]);

		const row = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "guide")
			.executeTakeFirstOrThrow();
		expect(row.locale).toBe("zh-tw");
	});

	it("canonicalizes explicit content writes to configured casing", async () => {
		setI18nConfig({ defaultLocale: "zh-TW", locales: ["en", "zh-TW"] });

		const result = await handleContentCreate(db, "post", {
			data: { title: "Guide" },
			locale: "zh-tw",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.locale).toBe("zh-TW");

		const list = await handleContentList(db, "post", { locale: "zh-tw" });
		expect(list.success).toBe(true);
		if (!list.success) return;
		expect(list.data.items.map((item) => item.id)).toContain(result.data.item.id);

		const get = await handleContentGet(db, "post", "guide", "zh-tw");
		expect(get.success).toBe(true);
		if (!get.success) return;
		expect(get.data.item.id).toBe(result.data.item.id);
	});

	it("canonicalizes explicit seed locales to configured casing", async () => {
		setI18nConfig({ defaultLocale: "zh-TW", locales: ["en", "zh-TW"] });
		const seed: SeedFile = {
			version: "1",
			content: {
				post: [
					{
						id: "post-1",
						slug: "guide",
						locale: "zh-tw",
						data: { title: "Guide" },
					},
				],
			},
		};

		await applySeed(db, seed, { includeContent: true });

		const row = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "guide")
			.executeTakeFirstOrThrow();
		expect(row.locale).toBe("zh-TW");
	});

	it("canonicalizes explicit flat taxonomy term locales", async () => {
		setI18nConfig({ defaultLocale: "zh-TW", locales: ["en", "zh-TW"] });
		const seed: SeedFile = {
			version: "1",
			taxonomies: [
				{
					name: "topic",
					label: "Topics",
					hierarchical: false,
					collections: ["post"],
					locale: "zh-TW",
					terms: [{ slug: "news", label: "News", locale: "zh-tw" }],
				},
			],
		};

		await applySeed(db, seed, { includeContent: true });

		const row = await db
			.selectFrom("taxonomies")
			.select("locale")
			.where("name", "=", "topic")
			.where("slug", "=", "news")
			.executeTakeFirstOrThrow();
		expect(row.locale).toBe("zh-TW");
	});

	it("validates term uniqueness using configured locale casing", () => {
		setI18nConfig({ defaultLocale: "zh-TW", locales: ["en", "zh-TW"] });
		const seed: SeedFile = {
			version: "1",
			taxonomies: [
				{
					name: "topic",
					label: "Topics",
					hierarchical: false,
					collections: ["post"],
					locale: "zh-TW",
					terms: [
						{ slug: "news", label: "News" },
						{ slug: "news", label: "News duplicate", locale: "zh-tw" },
					],
				},
			],
		};

		const validation = validateSeed(seed);

		expect(validation.valid).toBe(false);
		expect(validation.errors.some((error) => error.includes("duplicate term slug"))).toBe(true);
	});

	it("validates taxonomy and menu uniqueness using configured locale casing", () => {
		setI18nConfig({ defaultLocale: "zh-TW", locales: ["en", "zh-TW"] });
		const seed: SeedFile = {
			version: "1",
			taxonomies: [
				{
					name: "topic",
					label: "Topics",
					hierarchical: false,
					collections: ["post"],
				},
				{
					name: "topic",
					label: "Topics duplicate",
					hierarchical: false,
					collections: ["post"],
					locale: "zh-tw",
				},
			],
			menus: [
				{ name: "primary", label: "Primary", items: [] },
				{ name: "primary", label: "Primary duplicate", locale: "zh-tw", items: [] },
			],
		};

		const validation = validateSeed(seed);

		expect(validation.valid).toBe(false);
		expect(validation.errors.some((error) => error.includes("duplicate taxonomy"))).toBe(true);
		expect(validation.errors.some((error) => error.includes("duplicate menu"))).toBe(true);
	});

	it("canonicalizes explicit hierarchical taxonomy term locales", async () => {
		setI18nConfig({ defaultLocale: "zh-TW", locales: ["en", "zh-TW"] });
		const seed: SeedFile = {
			version: "1",
			taxonomies: [
				{
					name: "section",
					label: "Sections",
					hierarchical: true,
					collections: ["post"],
					locale: "zh-TW",
					terms: [
						{ slug: "parent", label: "Parent" },
						{ slug: "child", label: "Child", parent: "parent", locale: "zh-tw" },
					],
				},
			],
		};

		const validation = validateSeed(seed);
		expect(validation.valid).toBe(true);
		await applySeed(db, seed, { includeContent: true });

		const rows = await db
			.selectFrom("taxonomies")
			.select("locale")
			.where("name", "=", "section")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.locale === "zh-TW")).toBe(true);
	});

	it("updates only one row when multiple noncanonical variants would collide", async () => {
		const repo = new ContentRepository(db);
		await repo.create(createPostFixture({ slug: "guide", locale: "zh-tw" }));
		await repo.create(createPostFixture({ slug: "guide", locale: "ZH-tw" }));

		await expect(repairLocaleCasing(db, ["en", "zh-TW"])).resolves.toBeUndefined();

		const rows = await db
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "guide")
			.orderBy("locale")
			.execute();
		const locales = rows.map((row) => row.locale);
		expect(locales).toContain("zh-TW");
		expect(locales.filter((locale) => locale !== "zh-TW")).toHaveLength(1);
	});
});
