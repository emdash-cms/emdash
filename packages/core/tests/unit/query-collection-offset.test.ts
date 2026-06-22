import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../src/database/types.js";
import { getEmDashCollection } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
}));

import { getLiveCollection } from "astro:content";

describe("getEmDashCollection offset pagination", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.mocked(getLiveCollection).mockReset();
	});

	function makeEntries(count: number) {
		return Array.from({ length: count }, (_, i) => ({
			id: `slug-${i + 1}`,
			data: {
				id: `db-id-${i + 1}`,
				title: `Post ${i + 1}`,
				createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)).toISOString(),
				status: "published",
			},
		}));
	}

	async function run<T>(fn: () => Promise<T>) {
		return runWithContext({ editMode: false, db }, fn);
	}

	it("forwards offset to the live loader", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: makeEntries(3),
			cacheHint: {},
		} as any);

		await run(() => getEmDashCollection("post", { limit: 20, offset: 40 }));

		expect(getLiveCollection).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getLiveCollection).mock.calls[0]![1]).toMatchObject({ offset: 40 });
	});

	it("reports hasMore=true when the loader returns more than the requested limit", async () => {
		// limit 20 over-fetches as 21; loader returns 21 ⇒ a next page exists.
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: makeEntries(21),
			cacheHint: {},
		} as any);

		const result = await run(() => getEmDashCollection("post", { limit: 20, offset: 0 }));

		expect(result.entries).toHaveLength(20);
		expect(result.hasMore).toBe(true);
	});

	it("reports hasMore=false on the final page", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: makeEntries(5),
			cacheHint: {},
		} as any);

		const result = await run(() => getEmDashCollection("post", { limit: 20, offset: 40 }));

		expect(result.entries).toHaveLength(5);
		expect(result.hasMore).toBe(false);
	});

	it("leaves hasMore undefined when no limit is given", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: makeEntries(5),
			cacheHint: {},
		} as any);

		const result = await run(() => getEmDashCollection("post"));

		expect(result.hasMore).toBeUndefined();
	});

	it("keeps offset out of the request-cache key so different pages don't collide", async () => {
		vi.mocked(getLiveCollection)
			.mockResolvedValueOnce({ entries: makeEntries(20), cacheHint: {} } as any)
			.mockResolvedValueOnce({ entries: makeEntries(20), cacheHint: {} } as any);

		await run(async () => {
			await getEmDashCollection("post", { limit: 20, offset: 0 });
			await getEmDashCollection("post", { limit: 20, offset: 20 });
		});

		expect(getLiveCollection).toHaveBeenCalledTimes(2);
		const offsets = vi.mocked(getLiveCollection).mock.calls.map((c) => (c[1] as any).offset);
		expect(offsets).toEqual([0, 20]);
	});
});
