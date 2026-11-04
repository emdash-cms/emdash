import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import { StorageQueryError } from "../../../src/plugins/storage-query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface Doc {
	seq?: number;
	createdAt: string;
}

/** Walk every page, returning the ids seen in order. */
async function drain(
	repo: PluginStorageRepository<Doc>,
	opts: { orderBy?: Record<string, "asc" | "desc">; limit: number },
): Promise<string[]> {
	const seen: string[] = [];
	let cursor: string | undefined;
	// Bound the loop so a pagination bug fails the assertion instead of hanging.
	for (let page = 0; page < 20; page++) {
		const res = await repo.query({ ...opts, cursor });
		seen.push(...res.items.map((i) => i.id));
		if (!res.hasMore || !res.cursor) break;
		cursor = res.cursor;
	}
	return seen;
}

describe("PluginStorageRepository.query() cursor pagination", () => {
	let db: Kysely<Database>;
	let repo: PluginStorageRepository<Doc>;
	const TOTAL = 12;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new PluginStorageRepository<Doc>(db, "test-plugin", "items", ["seq", "createdAt"]);
		for (let i = 0; i < TOTAL; i++) {
			const stamp = `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`;
			await repo.put(`doc-${String(i).padStart(2, "0")}`, { seq: i, createdAt: stamp });
		}
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns every row exactly once with the default ordering", async () => {
		const seen = await drain(repo, { limit: 5 });
		expect(new Set(seen).size).toBe(TOTAL);
		expect(seen).toHaveLength(TOTAL);
	});

	it("returns every row exactly once ordering by an indexed field ascending", async () => {
		const seen = await drain(repo, { orderBy: { seq: "asc" }, limit: 5 });
		expect(new Set(seen).size).toBe(TOTAL);
		expect(seen).toHaveLength(TOTAL);
	});

	it("returns every row exactly once ordering by an indexed field descending", async () => {
		const seen = await drain(repo, { orderBy: { seq: "desc" }, limit: 5 });
		expect(new Set(seen).size).toBe(TOTAL);
		expect(seen).toHaveLength(TOTAL);
	});

	it("orders descending pages newest-first across the whole walk", async () => {
		const seen = await drain(repo, { orderBy: { seq: "desc" }, limit: 5 });
		const expected = Array.from(
			{ length: TOTAL },
			(_, i) => `doc-${String(TOTAL - 1 - i).padStart(2, "0")}`,
		);
		expect(seen).toEqual(expected);
	});

	it("returns every row exactly once when sort order is uncorrelated with insert order", async () => {
		// Wipe and re-insert so `seq` runs opposite to created_at.
		for (let i = 0; i < TOTAL; i++) await repo.delete(`doc-${String(i).padStart(2, "0")}`);
		for (let i = 0; i < TOTAL; i++) {
			await repo.put(`rev-${String(i).padStart(2, "0")}`, {
				seq: TOTAL - i,
				createdAt: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
			});
		}
		const seen = await drain(repo, { orderBy: { seq: "asc" }, limit: 5 });
		expect(new Set(seen).size).toBe(TOTAL);
		expect(seen).toHaveLength(TOTAL);
	});

	it("throws rather than paging wrongly when orderBy directions are mixed", async () => {
		const first = await repo.query({ orderBy: { seq: "desc" }, limit: 5 });
		expect(first.cursor).toBeDefined();
		await expect(
			repo.query({ orderBy: { seq: "desc", createdAt: "asc" }, cursor: first.cursor, limit: 5 }),
		).rejects.toThrow(StorageQueryError);
	});

	it("still pages every row when documents omit the sorted field entirely", async () => {
		for (let i = 0; i < TOTAL; i++) await repo.delete(`doc-${String(i).padStart(2, "0")}`);
		// Half the documents have no `seq` key at all, so the sort expression is NULL.
		for (let i = 0; i < TOTAL; i++) {
			const doc: Doc =
				i % 2 === 0
					? { createdAt: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }
					: { seq: i, createdAt: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` };
			await repo.put(`nul-${String(i).padStart(2, "0")}`, doc);
		}
		for (const direction of ["asc", "desc"] as const) {
			const seen = await drain(repo, { orderBy: { seq: direction }, limit: 3 });
			expect({ direction, unique: new Set(seen).size, total: seen.length }).toEqual({
				direction,
				unique: TOTAL,
				total: TOTAL,
			});
		}
	});
});
