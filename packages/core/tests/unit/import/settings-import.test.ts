/**
 * Tests for site settings import:
 * - writes the real `site:*` options read by getSiteSettings()
 * - overwrite semantics (seeded titles are replaced during migration)
 * - logo/favicon applied as media references
 * - parseSiteSettingsFromPlugin field mapping
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importSiteSettings, parseSiteSettingsFromPlugin } from "../../../src/import/settings.js";
import { getSiteSettingsWithDb } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

let db: Awaited<ReturnType<typeof setupTestDatabase>>;

beforeEach(async () => {
	db = await setupTestDatabase();
});

afterEach(async () => {
	await teardownTestDatabase(db);
});

describe("importSiteSettings", () => {
	it("writes settings that getSiteSettings() actually reads", async () => {
		const result = await importSiteSettings({ title: "WP Blog", tagline: "From WP" }, db, true);

		expect(result.applied).toEqual(["title", "tagline"]);
		const settings = await getSiteSettingsWithDb(db);
		expect(settings.title).toBe("WP Blog");
		expect(settings.tagline).toBe("From WP");
	});

	it("overwrites seed placeholders when overwrite=true, skips when false", async () => {
		await importSiteSettings({ title: "My Blog" }, db, true);

		const skipped = await importSiteSettings({ title: "Real Title" }, db, false);
		expect(skipped.skipped).toEqual(["title"]);
		expect((await getSiteSettingsWithDb(db)).title).toBe("My Blog");

		const overwritten = await importSiteSettings({ title: "Real Title" }, db, true);
		expect(overwritten.applied).toEqual(["title"]);
		expect((await getSiteSettingsWithDb(db)).title).toBe("Real Title");
	});

	it("applies logo/favicon only via resolved media IDs", async () => {
		const withoutMedia = await importSiteSettings(
			{ logo: { url: "https://wp.example/logo.png", id: 5 } },
			db,
			true,
		);
		expect(withoutMedia.applied).toEqual([]);

		await importSiteSettings({ logo: { url: "https://wp.example/logo.png", id: 5 } }, db, true, {
			logoMediaId: "01MEDIA",
			faviconMediaId: "02MEDIA",
		});
		const settings = await getSiteSettingsWithDb(db);
		expect(settings.logo?.mediaId).toBe("01MEDIA");
		expect(settings.favicon?.mediaId).toBe("02MEDIA");
	});
});

describe("parseSiteSettingsFromPlugin", () => {
	it("maps WP option keys and ignores empty values", () => {
		const parsed = parseSiteSettingsFromPlugin({
			blogname: "WP Blog",
			blogdescription: "",
			custom_logo: 12,
			custom_logo_url: "https://wp.example/logo.png",
		});

		expect(parsed.title).toBe("WP Blog");
		expect(parsed.tagline).toBeUndefined();
		expect(parsed.logo).toEqual({ url: "https://wp.example/logo.png", id: 12 });
		expect(parsed.favicon).toBeUndefined();
	});
});
