import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("Loader offset pagination", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function createPublishedPost(title: string) {
		const result = await handleContentCreate(db, "post", {
			data: { title },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	async function seedAlphabet() {
		// Deterministic order regardless of created_at second-resolution.
		const titles = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
		for (const title of titles) {
			await createPublishedPost(title);
		}
	}

	it("skips the first `offset` rows", async () => {
		await seedAlphabet();
		const loader = emdashLoader();

		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", limit: 2, offset: 2, orderBy: { title: "asc" } },
			}),
		);

		expect(result.entries!.map((e) => e.data.title)).toEqual(["Charlie", "Delta"]);
	});

	it("renders disjoint numbered pages with limit + offset", async () => {
		await seedAlphabet();
		const loader = emdashLoader();
		const perPage = 2;

		const pageTitles: string[][] = [];
		for (let page = 1; page <= 3; page++) {
			const result = await runWithContext({ editMode: false, db }, () =>
				loader.loadCollection!({
					filter: {
						type: "post",
						limit: perPage,
						offset: (page - 1) * perPage,
						orderBy: { title: "asc" },
					},
				}),
			);
			pageTitles.push(result.entries!.map((e) => String(e.data.title)));
		}

		expect(pageTitles).toEqual([["Alpha", "Bravo"], ["Charlie", "Delta"], ["Echo"]]);
	});

	it("returns an empty page when offset is past the end", async () => {
		await seedAlphabet();
		const loader = emdashLoader();

		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", limit: 2, offset: 100, orderBy: { title: "asc" } },
			}),
		);

		expect(result.entries).toHaveLength(0);
	});

	it("ignores offset when a cursor is also supplied (cursor wins)", async () => {
		await seedAlphabet();
		const loader = emdashLoader();

		const page1 = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", limit: 2, orderBy: { title: "asc" } },
			}),
		);
		expect(page1.entries!.map((e) => e.data.title)).toEqual(["Alpha", "Bravo"]);

		// cursor continues after Bravo; offset must be ignored, not stacked.
		const page2 = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					limit: 2,
					cursor: page1.nextCursor,
					offset: 2,
					orderBy: { title: "asc" },
				},
			}),
		);
		expect(page2.entries!.map((e) => e.data.title)).toEqual(["Charlie", "Delta"]);
	});
});
