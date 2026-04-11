import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import {
	getPluginSettingWithDb,
	getPluginSettingsWithDb,
	getSiteSettingWithDb,
	getSiteSettingsWithDb,
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
