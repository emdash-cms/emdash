import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import { IdentifierError } from "../../../src/database/validate.js";
import { StorageQueryError } from "../../../src/plugins/storage-query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface TestDocument {
	title: string;
	status: string;
	count: number;
	createdAt: string;
}

describe("PluginStorageRepository", () => {
	let db: Kysely<Database>;
	let repo: PluginStorageRepository<TestDocument>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new PluginStorageRepository<TestDocument>(db, "test-plugin", "items", [
			"status",
			"count",
			["status", "createdAt"],
		]);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("get()", () => {
		it("should return null for non-existent document", async () => {
			const result = await repo.get("non-existent");
			expect(result).toBeNull();
		});

		it("should return document after put", async () => {
			const doc: TestDocument = {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			};

			await repo.put("doc1", doc);
			const result = await repo.get("doc1");

			expect(result).toEqual(doc);
		});
	});

	describe("put()", () => {
		it("should store new document", async () => {
			const doc: TestDocument = {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			};

			await repo.put("doc1", doc);

			const result = await repo.get("doc1");
			expect(result).toEqual(doc);
		});

		it("should update existing document", async () => {
			const doc: TestDocument = {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			};

			await repo.put("doc1", doc);

			const updatedDoc = { ...doc, status: "inactive", count: 10 };
			await repo.put("doc1", updatedDoc);

			const result = await repo.get("doc1");
			expect(result).toEqual(updatedDoc);
		});
	});

	describe("putIfAbsent()", () => {
		it("should insert a new document and return true", async () => {
			const doc: TestDocument = {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			};

			const inserted = await repo.putIfAbsent("doc1", doc);
			expect(inserted).toBe(true);

			const result = await repo.get("doc1");
			expect(result).toEqual(doc);
		});

		it("should return false without overwriting an existing document", async () => {
			const doc: TestDocument = {
				title: "Original",
				status: "active",
				count: 1,
				createdAt: "2024-01-01",
			};
			const replacement: TestDocument = {
				...doc,
				title: "Replacement",
				count: 2,
			};

			await repo.put("doc1", doc);
			const inserted = await repo.putIfAbsent("doc1", replacement);
			expect(inserted).toBe(false);

			const result = await repo.get("doc1");
			expect(result).toEqual(doc);
		});
	});

	describe("delete()", () => {
		it("should return false for non-existent document", async () => {
			const result = await repo.delete("non-existent");
			expect(result).toBe(false);
		});

		it("should delete existing document and return true", async () => {
			await repo.put("doc1", {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			});

			const result = await repo.delete("doc1");
			expect(result).toBe(true);

			const doc = await repo.get("doc1");
			expect(doc).toBeNull();
		});
	});

	describe("exists()", () => {
		it("should return false for non-existent document", async () => {
			const result = await repo.exists("non-existent");
			expect(result).toBe(false);
		});

		it("should return true for existing document", async () => {
			await repo.put("doc1", {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			});

			const result = await repo.exists("doc1");
			expect(result).toBe(true);
		});
	});

	describe("getMany()", () => {
		it("should return empty map for empty ids", async () => {
			const result = await repo.getMany([]);
			expect(result.size).toBe(0);
		});

		it("should return only existing documents", async () => {
			await repo.put("doc1", {
				title: "Test 1",
				status: "active",
				count: 1,
				createdAt: "2024-01-01",
			});
			await repo.put("doc2", {
				title: "Test 2",
				status: "active",
				count: 2,
				createdAt: "2024-01-02",
			});

			const result = await repo.getMany(["doc1", "doc2", "doc3"]);

			expect(result.size).toBe(2);
			expect(result.get("doc1")?.title).toBe("Test 1");
			expect(result.get("doc2")?.title).toBe("Test 2");
			expect(result.has("doc3")).toBe(false);
		});
	});

	describe("putMany()", () => {
		it("should handle empty array", async () => {
			await repo.putMany([]);
			// Should not throw
		});

		it("should store multiple documents atomically", async () => {
			await repo.putMany([
				{
					id: "doc1",
					data: {
						title: "Test 1",
						status: "active",
						count: 1,
						createdAt: "2024-01-01",
					},
				},
				{
					id: "doc2",
					data: {
						title: "Test 2",
						status: "inactive",
						count: 2,
						createdAt: "2024-01-02",
					},
				},
			]);

			expect(await repo.exists("doc1")).toBe(true);
			expect(await repo.exists("doc2")).toBe(true);
		});
	});

	describe("deleteMany()", () => {
		it("should return 0 for empty ids", async () => {
			const count = await repo.deleteMany([]);
			expect(count).toBe(0);
		});

		it("should delete multiple documents and return count", async () => {
			await repo.putMany([
				{
					id: "doc1",
					data: {
						title: "Test 1",
						status: "active",
						count: 1,
						createdAt: "2024-01-01",
					},
				},
				{
					id: "doc2",
					data: {
						title: "Test 2",
						status: "active",
						count: 2,
						createdAt: "2024-01-02",
					},
				},
				{
					id: "doc3",
					data: {
						title: "Test 3",
						status: "active",
						count: 3,
						createdAt: "2024-01-03",
					},
				},
			]);

			const count = await repo.deleteMany(["doc1", "doc2"]);

			expect(count).toBe(2);
			expect(await repo.exists("doc1")).toBe(false);
			expect(await repo.exists("doc2")).toBe(false);
			expect(await repo.exists("doc3")).toBe(true);
		});
	});

	describe("query()", () => {
		beforeEach(async () => {
			// Setup test data
			await repo.putMany([
				{
					id: "doc1",
					data: {
						title: "Alpha",
						status: "active",
						count: 5,
						createdAt: "2024-01-01",
					},
				},
				{
					id: "doc2",
					data: {
						title: "Beta",
						status: "active",
						count: 10,
						createdAt: "2024-01-02",
					},
				},
				{
					id: "doc3",
					data: {
						title: "Gamma",
						status: "inactive",
						count: 15,
						createdAt: "2024-01-03",
					},
				},
			]);
		});

		it("should return all documents when no filter", async () => {
			const result = await repo.query();
			expect(result.items).toHaveLength(3);
		});

		it("should filter by equality", async () => {
			const result = await repo.query({
				where: { status: "active" },
			});
			expect(result.items).toHaveLength(2);
			expect(result.items.every((i) => i.data.status === "active")).toBe(true);
		});

		it("should filter by range (gte)", async () => {
			const result = await repo.query({
				where: { count: { gte: 10 } },
			});
			expect(result.items).toHaveLength(2);
			expect(result.items.every((i) => i.data.count >= 10)).toBe(true);
		});

		it("should filter by range (lt)", async () => {
			const result = await repo.query({
				where: { count: { lt: 15 } },
			});
			expect(result.items).toHaveLength(2);
			expect(result.items.every((i) => i.data.count < 15)).toBe(true);
		});

		it("should throw when querying non-indexed field", async () => {
			await expect(
				repo.query({
					where: { title: "Alpha" },
				}),
			).rejects.toThrow(StorageQueryError);
		});

		it("should reject malicious orderBy field names (SQL injection defense)", async () => {
			// Create a repo that declares a malicious index name to bypass the
			// "field must be indexed" check and hit the jsonExtract validation
			const evilRepo = new PluginStorageRepository<TestDocument>(db, "test-plugin", "items", [
				"'); DROP TABLE _plugin_storage--",
			]);

			await expect(
				evilRepo.query({
					orderBy: { "'); DROP TABLE _plugin_storage--": "asc" },
				}),
			).rejects.toThrow(IdentifierError);
		});

		it("should respect limit", async () => {
			const result = await repo.query({ limit: 2 });
			expect(result.items).toHaveLength(2);
		});

		it("should provide cursor for pagination", async () => {
			const result = await repo.query({ limit: 2 });
			expect(result.cursor).toBeDefined();
		});

		it("should not provide cursor when no more results", async () => {
			const result = await repo.query({ limit: 10 });
			expect(result.cursor).toBeUndefined();
		});

		it("should paginate using cursor", async () => {
			const page1 = await repo.query({ limit: 2 });
			expect(page1.items).toHaveLength(2);

			const page2 = await repo.query({ limit: 2, cursor: page1.cursor });
			expect(page2.items).toHaveLength(1);
			expect(page2.cursor).toBeUndefined();

			// Ensure no duplicates
			const allIds = [...page1.items, ...page2.items].map((i) => i.id);
			expect(new Set(allIds).size).toBe(3);
		});
	});

	describe("count()", () => {
		beforeEach(async () => {
			await repo.putMany([
				{
					id: "doc1",
					data: {
						title: "Alpha",
						status: "active",
						count: 5,
						createdAt: "2024-01-01",
					},
				},
				{
					id: "doc2",
					data: {
						title: "Beta",
						status: "active",
						count: 10,
						createdAt: "2024-01-02",
					},
				},
				{
					id: "doc3",
					data: {
						title: "Gamma",
						status: "inactive",
						count: 15,
						createdAt: "2024-01-03",
					},
				},
			]);
		});

		it("should count all documents when no filter", async () => {
			const count = await repo.count();
			expect(count).toBe(3);
		});

		it("should count with filter", async () => {
			const count = await repo.count({ status: "active" });
			expect(count).toBe(2);
		});

		it("should return 0 for no matches", async () => {
			const count = await repo.count({ count: { gt: 100 } });
			expect(count).toBe(0);
		});

		it("should throw when counting on non-indexed field", async () => {
			await expect(repo.count({ title: "Alpha" })).rejects.toThrow(StorageQueryError);
		});
	});

	// Note: v2 API removed async iterator list() in favor of paginated query()
	// Use query() with cursor for iteration

	describe("plugin isolation", () => {
		it("should not see documents from other plugins", async () => {
			const otherRepo = new PluginStorageRepository<TestDocument>(db, "other-plugin", "items", [
				"status",
			]);

			await repo.put("doc1", {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			});

			const result = await otherRepo.get("doc1");
			expect(result).toBeNull();
		});

		it("should not see documents from other collections", async () => {
			const otherRepo = new PluginStorageRepository<TestDocument>(
				db,
				"test-plugin",
				"other-collection",
				["status"],
			);

			await repo.put("doc1", {
				title: "Test",
				status: "active",
				count: 5,
				createdAt: "2024-01-01",
			});

			const result = await otherRepo.get("doc1");
			expect(result).toBeNull();
		});
	});
});
