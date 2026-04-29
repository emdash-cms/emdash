import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import {
	getPluginSettingWithDb,
	getPluginSettingsWithDb,
	getSiteSetting,
	getSiteSettings,
	getSiteSettingWithDb,
	getSiteSettingsWithDb,
	invalidateSiteSettingsCache,
	setSiteSettings,
} from "../../../src/settings/index.js";
import { setupTestDatabase } from "../../utils/test-db.js";

describe("Site Settings", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	describe("setSiteSettings", () => {
		it("should store settings with site: prefix", async () => {
			await setSiteSettings({ title: "Test Site" }, db);

			const row = await db
				.selectFrom("options")
				.where("name", "=", "site:title")
				.select("value")
				.executeTakeFirst();

			expect(row?.value).toBe('"Test Site"');
		});

		it("should merge with existing settings", async () => {
			await setSiteSettings({ title: "Test" }, db);
			await setSiteSettings({ tagline: "Welcome" }, db);

			const settings = await getSiteSettingsWithDb(db);
			expect(settings.title).toBe("Test");
			expect(settings.tagline).toBe("Welcome");
		});

		it("should store complex objects", async () => {
			await setSiteSettings(
				{
					social: {
						twitter: "@handle",
						github: "user",
					},
				},
				db,
			);

			const settings = await getSiteSettingsWithDb(db);
			expect(settings.social?.twitter).toBe("@handle");
			expect(settings.social?.github).toBe("user");
		});

		it("should store logo with mediaId", async () => {
			await setSiteSettings(
				{
					logo: { mediaId: "med_123", alt: "Logo" },
				},
				db,
			);

			const row = await db
				.selectFrom("options")
				.where("name", "=", "site:logo")
				.select("value")
				.executeTakeFirst();

			const parsed = JSON.parse(row?.value || "{}");
			expect(parsed.mediaId).toBe("med_123");
			expect(parsed.alt).toBe("Logo");
		});
	});

	describe("getSiteSetting", () => {
		it("should return undefined for unset values", async () => {
			const title = await getSiteSettingWithDb("title", db);
			expect(title).toBeUndefined();
		});

		it("should return the stored value", async () => {
			await setSiteSettings({ title: "My Site" }, db);
			const title = await getSiteSettingWithDb("title", db);
			expect(title).toBe("My Site");
		});

		it("should return numbers correctly", async () => {
			await setSiteSettings({ postsPerPage: 10 }, db);
			const postsPerPage = await getSiteSettingWithDb("postsPerPage", db);
			expect(postsPerPage).toBe(10);
		});

		it("should return nested objects", async () => {
			const social = { twitter: "@handle", github: "user" };
			await setSiteSettings({ social }, db);
			const retrieved = await getSiteSettingWithDb("social", db);
			expect(retrieved).toEqual(social);
		});
	});

	describe("getSiteSettings", () => {
		it("should return empty object for no settings", async () => {
			const settings = await getSiteSettingsWithDb(db);
			expect(settings).toEqual({});
		});

		it("should return all settings", async () => {
			await setSiteSettings(
				{
					title: "Test",
					tagline: "Welcome",
					postsPerPage: 10,
				},
				db,
			);

			const settings = await getSiteSettingsWithDb(db);
			expect(settings.title).toBe("Test");
			expect(settings.tagline).toBe("Welcome");
			expect(settings.postsPerPage).toBe(10);
		});

		it("should return partial object for partial settings", async () => {
			await setSiteSettings({ title: "Test" }, db);

			const settings = await getSiteSettingsWithDb(db);
			expect(settings.title).toBe("Test");
			expect(settings.tagline).toBeUndefined();
		});

		it("should handle multiple setting types", async () => {
			await setSiteSettings(
				{
					title: "Test Site",
					postsPerPage: 15,
					dateFormat: "MMMM d, yyyy",
					timezone: "America/New_York",
					social: {
						twitter: "@test",
					},
				},
				db,
			);

			const settings = await getSiteSettingsWithDb(db);
			expect(settings.title).toBe("Test Site");
			expect(settings.postsPerPage).toBe(15);
			expect(settings.dateFormat).toBe("MMMM d, yyyy");
			expect(settings.timezone).toBe("America/New_York");
			expect(settings.social?.twitter).toBe("@test");
		});
	});

	describe("Plugin settings", () => {
		it("should return undefined for unset plugin settings", async () => {
			await expect(getPluginSettingWithDb("demo-plugin", "title", db)).resolves.toBeUndefined();
		});

		it("should return stored plugin settings", async () => {
			const options = new OptionsRepository(db);
			await options.set("plugin:demo-plugin:settings:title", "Hello world");
			await options.set("plugin:demo-plugin:settings:enabled", true);

			await expect(getPluginSettingWithDb("demo-plugin", "title", db)).resolves.toBe("Hello world");
			await expect(getPluginSettingsWithDb("demo-plugin", db)).resolves.toEqual({
				title: "Hello world",
				enabled: true,
			});
		});

		it("treats wildcard characters in plugin IDs as literal prefix text", async () => {
			const options = new OptionsRepository(db);
			await options.set("plugin:alpha%beta:settings:title", "literal-percent");
			await options.set("plugin:alphaxbeta:settings:title", "wrong-percent-match");
			await options.set("plugin:alpha_beta:settings:title", "literal-underscore");
			await options.set("plugin:alphazbeta:settings:title", "wrong-underscore-match");

			await expect(getPluginSettingsWithDb("alpha%beta", db)).resolves.toEqual({
				title: "literal-percent",
			});
			await expect(getPluginSettingsWithDb("alpha_beta", db)).resolves.toEqual({
				title: "literal-underscore",
			});
		});
	});

	describe("Media references", () => {
		it("should store logo without URL", async () => {
			await setSiteSettings(
				{
					logo: { mediaId: "med_123", alt: "Logo" },
				},
				db,
			);

			// When retrieved without storage, should return mediaId but no URL
			const logo = await getSiteSettingWithDb("logo", db, null);
			expect(logo?.mediaId).toBe("med_123");
			expect(logo?.alt).toBe("Logo");
		});

		it("should store favicon without URL", async () => {
			await setSiteSettings(
				{
					favicon: { mediaId: "med_456" },
				},
				db,
			);

			const favicon = await getSiteSettingWithDb("favicon", db, null);
			expect(favicon?.mediaId).toBe("med_456");
		});
	});
});

/**
 * Build an in-memory db with a query counter wired into Kysely's `log`
 * hook. Lets the cache tests assert "no DB query was issued" without
 * mocking out the repository layer (real DB, real SQL, real round-trip).
 */
async function setupCountingDb(): Promise<{
	db: Kysely<Database>;
	queries: string[];
	reset: () => void;
}> {
	const sqlite = new BetterSqlite3(":memory:");
	const queries: string[] = [];
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: sqlite }),
		log: (event) => {
			if (event.level === "query") queries.push(event.query.sql);
		},
	});
	await runMigrations(db);
	return { db, queries, reset: () => queries.splice(0, queries.length) };
}

describe("Site Settings caching", () => {
	beforeEach(() => {
		invalidateSiteSettingsCache();
	});

	it("getSiteSetting() does not hit the DB after getSiteSettings() in the same request", async () => {
		const { db, queries, reset } = await setupCountingDb();
		await setSiteSettings({ title: "Site", seo: { titleSeparator: " — " } }, db);

		await runWithContext({ editMode: false, db }, async () => {
			reset();
			const all = await getSiteSettings();
			expect(all.title).toBe("Site");
			const optionsQueriesAfterAll = queries.filter((q) => q.includes("options")).length;

			const seo = await getSiteSetting("seo");
			expect(seo?.titleSeparator).toBe(" — ");
			const optionsQueriesAfterSeo = queries.filter((q) => q.includes("options")).length;

			expect(optionsQueriesAfterSeo).toBe(optionsQueriesAfterAll);
		});
	});

	it("globalThis cache survives across requests within an isolate", async () => {
		const { db, queries, reset } = await setupCountingDb();
		await setSiteSettings({ title: "Cached Site" }, db);

		await runWithContext({ editMode: false, db }, async () => {
			const first = await getSiteSettings();
			expect(first.title).toBe("Cached Site");
		});

		reset();

		await runWithContext({ editMode: false, db }, async () => {
			const second = await getSiteSettings();
			expect(second.title).toBe("Cached Site");
		});

		const optionsQueries = queries.filter((q) => q.includes("options"));
		expect(optionsQueries).toEqual([]);
	});

	it("setSiteSettings() invalidates the globalThis cache", async () => {
		const { db, queries, reset } = await setupCountingDb();
		await setSiteSettings({ title: "Original" }, db);

		await runWithContext({ editMode: false, db }, async () => {
			const before = await getSiteSettings();
			expect(before.title).toBe("Original");
		});

		await setSiteSettings({ title: "Updated" }, db);

		reset();

		await runWithContext({ editMode: false, db }, async () => {
			const after = await getSiteSettings();
			expect(after.title).toBe("Updated");
		});

		const prefixScans = queries.filter((q) => q.includes("LIKE") && q.includes("options"));
		expect(prefixScans.length).toBe(1);
	});

	it("invalidateSiteSettingsCache() drops the cached value", async () => {
		const { db, queries, reset } = await setupCountingDb();
		await setSiteSettings({ title: "First" }, db);

		await runWithContext({ editMode: false, db }, async () => {
			await getSiteSettings();
		});

		await db
			.updateTable("options")
			.set({ value: JSON.stringify("Second") })
			.where("name", "=", "site:title")
			.execute();

		reset();
		invalidateSiteSettingsCache();

		await runWithContext({ editMode: false, db }, async () => {
			const after = await getSiteSettings();
			expect(after.title).toBe("Second");
		});

		const prefixScans = queries.filter((q) => q.includes("LIKE") && q.includes("options"));
		expect(prefixScans.length).toBe(1);
	});
});
