import { randomUUID } from "node:crypto";

import { CompiledQuery, SqliteDialect } from "kysely";
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { createRequestScopedDb as createD1RequestScopedDb } from "../../../../cloudflare/src/db/d1.js";
import {
	isReadStatement,
	type DOQueryOptions,
	type DOQueryStatement,
} from "../../../../cloudflare/src/db/do-sql-types.js";
import { createRequestScopedDb as createDoRequestScopedDb } from "../../../../cloudflare/src/db/do-sql.js";
import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import {
	generateIndexName,
	removeAllPluginIndexes,
	syncDeclaredStorageIndexes,
} from "../../../src/plugins/storage-indexes.js";
import { runWithContext } from "../../../src/request-context.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const testBindings = vi.hoisted(() => ({
	DB: undefined as unknown,
	DB_DO: undefined as unknown,
}));
vi.mock("cloudflare:workers", () => ({
	env: testBindings,
	DurableObject: class {
		constructor(readonly ctx: unknown) {}
	},
}));

class MemoryStorage implements Storage {
	private files = new Map<string, Uint8Array>();

	putText(key: string, value: string): void {
		this.files.set(key, new TextEncoder().encode(value));
	}

	async upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
	}) {
		if (!(options.body instanceof Uint8Array)) throw new Error("Test storage expects bytes");
		this.files.set(options.key, options.body);
		return { key: options.key, url: `memory://${options.key}`, size: options.body.byteLength };
	}
	failDownloads = false;
	downloadCount = 0;
	private downloadGate: Promise<void> | undefined;
	private releaseDownload: (() => void) | undefined;
	private signalDownloadStarted: (() => void) | undefined;
	downloadStarted = Promise.resolve();

	pauseNextDownload(): void {
		this.downloadStarted = new Promise((resolve) => {
			this.signalDownloadStarted = resolve;
		});
		this.downloadGate = new Promise((resolve) => {
			this.releaseDownload = resolve;
		});
	}

	resumeDownload(): void {
		this.releaseDownload?.();
		this.releaseDownload = undefined;
	}

	async download(key: string) {
		this.downloadCount++;
		if (this.failDownloads) throw new Error("Storage unavailable");
		const downloadGate = this.downloadGate;
		if (downloadGate) {
			this.downloadGate = undefined;
			this.signalDownloadStarted?.();
			this.signalDownloadStarted = undefined;
			await downloadGate;
		}
		const bytes = this.files.get(key);
		if (!bytes) throw new Error(`Missing ${key}`);
		return {
			body: new Blob([bytes]).stream(),
			contentType: "application/octet-stream",
			size: bytes.byteLength,
		};
	}
	async delete(key: string): Promise<void> {
		this.files.delete(key);
	}
	async exists(key: string): Promise<boolean> {
		return this.files.has(key);
	}
	async list() {
		return { files: [] };
	}
	async getSignedUploadUrl() {
		return {
			url: "memory://upload",
			method: "PUT" as const,
			headers: {},
			expiresAt: new Date().toISOString(),
		};
	}
	getPublicUrl(key: string): string {
		return `memory://${key}`;
	}
}

const pluginId = "updated-plugin";
let invokeRoute: SandboxedPluginInstance["invokeRoute"] = async () => undefined;

function manifest(
	version: string,
	unique = false,
	id = pluginId,
	hooks: string[] = [],
	publicRoute = true,
) {
	return {
		id,
		version,
		capabilities: [],
		allowedHosts: [],
		storage: {
			records: { indexes: ["status"], ...(unique ? { uniqueIndexes: ["externalId"] } : {}) },
		},
		hooks,
		routes: [{ name: "submit", public: publicRoute }],
		admin: {},
	};
}

function createDeps(
	storage: MemoryStorage,
	source: "registry" | "marketplace",
): RuntimeDependencies & {
	runnerLoad: ReturnType<typeof vi.fn>;
	runnerIsAvailable: ReturnType<typeof vi.fn>;
	runnerInvokeHook: ReturnType<typeof vi.fn>;
} {
	const runnerIsAvailable = vi.fn(() => true);
	const runnerInvokeHook = vi.fn(async () => undefined);
	const runner = {
		isAvailable: runnerIsAvailable,
		isHealthy: () => true,
		load: vi.fn(async (loadedManifest: { id: string; version: string }) => ({
			id: `${loadedManifest.id}:${loadedManifest.version}`,
			invokeHook: runnerInvokeHook,
			invokeRoute: async (...args: Parameters<SandboxedPluginInstance["invokeRoute"]>) =>
				(await invokeRoute(...args)) ?? { version: loadedManifest.version },
			terminate: vi.fn(async () => undefined),
		})),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(async () => undefined),
	};
	return {
		config: {
			database: { entrypoint: `plugin-index-update-${randomUUID()}`, config: {}, type: "sqlite" },
			storage: { entrypoint: `memory-${randomUUID()}`, config: {} },
			...(source === "marketplace"
				? { marketplace: "https://marketplace.example.com" }
				: { registry: "https://registry.example.com" }),
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: () => storage,
		sandboxEnabled: true,
		sandboxedPluginEntries: [],
		// eslint-disable-next-line typescript/no-explicit-any -- minimal fake runner for the published boundary
		createSandboxRunner: (() => runner) as any,
		runnerLoad: runner.load,
		runnerIsAvailable,
		runnerInvokeHook,
	};
}

async function putBundle(
	storage: MemoryStorage,
	source: "registry" | "marketplace",
	version: string,
	unique: boolean,
	id = pluginId,
	hooks: string[] = [],
	publicRoute = true,
): Promise<void> {
	storage.putText(
		`${source}/${id}/${version}/manifest.json`,
		JSON.stringify(manifest(version, unique, id, hooks, publicRoute)),
	);
	storage.putText(`${source}/${id}/${version}/backend.js`, "export default {};");
}

function stateOptions(source: "registry" | "marketplace", version: string, id = pluginId) {
	return source === "marketplace"
		? { source, marketplaceVersion: version }
		: { source, registryPublisherDid: "did:plc:test", registrySlug: id };
}

function createRoutingD1Binding(
	primary: EmDashRuntime["db"],
	replica: Awaited<ReturnType<typeof setupTestDatabase>>,
) {
	type Query = { sql: string; parameters: readonly unknown[] };
	const session = (constraint: string, forcePrimary = false) => {
		let firstOperation = true;
		let usePrimary = constraint === "first-primary";
		const queries = new WeakMap<object, Query>();
		const execute = async (query: Query) => {
			const result = await (forcePrimary || usePrimary ? primary : replica).executeQuery(
				CompiledQuery.raw(query.sql, query.parameters),
			);
			if (firstOperation) {
				firstOperation = false;
				const version = (result.rows[0] as { version?: string } | undefined)?.version;
				usePrimary = version !== "1.0.0";
			}
			return {
				success: true,
				results: result.rows,
				meta: { changes: Number(result.numAffectedRows ?? 0), last_row_id: result.insertId },
			};
		};
		const prepare = (sql: string, parameters: readonly unknown[] = []) => {
			const statement = {
				bind(...values: unknown[]) {
					return prepare(sql, values);
				},
				all: async () => execute(queries.get(statement)!),
			};
			queries.set(statement, { sql, parameters });
			return statement;
		};
		return {
			prepare,
			batch: (statements: object[]) =>
				Promise.all(statements.map((statement) => execute(queries.get(statement)!))),
			getBookmark: () => null,
		};
	};
	return {
		...session("first-primary", true),
		withSession: session,
	};
}

function createRoutingDoNamespace(
	primary: EmDashRuntime["db"],
	replica: Awaited<ReturnType<typeof setupTestDatabase>>,
) {
	const query = async (sql: string, parameters: unknown[] = [], options?: DOQueryOptions) => {
		const db = options?.primary || !isReadStatement(sql) ? primary : replica;
		const result = await db.executeQuery(CompiledQuery.raw(sql, parameters));
		return { rows: result.rows, changes: Number(result.numAffectedRows ?? 0) };
	};
	const stub = {
		query,
		batchQuery: (statements: DOQueryStatement[], options?: DOQueryOptions) =>
			Promise.all(statements.map((statement) => query(statement.sql, statement.params, options))),
	};
	return {
		idFromName: () => "plugin-storage-test",
		get: () => stub,
	};
}

async function syncPlugins(
	runtime: EmDashRuntime,
	source: "registry" | "marketplace",
): Promise<void> {
	if (source === "marketplace") await runtime.syncMarketplacePlugins();
	else await runtime.syncRegistryPlugins();
}

async function post(runtime: EmDashRuntime): Promise<unknown> {
	return runtime.handlePluginApiRoute(
		pluginId,
		"POST",
		"/submit",
		new Request(`https://example.test/_emdash/api/plugins/${pluginId}/submit`, { method: "POST" }),
	);
}

async function get(runtime: EmDashRuntime): Promise<unknown> {
	return runtime.handlePluginApiRoute(
		pluginId,
		"GET",
		"/submit",
		new Request(`https://example.test/_emdash/api/plugins/${pluginId}/submit`),
	);
}

describe.each(["registry", "marketplace"] as const)(
	"runtime plugin storage index updates (%s)",
	(source) => {
		let runtime: EmDashRuntime | undefined;
		let replica: Awaited<ReturnType<typeof setupTestDatabase>> | undefined;
		afterEach(async () => {
			await runtime?.shutdown();
			if (replica) await teardownTestDatabase(replica);
			runtime = undefined;
			replica = undefined;
			testBindings.DB = undefined;
		});

		it("skips installed-plugin refreshes for configured plugin routes", async () => {
			const configuredId = "configured-plugin";
			const storage = new MemoryStorage();
			const deps = createDeps(storage, source);
			deps.plugins = [
				definePlugin({
					id: configuredId,
					version: "1.0.0",
					routes: {
						health: {
							public: true,
							handler: async () => ({ ok: true }),
						},
					},
				}),
			];
			runtime = await EmDashRuntime.create(deps);
			const stateQueries = { count: 0 };
			const queryDb = runtime.db.withPlugin({
				transformQuery: ({ node }) => {
					const query = runtime!.db.getExecutor().compileQuery(node);
					if (query.sql.includes("_plugin_state")) stateQueries.count++;
					return node;
				},
			} satisfies KyselyPlugin);
			const probesAtStartup = deps.runnerIsAvailable.mock.calls.length;
			const downloadsAtStartup = storage.downloadCount;

			expect(runtime.mayNeedInstalledPluginRefresh(configuredId)).toBe(false);
			expect(runtime.mayNeedInstalledPluginRefresh("installed-plugin")).toBe(true);
			await runWithContext({ db: queryDb, editMode: false }, () =>
				runtime!.refreshInstalledPluginRoute(configuredId),
			);
			const response = await runWithContext({ db: queryDb, editMode: false }, () =>
				dispatchPluginApiRequest({
					runtime: runtime!,
					pluginId: configuredId,
					path: "/health",
					request: new Request(`https://example.test/_emdash/api/plugins/${configuredId}/health`),
				}),
			);

			expect(response.status).toBe(200);
			expect(stateQueries.count).toBe(0);
			expect(storage.downloadCount).toBe(downloadsAtStartup);
			expect(deps.runnerIsAvailable).toHaveBeenCalledTimes(probesAtStartup);
		});

		it("routes plugin API refreshes to primary instead of stale replicas", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, [], true);
			await putBundle(storage, source, "2.0.0", false, pluginId, [], false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			replica = await setupTestDatabase();
			const primaryStates = new PluginStateRepository(runtime.db);
			const replicaStates = new PluginStateRepository(replica);
			await primaryStates.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			await replicaStates.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));

			const binding = createRoutingD1Binding(runtime.db, replica);
			testBindings.DB = binding;
			const cookies = { get: vi.fn(), set: vi.fn() };
			const scoped = (requirePrimary: boolean) =>
				createD1RequestScopedDb({
					config: { binding: "DB", session: "auto" },
					isAuthenticated: false,
					isWrite: false,
					cookies,
					url: new URL(
						requirePrimary
							? "https://example.test/_emdash/api/plugins/updated-plugin/submit"
							: "https://example.test/",
					),
					requirePrimary,
				})!;

			await runtime.refreshInstalledPluginRoute(pluginId);
			expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toMatchObject({ public: false });
			const ordinaryPageSession = scoped(false);
			expect(await new PluginStateRepository(ordinaryPageSession.db).get(pluginId)).toMatchObject({
				version: "1.0.0",
			});

			const pluginApiSession = scoped(true);
			await runWithContext({ db: pluginApiSession.db, editMode: false }, () =>
				runtime!.refreshInstalledPluginRoute(pluginId),
			);
			await expect(
				dispatchPluginApiRequest({
					runtime,
					pluginId,
					path: "/submit",
					request: new Request("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
				}),
			).resolves.toMatchObject({ status: 401 });
			expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toMatchObject({ public: false });

			await putBundle(storage, source, "3.0.0", false, pluginId, [], false);
			await primaryStates.upsert(pluginId, "3.0.0", "active", stateOptions(source, "3.0.0"));
			const updateSession = scoped(true);
			await runWithContext({ db: updateSession.db, editMode: false }, () =>
				runtime!.refreshInstalledPluginRoute(pluginId),
			);
			invokeRoute = async () => undefined;
			expect(await get(runtime)).toMatchObject({ success: true, data: { version: "3.0.0" } });
			expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toMatchObject({ public: false });

			await primaryStates.delete(pluginId);
			const freshPrimarySession = scoped(true);
			await runWithContext({ db: freshPrimarySession.db, editMode: false }, () =>
				runtime!.refreshInstalledPluginRoute(pluginId),
			);
			await expect(
				dispatchPluginApiRequest({
					runtime,
					pluginId,
					path: "/submit",
					request: new Request("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
				}),
			).resolves.toMatchObject({ status: 404 });
		});

		it("keeps DO required-primary refreshes off a stale replica", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, [], true);
			await putBundle(storage, source, "2.0.0", false, pluginId, [], false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			replica = await setupTestDatabase();
			const primaryStates = new PluginStateRepository(runtime.db);
			const replicaStates = new PluginStateRepository(replica);
			await primaryStates.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			await replicaStates.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			testBindings.DB_DO = createRoutingDoNamespace(runtime.db, replica);
			const cookies = { get: vi.fn(), set: vi.fn() };
			const required = createDoRequestScopedDb({
				config: { binding: "DB_DO", session: "auto" },
				isAuthenticated: false,
				isWrite: false,
				cookies,
				url: new URL("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
				requirePrimary: true,
			})!;
			const ordinary = createDoRequestScopedDb({
				config: { binding: "DB_DO", session: "auto" },
				isAuthenticated: false,
				isWrite: false,
				cookies,
				url: new URL("https://example.test/"),
			})!;
			await runtime.refreshInstalledPluginRoute(pluginId);
			await runWithContext({ db: required.db, editMode: false }, () =>
				runtime!.refreshInstalledPluginRoute(pluginId),
			);
			await expect(
				dispatchPluginApiRequest({
					runtime,
					pluginId,
					path: "/submit",
					request: new Request("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
				}),
			).resolves.toMatchObject({ status: 401 });
			expect(await new PluginStateRepository(ordinary.db).get(pluginId)).toMatchObject({
				version: "1.0.0",
			});
		});

		it("rechecks primary after an interleaved refresh from a newer request", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, [], true);
			await putBundle(storage, source, "2.0.0", false, pluginId, [], false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			replica = await setupTestDatabase();
			const primaryStates = new PluginStateRepository(runtime.db);
			const replicaStates = new PluginStateRepository(replica);
			await primaryStates.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await replicaStates.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			testBindings.DB = createRoutingD1Binding(runtime.db, replica);
			const cookies = { get: vi.fn(), set: vi.fn() };
			const scoped = () =>
				createD1RequestScopedDb({
					config: { binding: "DB", session: "auto" },
					isAuthenticated: false,
					isWrite: false,
					cookies,
					url: new URL("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
					requirePrimary: true,
				})!;
			let releaseA!: () => void;
			const aReleased = new Promise<void>((resolve) => (releaseA = resolve));
			let pausedA = false;
			const aStateReads = new Set<unknown>();
			const aDb = scoped().db.withPlugin({
				transformQuery: ({ node, queryId }) => {
					const query = runtime!.db.getExecutor().compileQuery(node, queryId);
					if (!pausedA && query.sql.includes("_plugin_state")) aStateReads.add(queryId);
					return node;
				},
				async transformResult({ result, queryId }) {
					if (!pausedA && aStateReads.has(queryId)) {
						pausedA = true;
						await aReleased;
					}
					return result;
				},
			} satisfies KyselyPlugin);
			const a = runWithContext({ db: aDb, editMode: false }, () =>
				runtime!.refreshInstalledPluginRoute(pluginId),
			);
			const aRejectionHandled = a.catch(() => undefined);
			try {
				await vi.waitFor(() => expect(pausedA).toBe(true));
				await primaryStates.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
				const b = scoped();
				await runWithContext({ db: b.db, editMode: false }, () =>
					runtime!.refreshInstalledPluginRoute(pluginId),
				);
				expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toMatchObject({ public: false });
				releaseA();
				await expect(a).resolves.toBeUndefined();
				expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toMatchObject({ public: false });
				invokeRoute = async () => undefined;
				expect(await get(runtime)).toMatchObject({ success: true, data: { version: "2.0.0" } });
				await expect(
					dispatchPluginApiRequest({
						runtime,
						pluginId,
						path: "/submit",
						request: new Request("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
					}),
				).resolves.toMatchObject({ status: 401 });
			} finally {
				releaseA();
				await a.catch(() => undefined);
				await aRejectionHandled;
			}
		});

		it("serializes concurrent refreshes after a DB-only install", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));

			storage.pauseNextDownload();
			const firstRefresh = runtime.refreshInstalledPluginRoute(pluginId);
			await storage.downloadStarted;
			const secondRefresh = runtime.refreshInstalledPluginRoute(pluginId);
			storage.resumeDownload();
			await Promise.all([firstRefresh, secondRefresh]);

			expect(deps.runnerLoad).toHaveBeenCalledTimes(1);
			invokeRoute = async () => undefined;
			expect(await post(runtime)).toMatchObject({
				success: true,
				data: { version: "1.0.0" },
			});
		});

		it("does not refresh routes when the cold-start sandbox probe was unavailable", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			const deps = createDeps(storage, source);
			deps.runnerIsAvailable.mockReturnValue(false);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			const probesAtStartup = deps.runnerIsAvailable.mock.calls.length;
			await runtime.refreshInstalledPluginRoute(pluginId);
			await runtime.refreshInstalledPluginRoute("unknown-plugin");
			expect(storage.downloadCount).toBe(0);
			expect(deps.runnerLoad).not.toHaveBeenCalled();
			expect(deps.runnerIsAvailable).toHaveBeenCalledTimes(probesAtStartup);
			expect(await get(runtime)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
		});

		it("does not probe availability during requested refreshes", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const coldStartCalls = deps.runnerIsAvailable.mock.calls.length;
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await runtime.refreshInstalledPluginRoute(pluginId);
			await runtime.refreshInstalledPluginRoute(pluginId);
			expect(deps.runnerIsAvailable).toHaveBeenCalledTimes(coldStartCalls);
			await syncPlugins(runtime, source);
			expect(deps.runnerIsAvailable).toHaveBeenCalledTimes(coldStartCalls + 1);
		});

		it("does not reload an unchanged plugin", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await runtime.refreshInstalledPluginRoute(pluginId);
			storage.failDownloads = true;

			await expect(runtime.refreshInstalledPluginRoute(pluginId)).resolves.toBeUndefined();
			expect(deps.runnerLoad).toHaveBeenCalledTimes(1);
		});

		it("backs off a failed refresh, then retries after five seconds", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			deps.runnerLoad
				.mockRejectedValueOnce(new Error("Sandbox unavailable"))
				.mockRejectedValueOnce(new Error("Sandbox unavailable"));
			const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			try {
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Sandbox unavailable",
				);
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Sandbox unavailable",
				);
				expect(deps.runnerLoad).toHaveBeenCalledTimes(1);
				now.mockReturnValue(1_005_001);
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Sandbox unavailable",
				);
				expect(deps.runnerLoad).toHaveBeenCalledTimes(2);
				now.mockReturnValue(1_010_002);
				await runtime.refreshInstalledPluginRoute(pluginId);
				invokeRoute = async () => undefined;
				expect(await get(runtime)).toMatchObject({ success: true, data: { version: "1.0.0" } });
			} finally {
				now.mockRestore();
			}
		});

		it("retries unavailable bundles only when state changes or backoff expires", async () => {
			const storage = new MemoryStorage();
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
			try {
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Plugin bundle unavailable",
				);
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Plugin bundle unavailable",
				);
				expect(storage.downloadCount).toBe(1);

				await putBundle(storage, source, "2.0.0", false);
				await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
				await runtime.refreshInstalledPluginRoute(pluginId);
				expect(storage.downloadCount).toBeGreaterThan(1);
				const successfulDownloads = storage.downloadCount;

				storage.failDownloads = true;
				await states.upsert(pluginId, "3.0.0", "active", stateOptions(source, "3.0.0"));
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Plugin bundle unavailable",
				);
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Plugin bundle unavailable",
				);
				expect(storage.downloadCount).toBe(successfulDownloads + 1);
				now.mockReturnValue(2_005_001);
				await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
					"Plugin bundle unavailable",
				);
				expect(storage.downloadCount).toBe(successfulDownloads + 2);
			} finally {
				now.mockRestore();
			}
		});

		it("refreshes install, update, and uninstall state for the requested route", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await runtime.refreshInstalledPluginRoute(pluginId);
			invokeRoute = async () => undefined;
			await expect(post(runtime)).resolves.toMatchObject({
				success: true,
				data: { version: "1.0.0" },
			});

			await putBundle(storage, source, "2.0.0", false);
			await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			await runtime.refreshInstalledPluginRoute(pluginId);
			await expect(post(runtime)).resolves.toMatchObject({
				success: true,
				data: { version: "2.0.0" },
			});

			await states.delete(pluginId);
			await runtime.refreshInstalledPluginRoute(pluginId);
			invokeRoute = vi.fn(async () => ({ unexpected: true }));
			expect(await get(runtime)).toMatchObject({
				success: false,
				error: { code: "NOT_FOUND" },
			});
			expect(invokeRoute).not.toHaveBeenCalled();
		});

		it("isolates a broken requested plugin from a healthy plugin refresh", async () => {
			const badPluginId = "broken-plugin";
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			await putBundle(storage, source, "1.0.0", false, badPluginId);
			const deps = createDeps(storage, source);
			deps.runnerLoad.mockImplementation(
				async (loadedManifest: { id: string; version: string }) => {
					if (loadedManifest.id === badPluginId) throw new Error("Broken plugin");
					return {
						id: `${loadedManifest.id}:${loadedManifest.version}`,
						invokeHook: vi.fn(async () => undefined),
						invokeRoute: async (...args: Parameters<SandboxedPluginInstance["invokeRoute"]>) =>
							(await invokeRoute(...args)) ?? { version: loadedManifest.version },
						terminate: vi.fn(async () => undefined),
					};
				},
			);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await states.upsert(
				badPluginId,
				"1.0.0",
				"active",
				stateOptions(source, "1.0.0", badPluginId),
			);

			await runtime.refreshInstalledPluginRoute(pluginId);
			invokeRoute = async () => undefined;
			expect(await post(runtime)).toMatchObject({ success: true, data: { version: "1.0.0" } });
			expect(deps.runnerLoad).toHaveBeenCalledTimes(1);

			await expect(runtime.refreshInstalledPluginRoute(badPluginId)).rejects.toThrow(
				"Broken plugin",
			);
			await expect(syncPlugins(runtime, source)).resolves.toBeUndefined();
		});

		it("syncs a new unique declaration before an updated route executes", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await syncPlugins(runtime, source);

			invokeRoute = async () => ({ ok: true });
			expect(await post(runtime)).toMatchObject({ success: true });
			const repository = new PluginStorageRepository<{ externalId: string }>(
				runtime.db,
				pluginId,
				"records",
				["externalId"],
			);
			await repository.put("one", { externalId: "duplicate" });
			await repository.put("two", { externalId: "duplicate" });

			await putBundle(storage, source, "2.0.0", true);
			await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			await syncPlugins(runtime, source);
			const failed = await syncDeclaredStorageIndexes(runtime.db, [manifest("2.0.0", true)]);
			expect(failed.ok).toBe(false);

			invokeRoute = vi.fn(async () => ({ ok: true }));
			expect(await post(runtime)).toMatchObject({
				success: false,
				error: { code: "STORAGE_INDEXES_NOT_READY" },
			});
			expect(invokeRoute).not.toHaveBeenCalled();

			await repository.delete("two");
			let indexesSeenByRoute: string[] = [];
			invokeRoute = vi.fn(async () => {
				indexesSeenByRoute = (
					await runtime!.db.selectFrom("_plugin_indexes").select("index_name").execute()
				).map((row) => row.index_name);
				return { ok: true };
			});
			expect(await post(runtime)).toMatchObject({ success: true });
			expect(indexesSeenByRoute).toContain(
				generateIndexName(pluginId, "records", ["externalId"], { unique: true }),
			);
		});

		it.each(["plugin", "all"] as const)(
			"does not let an old %s-plugin sync undo a new version's indexes",
			async (target) => {
				const storage = new MemoryStorage();
				await putBundle(storage, source, "1.0.0", false);
				runtime = await EmDashRuntime.create(createDeps(storage, source));
				const states = new PluginStateRepository(runtime.db);
				await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
				await syncPlugins(runtime, source);

				let releaseOldSync!: () => void;
				const oldSyncReleased = new Promise<void>((resolve) => {
					releaseOldSync = resolve;
				});
				let oldSyncPaused!: () => void;
				const oldSyncPause = new Promise<void>((resolve) => {
					oldSyncPaused = resolve;
				});
				const pausedQueryIds = new Set<unknown>();
				const oldSyncDb = runtime.db.withPlugin({
					transformQuery: ({ node, queryId }) => {
						const query = runtime!.db.getExecutor().compileQuery(node, queryId);
						if (
							query.sql.toUpperCase().includes("SELECT") &&
							query.sql.includes("_plugin_indexes") &&
							query.parameters.includes(pluginId)
						) {
							pausedQueryIds.add(queryId);
							oldSyncPaused();
						}
						return node;
					},
					async transformResult({ queryId, result }) {
						if (pausedQueryIds.has(queryId)) await oldSyncReleased;
						return result;
					},
				} satisfies KyselyPlugin);

				let oldSyncFinished = false;
				const oldSync = runWithContext({ editMode: false, db: oldSyncDb }, () =>
					runtime!.ensureStorageIndexesSynced(target === "plugin" ? pluginId : undefined),
				).then((result) => {
					oldSyncFinished = true;
					return result;
				});

				let newPost: Promise<unknown> | undefined;
				try {
					await oldSyncPause;
					await putBundle(storage, source, "2.0.0", true);
					await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
					await syncPlugins(runtime, source);

					let routeSawOldSyncFinished = false;
					invokeRoute = vi.fn(async () => {
						routeSawOldSyncFinished = oldSyncFinished;
						return { ok: true };
					});
					newPost = post(runtime);
					await new Promise((resolve) => setImmediate(resolve));
					expect(routeSawOldSyncFinished).toBe(false);
					expect(invokeRoute).not.toHaveBeenCalled();

					releaseOldSync();
					await expect(oldSync).resolves.toBe(false);
					expect(await newPost).toMatchObject({ success: true });
					expect(routeSawOldSyncFinished).toBe(true);

					const repository = new PluginStorageRepository<{ externalId: string }>(
						runtime.db,
						pluginId,
						"records",
						["externalId"],
					);
					await repository.put("one", { externalId: "duplicate" });
					await expect(repository.put("two", { externalId: "duplicate" })).rejects.toThrow();
				} finally {
					releaseOldSync();
					await oldSync.catch(() => undefined);
					await newPost?.catch(() => undefined);
				}
			},
		);

		it("rebuilds a reclaimed pipeline claim even when the cached version is unchanged", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, ["plugin:activate"]);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));

			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let paused = false;
			const pausedQueryIds = new Set<unknown>();
			const queryDb = runtime.db.withPlugin({
				transformQuery: ({ node, queryId }) => {
					const query = runtime!.db.getExecutor().compileQuery(node, queryId);
					if (!paused && /\bfrom "options"/i.test(query.sql)) {
						paused = true;
						pausedQueryIds.add(queryId);
					}
					return node;
				},
				async transformResult({ queryId, result }) {
					if (pausedQueryIds.has(queryId)) await released;
					return result;
				},
			} satisfies KyselyPlugin);
			const now = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
			let first: Promise<void> | undefined;
			let second: Promise<void> | undefined;
			try {
				first = runWithContext({ editMode: false, db: queryDb }, () =>
					runtime!.refreshInstalledPluginRoute(pluginId),
				);
				await vi.waitFor(() => expect(paused).toBe(true));
				now.mockReturnValue(3_020_001);
				second = runtime.refreshInstalledPluginRoute(pluginId);
				await expect(second).resolves.toBeUndefined();
				expect(runtime.hooks.getHookCount("plugin:activate")).toBeGreaterThan(0);
				await runtime.hooks.runPluginActivate(pluginId);
				expect(deps.runnerInvokeHook).toHaveBeenCalledWith("plugin:activate", {});
				const publishedPipeline = runtime.hooks;
				release();
				await expect(first).rejects.toThrow("superseded");
				expect(runtime.hooks).toBe(publishedPipeline);
			} finally {
				release();
				await first?.catch(() => undefined);
				await second?.catch(() => undefined);
				now.mockRestore();
			}
		});

		it("does not retain readiness after removal and reinstall", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await syncPlugins(runtime, source);
			invokeRoute = async () => ({ ok: true });
			await post(runtime);

			await states.delete(pluginId);
			await syncPlugins(runtime, source);
			await removeAllPluginIndexes(runtime.db, pluginId);
			await putBundle(storage, source, "2.0.0", true);
			await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			await syncPlugins(runtime, source);

			let indexesSeenByRoute: string[] = [];
			invokeRoute = async () => {
				indexesSeenByRoute = (
					await runtime!.db.selectFrom("_plugin_indexes").select("index_name").execute()
				).map((row) => row.index_name);
				return { ok: true };
			};
			await post(runtime);
			expect(indexesSeenByRoute).toContain(
				generateIndexName(pluginId, "records", ["externalId"], { unique: true }),
			);
		});
	},
);
