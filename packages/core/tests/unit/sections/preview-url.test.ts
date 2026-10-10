import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { INTERNAL_MEDIA_PREFIX } from "../../../src/media/normalize.js";
import {
	getSectionById,
	getSectionWithDb,
	getSectionsWithDb,
} from "../../../src/sections/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const STORAGE_KEY = "01JSECTIONPREVIEW000000000.png";

describe("section preview URL", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const now = new Date().toISOString();
		await db
			.insertInto("media")
			.values({
				id: "media-section-preview",
				filename: "hero-preview.png",
				mime_type: "image/png",
				storage_key: STORAGE_KEY,
				status: "ready",
			})
			.execute();
		await db
			.insertInto("_emdash_sections")
			.values([
				{
					id: "section-with-preview",
					slug: "hero-with-preview",
					title: "Hero with preview",
					description: null,
					keywords: null,
					content: JSON.stringify([]),
					preview_media_id: "media-section-preview",
					source: "user",
					theme_id: null,
					created_at: now,
					updated_at: now,
				},
				{
					id: "section-without-preview",
					slug: "hero-without-preview",
					title: "Hero without preview",
					description: null,
					keywords: null,
					content: JSON.stringify([]),
					preview_media_id: null,
					source: "user",
					theme_id: null,
					created_at: now,
					updated_at: now,
				},
			])
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("points at the media file route the site serves", async () => {
		const section = await getSectionWithDb("hero-with-preview", db);

		expect(section?.previewUrl).toBe(`${INTERNAL_MEDIA_PREFIX}${STORAGE_KEY}`);
	});

	it("uses the same route when read by id and in lists", async () => {
		const byId = await getSectionById("section-with-preview", db);
		const list = await getSectionsWithDb(db);
		const listed = list.items.find((section) => section.slug === "hero-with-preview");

		expect(byId?.previewUrl).toBe(`${INTERNAL_MEDIA_PREFIX}${STORAGE_KEY}`);
		expect(listed?.previewUrl).toBe(`${INTERNAL_MEDIA_PREFIX}${STORAGE_KEY}`);
	});

	it("encodes a folder-style storage key segment by segment", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("media")
			.values({
				id: "media-section-preview-folder",
				filename: "hero preview.png",
				mime_type: "image/png",
				storage_key: "sections/hero preview#1.png",
				status: "ready",
			})
			.execute();
		await db
			.insertInto("_emdash_sections")
			.values({
				id: "section-folder-preview",
				slug: "hero-folder-preview",
				title: "Hero with folder preview",
				description: null,
				keywords: null,
				content: JSON.stringify([]),
				preview_media_id: "media-section-preview-folder",
				source: "user",
				theme_id: null,
				created_at: now,
				updated_at: now,
			})
			.execute();

		const section = await getSectionWithDb("hero-folder-preview", db);

		expect(section?.previewUrl).toBe(`${INTERNAL_MEDIA_PREFIX}sections/hero%20preview%231.png`);
	});

	it("leaves the preview URL unset when the section has no preview image", async () => {
		const section = await getSectionWithDb("hero-without-preview", db);

		expect(section?.previewUrl).toBeUndefined();
	});
});
