import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection, getLiveEntry } from "astro:content";

/**
 * Visual editing on list pages.
 *
 * `getEmDashCollection` used to route every read through `loadCollectionCached`,
 * which reduces entries to a JSON snapshot and rebuilds them with
 * `reviveEntry` — re-attaching the no-op `edit` proxy. The real proxy built in
 * `getEmDashCollectionUncached` was therefore unreachable through the public
 * API, and `{...entry.edit.title}` rendered no annotation on any list page.
 */
describe("getEmDashCollection edit proxy", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.mocked(getLiveCollection).mockReset();
		vi.mocked(getLiveEntry).mockReset();
	});

	async function seedPost(title: string) {
		const result = await handleContentCreate(db, "post", { data: { title }, status: "published" });
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	function mockLoaders(item: { id: string; slug: string }, title: string) {
		const entry = {
			id: item.slug,
			data: { id: item.id, title, status: "published" },
		};
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: [entry],
			error: undefined,
			cacheHint: {},
		} as never);
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry,
			error: undefined,
			cacheHint: {},
		} as never);
	}

	it("annotates fields in edit mode, matching getEmDashEntry", async () => {
		const item = await seedPost("Hello");
		mockLoaders(item, "Hello");

		const { collection, entry } = await runWithContext({ editMode: true, db }, async () => {
			const list = await getEmDashCollection("post");
			const single = await getEmDashEntry("post", item.slug);
			return { collection: list.entries[0], entry: single.entry };
		});

		const annotation = { ...collection!.edit.title };
		expect(annotation).toHaveProperty("data-emdash-ref");
		expect(JSON.parse(annotation["data-emdash-ref"]!)).toMatchObject({
			collection: "post",
			id: item.id,
			field: "title",
		});

		// The two read paths must agree — a field editable on a detail page is
		// editable in a list, and vice versa.
		expect({ ...entry!.edit.title }).toEqual(annotation);
	});

	it("emits no annotations outside edit mode", async () => {
		const item = await seedPost("Hello");
		mockLoaders(item, "Hello");

		const collection = await runWithContext({ editMode: false, db }, async () => {
			const list = await getEmDashCollection("post");
			return list.entries[0];
		});

		expect({ ...collection!.edit.title }).toEqual({});
		expect(Object.keys(collection!.edit)).toEqual([]);
	});
});
