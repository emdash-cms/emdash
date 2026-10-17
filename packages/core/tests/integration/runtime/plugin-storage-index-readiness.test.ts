import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";

const runtimes: EmDashRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

function createRuntime(storage: Record<string, { indexes: string[]; uniqueIndexes?: string[] }>) {
	return EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [
			definePlugin({
				id: "shop",
				version: "1.0.0",
				storage,
				routes: {
					checkout: {
						public: true,
						handler: async () => ({ ok: true }),
					},
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
}

function createMultiPluginRuntime(
	pluginDefinitions: Array<{
		id: string;
		storage: Record<string, { indexes: string[]; uniqueIndexes?: string[] }>;
	}>,
) {
	return EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: pluginDefinitions.map((definition) =>
			definePlugin({
				id: definition.id,
				version: "1.0.0",
				storage: definition.storage,
			}),
		),
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
}

interface IndexSyncAccessor {
	ensureStorageIndexesSynced(pluginId?: string): Promise<boolean>;
}

describe("plugin storage index readiness", () => {
	it("materializes declared indexes before a state-changing plugin route runs", async () => {
		const runtime = await createRuntime({
			orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
		});
		runtimes.push(runtime);

		let indexes = await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute();
		expect(indexes).toHaveLength(0);

		const response = await dispatchPluginApiRequest({
			runtime,
			pluginId: "shop",
			path: "/checkout",
			request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
				method: "POST",
			}),
		});

		expect(response.status).toBe(200);
		const afterIndexes = await runtime.db
			.selectFrom("_plugin_indexes")
			.select("index_name")
			.execute();
		expect(afterIndexes.map((r) => r.index_name).toSorted()).toEqual([
			"idx_plugin_shop_orders_status",
			"uidx_plugin_shop_orders_externalId",
		]);
	});

	it("does not run index DDL for read-only plugin routes", async () => {
		const runtime = await createRuntime({
			orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
		});
		runtimes.push(runtime);

		const response = await dispatchPluginApiRequest({
			runtime,
			pluginId: "shop",
			path: "/checkout",
			request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
				method: "GET",
			}),
		});

		expect(response.status).toBe(200);
		const indexes = await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute();
		expect(indexes).toHaveLength(0);
	});

	it("rejects a state-changing route until a conflicting unique index can be created", async () => {
		const runtime = await createRuntime({
			orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
		});
		runtimes.push(runtime);

		const repo = new PluginStorageRepository<{ externalId: string }>(runtime.db, "shop", "orders", [
			"externalId",
		]);
		await repo.put("a", { externalId: "duplicate" });
		await repo.put("b", { externalId: "duplicate" });

		const response = await dispatchPluginApiRequest({
			runtime,
			pluginId: "shop",
			path: "/checkout",
			request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
				method: "POST",
			}),
		});

		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("STORAGE_INDEXES_NOT_READY");
	});

	it("concurrent per-plugin sync requests for different plugins are each satisfied", async () => {
		const runtime = await createMultiPluginRuntime([
			{ id: "shop", storage: { orders: { indexes: ["status"], uniqueIndexes: ["externalId"] } } },
			{ id: "forum", storage: { threads: { indexes: ["pinned"] } } },
		]);
		runtimes.push(runtime);

		const sync = runtime as unknown as IndexSyncAccessor;
		const [shopReady, forumReady] = await Promise.all([
			sync.ensureStorageIndexesSynced("shop"),
			sync.ensureStorageIndexesSynced("forum"),
		]);

		expect(shopReady).toBe(true);
		expect(forumReady).toBe(true);

		const indexes = await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute();
		expect(indexes.map((r) => r.index_name).toSorted()).toEqual([
			"idx_plugin_forum_threads_pinned",
			"idx_plugin_shop_orders_status",
			"uidx_plugin_shop_orders_externalId",
		]);
	});

	it("scheduled all-plugin sync is not captured by an in-flight per-plugin sync", async () => {
		const runtime = await createMultiPluginRuntime([
			{ id: "shop", storage: { orders: { indexes: ["status"], uniqueIndexes: ["externalId"] } } },
			{ id: "forum", storage: { threads: { indexes: ["pinned"] } } },
		]);
		runtimes.push(runtime);

		const sync = runtime as unknown as IndexSyncAccessor;
		const [shopReady, allReady] = await Promise.all([
			sync.ensureStorageIndexesSynced("shop"),
			sync.ensureStorageIndexesSynced(),
		]);

		expect(shopReady).toBe(true);
		expect(allReady).toBe(true);

		const indexes = await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute();
		expect(indexes.map((r) => r.index_name).toSorted()).toEqual([
			"idx_plugin_forum_threads_pinned",
			"idx_plugin_shop_orders_status",
			"uidx_plugin_shop_orders_externalId",
		]);
	});
});
