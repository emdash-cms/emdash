import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { bucketFilter, getEmDashEntry, sliceCollectionResult } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveEntry: vi.fn(),
}));

import { getLiveEntry } from "astro:content";

describe("getEmDashCollection limit bucketing", () => {
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

	it("a sliced bucket fetch produces the same entries and nextCursor as a direct loader call at the same limit", async () => {
		for (let i = 1; i <= 7; i++) await createPublishedPost(`Post ${i}`);

		const loader = emdashLoader();
		const direct = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", limit: 4 } }),
		);
		expect(direct.entries).toHaveLength(4);
		expect(direct.nextCursor).toBeTruthy();

		const bucketed = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", limit: 10 } }),
		);
		expect(bucketed.entries).toHaveLength(7);
		const sliced = sliceCollectionResult(bucketed, 4, undefined);

		expect(sliced.entries.map((e) => e.id)).toEqual(direct.entries.map((e) => e.id));
		expect(sliced.nextCursor).toBe(direct.nextCursor);
	});

	it("bucketFilter raises small limits and leaves large ones alone", () => {
		expect(bucketFilter(undefined)).toEqual({ fetchFilter: undefined, requestedLimit: undefined });
		expect(bucketFilter({ limit: 4 })).toEqual({ fetchFilter: { limit: 10 }, requestedLimit: 4 });
		expect(bucketFilter({ limit: 9 })).toEqual({ fetchFilter: { limit: 10 }, requestedLimit: 9 });
		expect(bucketFilter({ limit: 10 })).toEqual({
			fetchFilter: { limit: 10 },
			requestedLimit: undefined,
		});
		expect(bucketFilter({ limit: 50 })).toEqual({
			fetchFilter: { limit: 50 },
			requestedLimit: undefined,
		});
		// cursor-paginated calls bypass bucketing — pagination contract requires honouring the limit
		expect(bucketFilter({ limit: 4, cursor: "abc" })).toEqual({
			fetchFilter: { limit: 4, cursor: "abc" },
			requestedLimit: undefined,
		});
		// offset-paginated calls bypass bucketing for the same reason
		expect(bucketFilter({ limit: 4, offset: 8 })).toEqual({
			fetchFilter: { limit: 4, offset: 8 },
			requestedLimit: undefined,
		});
	});

	it("paginating from a slice-produced cursor returns the correct next page", async () => {
		for (let i = 1; i <= 7; i++) await createPublishedPost(`Post ${i}`);

		const loader = emdashLoader();
		const bucketed = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", limit: 10 } }),
		);
		const firstPage = sliceCollectionResult(bucketed, 4, undefined);
		expect(firstPage.entries).toHaveLength(4);
		expect(firstPage.nextCursor).toBeTruthy();

		const secondPage = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", limit: 4, cursor: firstPage.nextCursor },
			}),
		);
		expect(secondPage.entries).toHaveLength(3);

		const allIds = [...firstPage.entries, ...secondPage.entries].map((e) => e.id);
		expect(new Set(allIds).size).toBe(7);
	});
});

describe("getEmDashEntry scheduled visibility", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.mocked(getLiveEntry).mockReset();
	});

	function mockEntry(data: Record<string, unknown>) {
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: {
				id: "scheduled-post",
				data: {
					id: "db-id-1",
					title: "Scheduled post",
					...data,
				},
			},
			error: undefined,
			cacheHint: {},
		} as any);
	}

	async function loadEntry() {
		return runWithContext({ editMode: false, db }, () => getEmDashEntry("post", "scheduled-post"));
	}

	it("returns scheduled entries whose Date scheduledAt has passed", async () => {
		mockEntry({
			status: "scheduled",
			scheduledAt: new Date("2000-01-01T00:00:00.000Z"),
		});

		const { entry } = await loadEntry();

		expect(entry?.id).toBe("scheduled-post");
	});

	it("keeps scheduled entries with a future Date scheduledAt hidden", async () => {
		mockEntry({
			status: "scheduled",
			scheduledAt: new Date("2999-01-01T00:00:00.000Z"),
		});

		const { entry } = await loadEntry();

		expect(entry).toBeNull();
	});

	it("returns scheduled entries whose string scheduledAt has passed", async () => {
		mockEntry({
			status: "scheduled",
			scheduledAt: "2000-01-01T00:00:00.000Z",
		});

		const { entry } = await loadEntry();

		expect(entry?.id).toBe("scheduled-post");
	});

	it("returns published entries regardless of scheduledAt", async () => {
		mockEntry({
			status: "published",
			scheduledAt: new Date("2999-01-01T00:00:00.000Z"),
		});

		const { entry } = await loadEntry();

		expect(entry?.id).toBe("scheduled-post");
	});

	it.each([
		["missing", {}],
		["invalid", { scheduledAt: "not-a-date" }],
	])("keeps scheduled entries with %s scheduledAt hidden", async (_label, scheduledFields) => {
		mockEntry({
			status: "scheduled",
			...scheduledFields,
		});

		const { entry } = await loadEntry();

		expect(entry).toBeNull();
	});
});
