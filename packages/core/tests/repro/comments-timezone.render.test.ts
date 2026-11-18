import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import Comments from "../../src/components/Comments.astro";
import { CommentRepository } from "../../src/database/repositories/comment.js";
import { OptionsRepository } from "../../src/database/repositories/options.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { invalidateSiteSettingsCache } from "../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

let db: Kysely<Database>;
const timestamp = "2026-06-01T23:57:00.000Z";

beforeEach(async () => {
	db = await setupTestDatabase();
	invalidateSiteSettingsCache();
	await new SchemaRegistry(db).createCollection({
		slug: "notes",
		label: "Notes",
		labelSingular: "Note",
		commentsEnabled: true,
	});
	const repository = new CommentRepository(db);
	const comment = await repository.create({
		collection: "notes",
		contentId: "note-1",
		authorName: "Ada",
		authorEmail: "ada@example.com",
		body: "Hello from Tokyo",
		status: "approved",
	});
	await repository.create({
		collection: "notes",
		contentId: "note-1",
		parentId: comment.id,
		authorName: "Grace",
		authorEmail: "grace@example.com",
		body: "A reply",
		status: "approved",
	});
	await db.updateTable("_emdash_comments").set({ created_at: timestamp }).execute();
});

afterEach(async () => {
	invalidateSiteSettingsCache();
	await teardownTestDatabase(db);
});

async function renderDates(timezone?: string, locale?: string) {
	if (timezone !== undefined) await new OptionsRepository(db).set("site:timezone", timezone);
	const container = await AstroContainer.create();
	const html = await runWithContext({ editMode: false, db }, () =>
		container.renderToString(Comments, {
			props: { collection: "notes", contentId: "note-1", threaded: true, locale },
		}),
	);
	return Array.from(
		html.matchAll(/<time\b[^>]*datetime="([^"]+)"[^>]*>([^<]*)<\/time>/g),
		(match) => ({ datetime: match[1], text: match[2].trim() }),
	);
}

describe("Comments site timezone", () => {
	test("uses Tokyo time for comments and replies, including the next calendar day", async () => {
		expect(await renderDates("Asia/Tokyo")).toEqual([
			{ datetime: timestamp, text: "June 2, 2026 at 8:57 AM" },
			{ datetime: timestamp, text: "June 2, 2026 at 8:57 AM" },
		]);
	});

	test("keeps the explicit date locale while applying the site timezone", async () => {
		const dates = await renderDates("Asia/Tokyo", "de-DE");
		expect(dates.map((date) => date.text)).toEqual([
			"2. Juni 2026 um 8:57",
			"2. Juni 2026 um 8:57",
		]);
	});

	test.each([undefined, "", "Invalid/Timezone"])(
		"defaults %s timezone to UTC",
		async (timezone) => {
			const dates = await renderDates(timezone);
			expect(dates.map((date) => date.text)).toEqual([
				"June 1, 2026 at 11:57 PM",
				"June 1, 2026 at 11:57 PM",
			]);
		},
	);
});
