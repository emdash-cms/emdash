import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import {
	getPluginSettingWithDb,
	getPluginSettingsWithDb,
	getSiteSettingWithDb,
	getSiteSettingsWithDb,
	setSiteSettings,
} from "../../../src/settings/index.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

function fakeStorage(publicUrl: string): Storage {
	return {
		upload: async () => ({ key: "", url: "", size: 0 }),
		download: async () => {
			throw new Error("not implemented");
		},
		delete: async () => {},
		exists: async () => false,
		list: async () => ({ files: [] }),
		getSignedUploadUrl: async () => {
			throw new Error("not implemented");
		},
		getPublicUrl: (key: string) => `${publicUrl.replace(/\/$/, "")}/${key}`,
	};
}

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

		it("resolves logo url via storage.getPublicUrl when storage is provided", async () => {
			const mediaRepo = new MediaRepository(db);
			const media = await mediaRepo.create({
				filename: "logo.png",
				mimeType: "image/png",
				storageKey: "01J-logo.png",
			});
			await setSiteSettings({ logo: { mediaId: media.id, alt: "Logo" } }, db);

			const storage = fakeStorage("https://cdn.example.com");
			const logo = await getSiteSettingWithDb("logo", db, storage);

			expect(logo?.url).toBe("https://cdn.example.com/01J-logo.png");
		});

		it("falls back to /_emdash/api/media/file when no storage is provided", async () => {
			const mediaRepo = new MediaRepository(db);
			const media = await mediaRepo.create({
				filename: "logo.png",
				mimeType: "image/png",
				storageKey: "01J-fallback.png",
			});
			await setSiteSettings({ logo: { mediaId: media.id } }, db);

			const logo = await getSiteSettingWithDb("logo", db, null);

			expect(logo?.url).toBe("/_emdash/api/media/file/01J-fallback.png");
		});

		it("resolves logo url through getSiteSettingsWithDb when storage is provided", async () => {
			const mediaRepo = new MediaRepository(db);
			const media = await mediaRepo.create({
				filename: "logo.png",
				mimeType: "image/png",
				storageKey: "01J-bulk.png",
			});
			await setSiteSettings({ logo: { mediaId: media.id } }, db);

			const storage = fakeStorage("https://cdn.example.com/");
			const settings = await getSiteSettingsWithDb(db, storage);

			expect(settings.logo?.url).toBe("https://cdn.example.com/01J-bulk.png");
		});
	});
});
