import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { createRecorder } from "../../../src/database/instrumentation.js";
import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import { syncDeclaredStorageIndexes } from "../../../src/plugins/storage-indexes.js";
import { runWithContext } from "../../../src/request-context.js";

const runtimes: EmDashRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

type StorageDeclaration = Record<
	string,
	{ indexes: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
>;

function createRuntime(storage: StorageDeclaration) {
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
		storage: StorageDeclaration;
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

function pluginIndexQueries(recorder: ReturnType<typeof createRecorder>) {
	return recorder.events.filter((event) => event.sql.toLowerCase().includes("_plugin_indexes"));
}

function ddlQueries(recorder: ReturnType<typeof createRecorder>) {
	return recorder.events.filter((event) =>
		/\b(create(?:\s+unique)?|drop)\s+index\b/i.test(event.sql),
	);
}

async function dispatchWithRecorder(
	runtime: EmDashRuntime,
	method: string,
	recorder: ReturnType<typeof createRecorder>,
) {
	return runWithContext({ editMode: false, queryRecorder: recorder }, () =>
		dispatchPluginApiRequest({
			runtime,
			pluginId: "shop",
			path: "/checkout",
			request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
				method,
			}),
		}),
	);
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

	it("uses the registry fast path when declared indexes already exist", async () => {
		const storage: StorageDeclaration = {
			orders: {
				indexes: ["status", ["status", "createdAt"], "externalId"],
				uniqueIndexes: ["externalId", ["region", "externalId"]],
			},
			archive: { indexes: [["status", "createdAt"]], uniqueIndexes: ["slug"] },
		};
		const runtime = await createRuntime(storage);
		runtimes.push(runtime);
		await syncDeclaredStorageIndexes(runtime.db, [{ id: "shop", storage }]);
		await syncDeclaredStorageIndexes(runtime.db, [
			{ id: "forum", storage: { threads: { indexes: ["pinned"] } } },
		]);

		const coldRecorder = createRecorder("/checkout", "POST", "cold");
		const response = await dispatchWithRecorder(runtime, "POST", coldRecorder);
		expect(response.status).toBe(200);
		const coldRegistryQueries = pluginIndexQueries(coldRecorder);
		expect(coldRegistryQueries).toHaveLength(1);
		expect(coldRegistryQueries[0]?.sql.toLowerCase()).toContain("select");
		expect(ddlQueries(coldRecorder)).toHaveLength(0);
		expect(
			coldRecorder.events.filter(
				(event) =>
					event.sql.toLowerCase().includes("_plugin_indexes") &&
					!event.sql.toLowerCase().includes("select"),
			),
		).toHaveLength(0);

		const warmRecorder = createRecorder("/checkout", "POST", "warm");
		const warmResponse = await dispatchWithRecorder(runtime, "POST", warmRecorder);
		expect(warmResponse.status).toBe(200);
		expect(pluginIndexQueries(warmRecorder)).toHaveLength(0);
		expect(ddlQueries(warmRecorder)).toHaveLength(0);
	});

	it("does not run index DDL for read-only plugin routes", async () => {
		const runtime = await createRuntime({
			orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
		});
		runtimes.push(runtime);

		const recorder = createRecorder("/checkout", "GET", "cold");
		const response = await dispatchWithRecorder(runtime, "GET", recorder);

		expect(response.status).toBe(200);
		expect(pluginIndexQueries(recorder)).toHaveLength(0);
		expect(ddlQueries(recorder)).toHaveLength(0);
		const indexes = await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute();
		expect(indexes).toHaveLength(0);
	});

	it.each(["request", "scheduled"])(
		"retries an incomplete unique index sync in the same runtime via %s",
		async (retryPath) => {
			const runtime = await createRuntime({
				orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
			});
			runtimes.push(runtime);

			const repo = new PluginStorageRepository<{ externalId: string }>(
				runtime.db,
				"shop",
				"orders",
				["externalId"],
			);
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
			expect(
				await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute(),
			).toHaveLength(1);

			await repo.delete("b");
			if (retryPath === "scheduled") {
				await runtime.runScheduledTasks();
				expect(
					await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute(),
				).toHaveLength(2);
			}

			const retryResponse = await dispatchPluginApiRequest({
				runtime,
				pluginId: "shop",
				path: "/checkout",
				request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
					method: "POST",
				}),
			});

			expect(retryResponse.status).toBe(200);
			expect(
				await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute(),
			).toHaveLength(2);
		},
	);

	it("removes stale indexes from a collection and removed collections before the route", async () => {
		const storage: StorageDeclaration = { orders: { indexes: ["status"] } };
		const runtime = await createRuntime(storage);
		runtimes.push(runtime);
		await syncDeclaredStorageIndexes(runtime.db, [
			{
				id: "shop",
				storage: {
					orders: { indexes: ["status", "obsolete"] },
					archive: { indexes: ["oldField"] },
				},
			},
		]);

		const recorder = createRecorder("/checkout", "POST", "cold");
		const response = await dispatchWithRecorder(runtime, "POST", recorder);
		expect(response.status).toBe(200);
		expect(ddlQueries(recorder).some((event) => /drop\s+index/i.test(event.sql))).toBe(true);
		expect(
			(
				await runtime.db
					.selectFrom("_plugin_indexes")
					.select(["collection", "index_name"])
					.where("plugin_id", "=", "shop")
					.execute()
			).map((row) => `${row.collection}:${row.index_name}`),
		).toEqual(["orders:idx_plugin_shop_orders_status"]);
	});

	it("removes all indexes before a plugin with no storage declarations runs", async () => {
		const runtime = await createRuntime({});
		runtimes.push(runtime);
		await syncDeclaredStorageIndexes(runtime.db, [
			{ id: "shop", storage: { orders: { indexes: ["obsolete"] } } },
		]);

		const recorder = createRecorder("/checkout", "POST", "cold");
		const response = await dispatchWithRecorder(runtime, "POST", recorder);
		expect(response.status).toBe(200);
		expect(ddlQueries(recorder).some((event) => /drop\s+index/i.test(event.sql))).toBe(true);
		expect(
			await runtime.db
				.selectFrom("_plugin_indexes")
				.selectAll()
				.where("plugin_id", "=", "shop")
				.execute(),
		).toHaveLength(0);
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

	it("shares per-plugin flights between targeted and all-plugin syncs", async () => {
		const runtime = await createMultiPluginRuntime([
			{ id: "shop", storage: { orders: { indexes: ["status"], uniqueIndexes: ["externalId"] } } },
			{ id: "forum", storage: { threads: { indexes: ["pinned"] } } },
		]);
		runtimes.push(runtime);

		const sync = runtime as unknown as IndexSyncAccessor;
		const recorder = createRecorder("scheduled-and-route", "POST", "cold");
		const [shopReady, allReady] = await runWithContext(
			{ editMode: false, queryRecorder: recorder },
			() =>
				Promise.all([sync.ensureStorageIndexesSynced("shop"), sync.ensureStorageIndexesSynced()]),
		);

		expect(shopReady).toBe(true);
		expect(allReady).toBe(true);
		expect(ddlQueries(recorder).filter((event) => /create/i.test(event.sql))).toHaveLength(3);

		const indexes = await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute();
		expect(indexes.map((r) => r.index_name).toSorted()).toEqual([
			"idx_plugin_forum_threads_pinned",
			"idx_plugin_shop_orders_status",
			"uidx_plugin_shop_orders_externalId",
		]);
	});
});
