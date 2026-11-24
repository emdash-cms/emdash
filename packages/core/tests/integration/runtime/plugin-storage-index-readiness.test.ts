import { randomUUID } from "node:crypto";

import { sql, SqliteDialect } from "kysely";
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { createRecorder } from "../../../src/database/instrumentation.js";
import { up as migratePluginStorageUniqueIndexes } from "../../../src/database/migrations/095_plugin_storage_unique_scope.js";
import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import {
	generateDropIndexSql,
	generateIndexName,
	syncDeclaredStorageIndexes,
} from "../../../src/plugins/storage-indexes.js";
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
		expect(afterIndexes.map((r) => r.index_name).toSorted()).toEqual(
			[
				generateIndexName("shop", "orders", ["externalId"]),
				generateIndexName("shop", "orders", ["status"]),
				generateIndexName("shop", "orders", ["externalId"], { unique: true }),
			].toSorted(),
		);
	});

	it.each(["registry read", "index DDL"])(
		"replaces an abandoned cross-request sync paused during %s",
		async (pauseAt) => {
			const storage: StorageDeclaration = {
				orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
			};
			const runtime = await createRuntime(storage);
			runtimes.push(runtime);

			let releaseFirst!: () => void;
			const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
			let firstSelectStarted!: () => void;
			const firstSelect = new Promise<void>((resolve) => (firstSelectStarted = resolve));
			const pausedQueryIds = new Set<unknown>();
			let pauseFirstSelect = true;
			const firstDb = runtime.db.withPlugin({
				transformQuery: ({ node, queryId }) => {
					const query = runtime.db.getExecutor().compileQuery(node, queryId);
					if (
						pauseFirstSelect &&
						(pauseAt === "registry read"
							? query.sql.toLowerCase().includes("select") &&
								query.sql.includes("_plugin_indexes") &&
								query.parameters.includes("shop")
							: /create\s+index/i.test(query.sql))
					) {
						pauseFirstSelect = false;
						pausedQueryIds.add(queryId);
					}
					return node;
				},
				async transformResult({ queryId, result }) {
					if (pausedQueryIds.has(queryId)) {
						firstSelectStarted();
						await firstReleased;
					}
					return result;
				},
			} satisfies KyselyPlugin);
			const firstRecorder = createRecorder("abandoned-owner", "POST", "cold");
			const now = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
			let first: Promise<Response> | undefined;
			let second: Promise<Response> | undefined;
			try {
				first = runWithContext({ db: firstDb, editMode: false, queryRecorder: firstRecorder }, () =>
					dispatchPluginApiRequest({
						runtime,
						pluginId: "shop",
						path: "/checkout",
						request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
							method: "POST",
						}),
					}),
				);
				await firstSelect;
				now.mockReturnValue(3_015_001);

				const secondRecorder = createRecorder("replacement-owner", "POST", "cold");
				second = dispatchWithRecorder(runtime, "POST", secondRecorder);
				const timeout = Symbol("second request timeout");
				let timer: ReturnType<typeof setTimeout> | undefined;
				const secondResult = await Promise.race([
					second,
					new Promise<typeof timeout>((resolve) => {
						timer = setTimeout(resolve, 1_000, timeout);
					}),
				]);
				if (timer) clearTimeout(timer);
				expect(secondResult).not.toBe(timeout);
				expect((secondResult as Response).status).toBe(200);
				expect(ddlQueries(secondRecorder)).toHaveLength(3);
				expect(
					(await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute())
						.map((row) => row.index_name)
						.toSorted(),
				).toEqual(
					[
						generateIndexName("shop", "orders", ["externalId"]),
						generateIndexName("shop", "orders", ["status"]),
						generateIndexName("shop", "orders", ["externalId"], { unique: true }),
					].toSorted(),
				);

				const repository = new PluginStorageRepository<{ externalId: string }>(
					runtime.db,
					"shop",
					"orders",
					["externalId"],
				);
				await repository.put("one", { externalId: "duplicate" });
				await expect(repository.put("two", { externalId: "duplicate" })).rejects.toThrow();

				releaseFirst();
				await expect(first).resolves.toMatchObject({
					status: pauseAt === "registry read" ? 200 : 503,
				});
				const retryRecorder = createRecorder("after-superseded-owner", "POST", "retry");
				expect((await dispatchWithRecorder(runtime, "POST", retryRecorder)).status).toBe(200);
				expect(ddlQueries(retryRecorder)).toHaveLength(pauseAt === "registry read" ? 0 : 3);
				expect(ddlQueries(firstRecorder)).toHaveLength(pauseAt === "registry read" ? 0 : 1);
			} finally {
				releaseFirst();
				await first?.catch(() => undefined);
				await second?.catch(() => undefined);
				now.mockRestore();
			}
		},
	);

	it("times out a waiter while a reclaimed owner is still running", async () => {
		const runtime = await createRuntime({
			orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
		});
		runtimes.push(runtime);

		const pausedDb = () => {
			let pause = true;
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let started!: () => void;
			const queryStarted = new Promise<void>((resolve) => (started = resolve));
			const pausedQueryIds = new Set<unknown>();
			const db = runtime.db.withPlugin({
				transformQuery: ({ node, queryId }) => {
					const query = runtime.db.getExecutor().compileQuery(node, queryId);
					if (
						pause &&
						query.sql.toLowerCase().includes("select") &&
						query.sql.includes("_plugin_indexes") &&
						query.parameters.includes("shop")
					) {
						pause = false;
						pausedQueryIds.add(queryId);
					}
					return node;
				},
				async transformResult({ queryId, result }) {
					if (pausedQueryIds.has(queryId)) {
						started();
						await released;
					}
					return result;
				},
			} satisfies KyselyPlugin);
			return { db, queryStarted, release };
		};
		const first = pausedDb();
		const third = pausedDb();
		const now = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
		const post = (db: typeof runtime.db, recorderName: string) =>
			runWithContext(
				{ db, editMode: false, queryRecorder: createRecorder(recorderName, "POST", "cold") },
				() =>
					dispatchPluginApiRequest({
						runtime,
						pluginId: "shop",
						path: "/checkout",
						request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
							method: "POST",
						}),
					}),
			);

		let firstRequest: Promise<Response> | undefined;
		let waiter: Promise<Response> | undefined;
		let replacement: Promise<Response> | undefined;
		try {
			firstRequest = post(first.db, "timeout-first");
			await first.queryStarted;
			waiter = post(runtime.db, "timeout-waiter");
			now.mockReturnValue(3_020_000);
			replacement = post(third.db, "timeout-replacement");
			await third.queryStarted;
			now.mockReturnValue(3_031_000);

			const timeout = Symbol("waiter timeout");
			const result = await Promise.race([
				waiter,
				new Promise<typeof timeout>((resolve) => setTimeout(resolve, 1_000, timeout)),
			]);
			expect(result).not.toBe(timeout);
			expect((result as Response).status).toBe(503);
		} finally {
			first.release();
			third.release();
			await firstRequest?.catch(() => undefined);
			await waiter?.catch(() => undefined);
			await replacement?.catch(() => undefined);
			now.mockRestore();
		}
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

	it("keeps a legacy regular index on the readiness fast path after the unique-index migration", async () => {
		const storage: StorageDeclaration = {
			product_variants: { indexes: ["formId"] },
		};
		const runtime = await createRuntime(storage);
		runtimes.push(runtime);

		const legacyIndexName = "idx_plugin_shop_product_variants_formId";
		await sql`
			CREATE INDEX ${sql.ref(legacyIndexName)}
			ON _plugin_storage(plugin_id, collection, json_extract(data, '$.formId'))
		`.execute(runtime.db);
		await runtime.db
			.insertInto("_plugin_indexes")
			.values({
				plugin_id: "shop",
				collection: "product_variants",
				index_name: legacyIndexName,
				fields: '["formId"]',
			})
			.execute();
		await migratePluginStorageUniqueIndexes(runtime.db);

		const recorder = createRecorder("legacy-regular-index", "POST", "cold");
		const response = await dispatchWithRecorder(runtime, "POST", recorder);
		expect(response.status).toBe(200);
		expect(ddlQueries(recorder)).toHaveLength(0);
		const registryQueries = pluginIndexQueries(recorder);
		expect(registryQueries).toHaveLength(1);
		expect(registryQueries[0]?.sql.toLowerCase()).toContain("select");
		expect(
			registryQueries.filter((event) => !event.sql.toLowerCase().includes("select")),
		).toHaveLength(0);
	});

	it("repairs a missing regular companion before taking the readiness fast path", async () => {
		const storage: StorageDeclaration = {
			orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
		};
		const runtime = await createRuntime(storage);
		runtimes.push(runtime);
		await syncDeclaredStorageIndexes(runtime.db, [{ id: "shop", storage }]);
		const externalIdIndex = generateIndexName("shop", "orders", ["externalId"]);
		await generateDropIndexSql(externalIdIndex).execute(runtime.db);
		await runtime.db
			.deleteFrom("_plugin_indexes")
			.where("index_name", "=", externalIdIndex)
			.execute();

		const sync = runtime as unknown as IndexSyncAccessor;
		const repairRecorder = createRecorder("repair", "POST", "cold");
		await runWithContext({ editMode: false, queryRecorder: repairRecorder }, () =>
			sync.ensureStorageIndexesSynced("shop"),
		);
		expect(ddlQueries(repairRecorder).some((event) => /create\s+index/i.test(event.sql))).toBe(
			true,
		);

		const fastPathRecorder = createRecorder("recheck", "POST", "warm");
		await runWithContext({ editMode: false, queryRecorder: fastPathRecorder }, () =>
			sync.ensureStorageIndexesSynced("shop"),
		);
		expect(ddlQueries(fastPathRecorder)).toHaveLength(0);
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
			).toHaveLength(2);

			await repo.delete("b");
			if (retryPath === "scheduled") {
				await runtime.runScheduledTasks();
				expect(
					await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute(),
				).toHaveLength(3);
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
			).toHaveLength(3);
		},
	);

	it("shares one failed unique-index attempt with a burst of request contexts", async () => {
		const storage: StorageDeclaration = {
			orders: { indexes: ["status"], uniqueIndexes: ["externalId"] },
		};
		const runtime = await createRuntime(storage);
		runtimes.push(runtime);

		const repository = new PluginStorageRepository<{ externalId: string }>(
			runtime.db,
			"shop",
			"orders",
			["externalId"],
		);
		await repository.put("one", { externalId: "duplicate" });
		await repository.put("two", { externalId: "duplicate" });

		let releaseRegistryQuery!: () => void;
		const registryQueryReleased = new Promise<void>((resolve) => {
			releaseRegistryQuery = resolve;
		});
		let registryQueryStarted!: () => void;
		const registryQueryHasStarted = new Promise<void>((resolve) => {
			registryQueryStarted = resolve;
		});
		let pauseRegistryQuery = true;
		let uniqueCreateAttempts = 0;
		const gatedDb = runtime.db.withPlugin({
			transformQuery: ({ node, queryId }) => {
				const query = runtime.db.getExecutor().compileQuery(node, queryId);
				if (/create\s+unique\s+index/i.test(query.sql)) uniqueCreateAttempts += 1;
				if (
					pauseRegistryQuery &&
					query.sql.toLowerCase().includes("select") &&
					query.sql.includes("_plugin_indexes") &&
					query.parameters.includes("shop")
				) {
					pauseRegistryQuery = false;
					registryQueryStarted();
				}
				return node;
			},
			async transformResult({ result }) {
				if (!pauseRegistryQuery) await registryQueryReleased;
				return result;
			},
		} satisfies KyselyPlugin);
		const recorder = createRecorder("burst", "POST", "cold");
		const burstSize = 8;
		let requestsStarted = 0;
		let releaseBurst!: () => void;
		const burstReleased = new Promise<void>((resolve) => (releaseBurst = resolve));
		const requests = Array.from({ length: burstSize }, () =>
			runWithContext({ db: gatedDb, editMode: false, queryRecorder: recorder }, async () => {
				requestsStarted += 1;
				if (requestsStarted === burstSize) releaseBurst();
				await burstReleased;
				return dispatchPluginApiRequest({
					runtime,
					pluginId: "shop",
					path: "/checkout",
					request: new Request("https://example.com/_emdash/api/plugins/shop/checkout", {
						method: "POST",
					}),
				});
			}),
		);

		try {
			await registryQueryHasStarted;
			await Promise.resolve();
			releaseRegistryQuery();
			const responses = await Promise.all(requests);
			expect(responses.every((response) => response.status === 503)).toBe(true);
			expect(uniqueCreateAttempts).toBe(1);
			expect(ddlQueries(recorder)).toHaveLength(2);
			expect(
				pluginIndexQueries(recorder).filter((event) => /^select/i.test(event.sql)),
			).toHaveLength(2);

			await repository.delete("two");
			const retryRecorder = createRecorder("retry", "POST", "cold");
			const retryResponse = await dispatchWithRecorder(runtime, "POST", retryRecorder);
			expect(retryResponse.status).toBe(200);
			expect(ddlQueries(retryRecorder)).toHaveLength(3);
			expect(
				ddlQueries(retryRecorder).filter((event) => /create\s+unique\s+index/i.test(event.sql)),
			).toHaveLength(1);
		} finally {
			releaseRegistryQuery();
			await Promise.all(requests);
		}
	});

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
		expect(indexes.map((r) => r.index_name).toSorted()).toEqual(
			[
				generateIndexName("forum", "threads", ["pinned"]),
				generateIndexName("shop", "orders", ["externalId"]),
				generateIndexName("shop", "orders", ["status"]),
				generateIndexName("shop", "orders", ["externalId"], { unique: true }),
			].toSorted(),
		);
	});

	it("coalesces targeted and all-plugin syncs across request contexts", async () => {
		const runtime = await createMultiPluginRuntime([
			{ id: "shop", storage: { orders: { indexes: ["status"], uniqueIndexes: ["externalId"] } } },
			{ id: "forum", storage: { threads: { indexes: ["pinned"] } } },
		]);
		runtimes.push(runtime);

		const sync = runtime as unknown as IndexSyncAccessor;
		const recorder = createRecorder("scheduled-and-route", "POST", "cold");
		const [shopReady, allReady] = await Promise.all([
			runWithContext({ editMode: false, queryRecorder: recorder }, () =>
				sync.ensureStorageIndexesSynced("shop"),
			),
			runWithContext({ editMode: false, queryRecorder: recorder }, () =>
				sync.ensureStorageIndexesSynced(),
			),
		]);

		expect(shopReady).toBe(true);
		expect(allReady).toBe(true);
		for (const pluginId of ["shop", "forum"]) {
			expect(
				pluginIndexQueries(recorder).filter(
					(event) => /^select/i.test(event.sql) && event.params.includes(pluginId),
				),
			).toHaveLength(2);
		}
		expect(ddlQueries(recorder).filter((event) => /create/i.test(event.sql))).toHaveLength(4);

		const indexes = await runtime.db.selectFrom("_plugin_indexes").select("index_name").execute();
		expect(indexes.map((r) => r.index_name).toSorted()).toEqual(
			[
				generateIndexName("forum", "threads", ["pinned"]),
				generateIndexName("shop", "orders", ["externalId"]),
				generateIndexName("shop", "orders", ["status"]),
				generateIndexName("shop", "orders", ["externalId"], { unique: true }),
			].toSorted(),
		);
	});
});
