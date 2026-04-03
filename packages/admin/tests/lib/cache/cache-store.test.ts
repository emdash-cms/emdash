/**
 * Tests for the low-level cache store operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
	clearStore,
	deleteCached,
	getAllByIndex,
	getAllCached,
	getCached,
	pruneExpired,
	putCached,
	putManyCached,
	TTL,
} from "../../../src/lib/cache/cache-store.js";
import { deleteDatabase, getDB } from "../../../src/lib/cache/db.js";

describe("cache-store", () => {
	beforeEach(async () => {
		// Ensure a fresh database for each test
		await deleteDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await deleteDatabase();
	});

	describe("TTL", () => {
		it("defines SINGLETON as 24 hours", () => {
			expect(TTL.SINGLETON).toBe(24 * 60 * 60 * 1000);
		});

		it("defines ENTITY as 7 days", () => {
			expect(TTL.ENTITY).toBe(7 * 24 * 60 * 60 * 1000);
		});
	});

	describe("getCached / putCached", () => {
		it("returns undefined for missing key", async () => {
			const result = await getCached("singletons", "nonexistent");
			expect(result).toBeUndefined();
		});

		it("stores and retrieves a singleton", async () => {
			const data = { title: "My Site", url: "https://example.com" };
			await putCached("singletons", "settings", data);

			const result = await getCached("singletons", "settings");
			expect(result).toEqual(data);
		});

		it("stores and retrieves an entity with extra metadata", async () => {
			const item = { id: "item-1", title: "Test Post", slug: "test-post" };
			await putCached("content", "item-1", item, { type: "posts", updatedAt: "2026-01-01" });

			const result = await getCached("content", "item-1");
			expect(result).toEqual(item);
		});

		it("returns undefined for expired singleton entries", async () => {
			const data = { key: "value" };
			await putCached("singletons", "old", data);

			// Manually overwrite the cachedAt to simulate expiry
			const db = await getDB();
			await db.put("singletons", { data, cachedAt: Date.now() - TTL.SINGLETON - 1000 }, "old");

			const result = await getCached("singletons", "old");
			expect(result).toBeUndefined();
		});

		it("returns undefined for expired entity entries", async () => {
			const item = { id: "expired-1", title: "Old" };
			await putCached("menus", "expired-1", item);

			// Manually overwrite cachedAt
			const db = await getDB();
			const tx = db.transaction("menus", "readwrite");
			await tx.store.put({ data: item, cachedAt: Date.now() - TTL.ENTITY - 1000 });
			await tx.done;

			const result = await getCached("menus", "expired-1");
			expect(result).toBeUndefined();
		});

		it("overwrites existing data on repeated put", async () => {
			await putCached("singletons", "manifest", { version: 1 });
			await putCached("singletons", "manifest", { version: 2 });

			const result = await getCached<{ version: number }>("singletons", "manifest");
			expect(result).toEqual({ version: 2 });
		});
	});

	describe("putManyCached", () => {
		it("stores multiple items in one transaction", async () => {
			const items = [
				{ key: "u1", data: { id: "u1", name: "Alice" } },
				{ key: "u2", data: { id: "u2", name: "Bob" } },
				{ key: "u3", data: { id: "u3", name: "Charlie" } },
			];
			await putManyCached("users", items);

			const r1 = await getCached("users", "u1");
			const r2 = await getCached("users", "u2");
			const r3 = await getCached("users", "u3");
			expect(r1).toEqual({ id: "u1", name: "Alice" });
			expect(r2).toEqual({ id: "u2", name: "Bob" });
			expect(r3).toEqual({ id: "u3", name: "Charlie" });
		});

		it("does nothing for empty array", async () => {
			// Should not throw
			await putManyCached("users", []);
		});
	});

	describe("getAllCached", () => {
		it("returns all non-expired records", async () => {
			await putManyCached("users", [
				{ key: "u1", data: { id: "u1", name: "Alice" } },
				{ key: "u2", data: { id: "u2", name: "Bob" } },
			]);

			const results = await getAllCached<{ id: string; name: string }>("users");
			expect(results).toHaveLength(2);
			expect(results.map((r) => r.name).toSorted()).toEqual(["Alice", "Bob"]);
		});

		it("filters out expired records", async () => {
			await putManyCached("users", [{ key: "u1", data: { id: "u1", name: "Fresh" } }]);

			// Manually insert an expired record
			const db = await getDB();
			const tx = db.transaction("users", "readwrite");
			await tx.store.put({
				data: { id: "u2", name: "Expired" },
				cachedAt: Date.now() - TTL.ENTITY - 1000,
			});
			await tx.done;

			const results = await getAllCached<{ id: string; name: string }>("users");
			expect(results).toHaveLength(1);
			expect(results[0]!.name).toBe("Fresh");
		});

		it("returns empty array for empty store", async () => {
			const results = await getAllCached("menus");
			expect(results).toEqual([]);
		});
	});

	describe("getAllByIndex", () => {
		it("returns items matching the index value", async () => {
			await putManyCached("content", [
				{
					key: "p1",
					data: { id: "p1", title: "Post 1" },
					extra: { type: "posts", updatedAt: "2026-01-01" },
				},
				{
					key: "p2",
					data: { id: "p2", title: "Post 2" },
					extra: { type: "posts", updatedAt: "2026-01-02" },
				},
				{
					key: "pg1",
					data: { id: "pg1", title: "Page 1" },
					extra: { type: "pages", updatedAt: "2026-01-01" },
				},
			]);

			const posts = await getAllByIndex<{ id: string; title: string }>("content", "type", "posts");
			expect(posts).toHaveLength(2);
			expect(posts.map((p) => p.title).toSorted()).toEqual(["Post 1", "Post 2"]);

			const pages = await getAllByIndex<{ id: string; title: string }>("content", "type", "pages");
			expect(pages).toHaveLength(1);
			expect(pages[0]!.title).toBe("Page 1");
		});

		it("returns empty array for unmatched index value", async () => {
			const results = await getAllByIndex("content", "type", "nonexistent");
			expect(results).toEqual([]);
		});
	});

	describe("deleteCached", () => {
		it("deletes a record from a store", async () => {
			await putCached("singletons", "manifest", { version: 1 });
			expect(await getCached("singletons", "manifest")).toBeDefined();

			await deleteCached("singletons", "manifest");
			expect(await getCached("singletons", "manifest")).toBeUndefined();
		});

		it("does not throw for missing key", async () => {
			// Should not throw
			await deleteCached("singletons", "nonexistent");
		});
	});

	describe("clearStore", () => {
		it("removes all records from a store", async () => {
			await putManyCached("users", [
				{ key: "u1", data: { id: "u1", name: "Alice" } },
				{ key: "u2", data: { id: "u2", name: "Bob" } },
			]);
			expect(await getAllCached("users")).toHaveLength(2);

			await clearStore("users");
			expect(await getAllCached("users")).toHaveLength(0);
		});
	});

	describe("pruneExpired", () => {
		it("removes expired records from entity stores", async () => {
			// Insert a fresh record
			await putManyCached("users", [{ key: "u1", data: { id: "u1", name: "Fresh" } }]);

			// Insert an expired record directly
			const db = await getDB();
			const tx = db.transaction("users", "readwrite");
			await tx.store.put({
				data: { id: "u2", name: "Expired" },
				cachedAt: Date.now() - TTL.ENTITY - 1000,
			});
			await tx.done;

			// Verify both exist before pruning
			const allBefore = await db.getAll("users");
			expect(allBefore).toHaveLength(2);

			await pruneExpired();

			const allAfter = await db.getAll("users");
			expect(allAfter).toHaveLength(1);
		});

		it("removes expired singletons", async () => {
			await putCached("singletons", "fresh", { value: "new" });

			const db = await getDB();
			await db.put(
				"singletons",
				{ data: { value: "old" }, cachedAt: Date.now() - TTL.SINGLETON - 1000 },
				"expired",
			);

			await pruneExpired();

			expect(await getCached("singletons", "fresh")).toBeDefined();
			expect(await getCached("singletons", "expired")).toBeUndefined();
		});

		it("does not throw on empty stores", async () => {
			// Should not throw
			await pruneExpired();
		});
	});
});
