import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	PluginStorageRepository,
	createPluginStorageAccessor,
	deleteAllPluginStorage,
	deletePluginCollection,
} from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	setupTestDatabase,
	teardownForDialect,
	teardownTestDatabase,
	type DialectName,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface AnalyticsEvent {
	eventType: string;
	userId: string;
	timestamp: string;
	metadata: Record<string, unknown>;
}

describe("Plugin Storage Integration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("full storage flow", () => {
		it("should support complete CRUD cycle", async () => {
			const repo = new PluginStorageRepository<AnalyticsEvent>(db, "analytics-plugin", "events", [
				"eventType",
				"userId",
				"timestamp",
			]);

			// Create
			const event: AnalyticsEvent = {
				eventType: "pageview",
				userId: "user123",
				timestamp: new Date().toISOString(),
				metadata: { page: "/home", referrer: "google.com" },
			};
			await repo.put("event1", event);

			// Read
			const fetched = await repo.get("event1");
			expect(fetched).toEqual(event);

			// Update
			const updatedEvent = {
				...event,
				metadata: { ...event.metadata, duration: 5000 },
			};
			await repo.put("event1", updatedEvent);
			const refetched = await repo.get("event1");
			expect(refetched?.metadata).toHaveProperty("duration", 5000);

			// Delete
			const deleted = await repo.delete("event1");
			expect(deleted).toBe(true);
			expect(await repo.get("event1")).toBeNull();
		});

		it("should support complex queries with JSON extraction", async () => {
			const repo = new PluginStorageRepository<AnalyticsEvent>(db, "analytics-plugin", "events", [
				"eventType",
				"userId",
				"timestamp",
			]);

			// Create events
			await repo.putMany([
				{
					id: "e1",
					data: {
						eventType: "pageview",
						userId: "user1",
						timestamp: "2024-01-01T10:00:00Z",
						metadata: {},
					},
				},
				{
					id: "e2",
					data: {
						eventType: "click",
						userId: "user1",
						timestamp: "2024-01-01T10:05:00Z",
						metadata: {},
					},
				},
				{
					id: "e3",
					data: {
						eventType: "pageview",
						userId: "user2",
						timestamp: "2024-01-01T11:00:00Z",
						metadata: {},
					},
				},
			]);

			// Query by eventType
			const pageviews = await repo.query({ where: { eventType: "pageview" } });
			expect(pageviews.items).toHaveLength(2);

			// Query by userId
			const user1Events = await repo.query({ where: { userId: "user1" } });
			expect(user1Events.items).toHaveLength(2);

			// Combined query
			const user1Pageviews = await repo.query({
				where: { eventType: "pageview", userId: "user1" },
			});
			expect(user1Pageviews.items).toHaveLength(1);
		});
	});

	describe("createPluginStorageAccessor", () => {
		it("should create accessor with multiple collections", async () => {
			const accessor = createPluginStorageAccessor(db, "my-plugin", {
				events: { indexes: ["eventType", "timestamp"] },
				cache: { indexes: ["key", "expiresAt"] },
			});

			expect(accessor).toHaveProperty("events");
			expect(accessor).toHaveProperty("cache");

			// Use events collection
			await accessor.events.put("e1", {
				eventType: "test",
				timestamp: new Date().toISOString(),
			});
			const event = await accessor.events.get("e1");
			expect(event).toBeDefined();

			// Use cache collection
			await accessor.cache.put("c1", {
				key: "test-key",
				value: "test-value",
				expiresAt: new Date().toISOString(),
			});
			const cached = await accessor.cache.get("c1");
			expect(cached).toBeDefined();
		});

		it("should isolate collections from each other", async () => {
			const accessor = createPluginStorageAccessor(db, "my-plugin", {
				events: { indexes: ["eventType"] },
				cache: { indexes: ["key"] },
			});

			await accessor.events.put("item1", { eventType: "test" });
			await accessor.cache.put("item1", { key: "test" });

			// Both should exist independently
			expect(await accessor.events.get("item1")).toEqual({ eventType: "test" });
			expect(await accessor.cache.get("item1")).toEqual({ key: "test" });

			// Count should be separate
			expect(
				await (accessor.events as PluginStorageRepository<any>).count({
					eventType: "test",
				}),
			).toBe(1);
			expect(
				await (accessor.cache as PluginStorageRepository<any>).count({
					key: "test",
				}),
			).toBe(1);
		});
	});

	describe("deleteAllPluginStorage", () => {
		it("should delete all data for a plugin", async () => {
			const accessor = createPluginStorageAccessor(db, "cleanup-plugin", {
				events: { indexes: ["eventType"] },
				cache: { indexes: ["key"] },
			});

			// Add data
			await accessor.events.put("e1", { eventType: "test" });
			await accessor.events.put("e2", { eventType: "test2" });
			await accessor.cache.put("c1", { key: "test" });

			// Delete all
			const deleted = await deleteAllPluginStorage(db, "cleanup-plugin");
			expect(deleted).toBe(3);

			// Verify empty
			expect(await accessor.events.get("e1")).toBeNull();
			expect(await accessor.events.get("e2")).toBeNull();
			expect(await accessor.cache.get("c1")).toBeNull();
		});

		it("should not affect other plugins", async () => {
			const plugin1 = createPluginStorageAccessor(db, "plugin1", {
				data: { indexes: ["key"] },
			});
			const plugin2 = createPluginStorageAccessor(db, "plugin2", {
				data: { indexes: ["key"] },
			});

			await plugin1.data.put("item1", { key: "test" });
			await plugin2.data.put("item1", { key: "test" });

			await deleteAllPluginStorage(db, "plugin1");

			expect(await plugin1.data.get("item1")).toBeNull();
			expect(await plugin2.data.get("item1")).toEqual({ key: "test" });
		});
	});

	describe("deletePluginCollection", () => {
		it("should delete specific collection", async () => {
			const accessor = createPluginStorageAccessor(db, "my-plugin", {
				events: { indexes: ["eventType"] },
				cache: { indexes: ["key"] },
			});

			await accessor.events.put("e1", { eventType: "test" });
			await accessor.cache.put("c1", { key: "test" });

			await deletePluginCollection(db, "my-plugin", "events");

			expect(await accessor.events.get("e1")).toBeNull();
			expect(await accessor.cache.get("c1")).toEqual({ key: "test" });
		});
	});

	describe("pagination", () => {
		it("should paginate through large datasets", async () => {
			const repo = new PluginStorageRepository<{ index: number }>(
				db,
				"pagination-test",
				"items",
				[],
			);

			// Create 25 items
			const items = Array.from({ length: 25 }, (_, i) => ({
				id: `item-${String(i).padStart(3, "0")}`,
				data: { index: i },
			}));
			await repo.putMany(items);

			// Paginate with limit of 10
			const pages: Array<Array<{ id: string; data: { index: number } }>> = [];
			let cursor: string | undefined;

			do {
				const result = await repo.query({ limit: 10, cursor });
				pages.push(result.items);
				cursor = result.cursor;
			} while (cursor);

			expect(pages).toHaveLength(3);
			expect(pages[0]).toHaveLength(10);
			expect(pages[1]).toHaveLength(10);
			expect(pages[2]).toHaveLength(5);

			// Verify all items were retrieved
			const allItems = pages.flat();
			expect(allItems).toHaveLength(25);
			expect(new Set(allItems.map((i) => i.id)).size).toBe(25);
		});
	});

	describe("concurrent operations", () => {
		it("should handle concurrent puts", async () => {
			const repo = new PluginStorageRepository<{ value: number }>(
				db,
				"concurrent-test",
				"items",
				[],
			);

			// Concurrent puts
			await Promise.all([
				repo.put("item1", { value: 1 }),
				repo.put("item2", { value: 2 }),
				repo.put("item3", { value: 3 }),
				repo.put("item4", { value: 4 }),
				repo.put("item5", { value: 5 }),
			]);

			const count = await repo.count();
			expect(count).toBe(5);
		});
	});
});

describeEachDialect("Plugin Storage filtered queries", (dialect: DialectName) => {
	let ctx: DialectTestContext;
	let repo: PluginStorageRepository<{ name: string; status: string }>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new PluginStorageRepository(ctx.db, "filtered-plugin", "items", ["name", "status"]);
		await repo.putMany([
			{ id: "one", data: { name: "alpha", status: "active" } },
			{ id: "two", data: { name: "beta", status: "inactive" } },
			{ id: "three", data: { name: "alpha", status: "active" } },
		]);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("should query and count with indexed filters", async () => {
		const result = await repo.query({ where: { name: "alpha" } });
		const count = await repo.count({ status: "active" });

		expect(result.items).toHaveLength(2);
		expect(result.items.every((item) => item.data.name === "alpha")).toBe(true);
		expect(count).toBe(2);
	});
});
