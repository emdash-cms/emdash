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

describe("getEmDashCollection nextCursor synthesis (Astro 6 direct path)", () => {
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
				createdAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
				status: "published",
			},
		}));
	}

	it("synthesizes nextCursor when Astro returns one more entry than the requested limit", async () => {
		const entries = makeEntries(21);
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries,
			error: undefined,
			cacheHint: {},
		} as any);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { limit: 20, orderBy: { created_at: "desc" } }),
		);

		expect(result.entries).toHaveLength(20);
		expect(result.nextCursor).toBeTruthy();
		expect(typeof result.nextCursor).toBe("string");
	});

	it("does not return nextCursor when results fit within the requested limit", async () => {
		const entries = makeEntries(5);
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries,
			error: undefined,
			cacheHint: {},
		} as any);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { limit: 20, orderBy: { created_at: "desc" } }),
		);

		expect(result.entries).toHaveLength(5);
		expect(result.nextCursor).toBeUndefined();
	});

	it("synthesizes nextCursor for cursor-paginated calls when more results exist", async () => {
		const entries = makeEntries(4);
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries,
			error: undefined,
			cacheHint: {},
		} as any);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", {
				limit: 3,
				cursor: "abc",
				orderBy: { created_at: "desc" },
			}),
		);

		expect(result.entries).toHaveLength(3);
		expect(result.nextCursor).toBeTruthy();
		expect(typeof result.nextCursor).toBe("string");
	});

	it("returns exact limit with no nextCursor when the total matches the limit exactly", async () => {
		const entries = makeEntries(20);
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries,
			error: undefined,
			cacheHint: {},
		} as any);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { limit: 20, orderBy: { created_at: "desc" } }),
		);

		expect(result.entries).toHaveLength(20);
		expect(result.nextCursor).toBeUndefined();
	});
});
