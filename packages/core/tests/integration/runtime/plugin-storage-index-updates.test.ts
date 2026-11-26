import { randomUUID } from "node:crypto";

import { sql, SqliteDialect } from "kysely";
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { handleMarketplaceUninstall } from "../../../src/api/handlers/marketplace.js";
import { handleRegistryUninstall } from "../../../src/api/handlers/registry.js";
import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { CronAccessImpl } from "../../../src/plugins/cron.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import {
	disableRuntimePlugin,
	enableRuntimePlugin,
	type PluginLifecycleRuntime,
} from "../../../src/plugins/lifecycle.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import {
	PLUGIN_STATE_GENERATION_OPTION,
	PluginStateRepository,
} from "../../../src/plugins/state.js";
import {
	generateIndexName,
	removeAllPluginIndexes,
	syncDeclaredStorageIndexes,
} from "../../../src/plugins/storage-indexes.js";
import { runWithContext } from "../../../src/request-context.js";
import type { Storage } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

class MemoryStorage implements Storage {
	private files = new Map<string, Uint8Array>();
	failDownloads = false;
	downloadCount = 0;
	private downloadGate: Promise<void> | undefined;
	private releaseDownload: (() => void) | undefined;
	private signalDownloadStarted: (() => void) | undefined;
	downloadStarted = Promise.resolve();

	putText(key: string, value: string): void {
		this.files.set(key, new TextEncoder().encode(value));
	}
	pauseNextDownload(): void {
		this.downloadStarted = new Promise((resolve) => (this.signalDownloadStarted = resolve));
		this.downloadGate = new Promise((resolve) => (this.releaseDownload = resolve));
	}
	resumeDownload(): void {
		this.releaseDownload?.();
		this.releaseDownload = undefined;
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
	async download(key: string) {
		this.downloadCount++;
		if (this.failDownloads) throw new Error("Storage unavailable");
		const gate = this.downloadGate;
		if (gate) {
			this.downloadGate = undefined;
			this.signalDownloadStarted?.();
			this.signalDownloadStarted = undefined;
			await gate;
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
		load: vi.fn(async (m: { id: string; version: string }) => ({
			id: `${m.id}:${m.version}`,
			invokeHook: runnerInvokeHook,
			invokeRoute: async (...args: Parameters<SandboxedPluginInstance["invokeRoute"]>) =>
				(await invokeRoute(...args)) ?? { version: m.version },
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
) {
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
async function syncPlugins(runtime: EmDashRuntime, source: "registry" | "marketplace") {
	if (source === "marketplace") await runtime.syncMarketplacePlugins();
	else await runtime.syncRegistryPlugins();
}
async function post(runtime: EmDashRuntime) {
	return runtime.handlePluginApiRoute(
		pluginId,
		"POST",
		"/submit",
		new Request(`https://example.test/_emdash/api/plugins/${pluginId}/submit`, { method: "POST" }),
	);
}
async function get(runtime: EmDashRuntime) {
	return runtime.handlePluginApiRoute(
		pluginId,
		"GET",
		"/submit",
		new Request(`https://example.test/_emdash/api/plugins/${pluginId}/submit`),
	);
}
function countingDb(
	database: EmDashRuntime["db"],
	counts: { generation: number; snapshot: number },
) {
	return database.withPlugin({
		transformQuery: ({ node }) => {
			const q = database.getExecutor().compileQuery(node);
			if (q.parameters.includes(PLUGIN_STATE_GENERATION_OPTION) && !q.sql.includes("_plugin_state"))
				counts.generation++;
			if (q.sql.includes("_plugin_state")) counts.snapshot++;
			return node;
		},
		transformResult: async ({ result }) => result,
	} satisfies KyselyPlugin);
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
			invokeRoute = async () => undefined;
		});

		it("skips installed-plugin refreshes for configured plugin routes", async () => {
			const storage = new MemoryStorage();
			const deps = createDeps(storage, source);
			const configuredId = "configured-plugin";
			deps.plugins = [
				definePlugin({
					id: configuredId,
					version: "1.0.0",
					routes: { health: { public: true, handler: async () => ({ ok: true }) } },
				}),
			];
			runtime = await EmDashRuntime.create(deps);
			const counts = { generation: 0, snapshot: 0 };
			const db = countingDb(runtime.db, counts);
			const downloads = storage.downloadCount;
			const probes = deps.runnerIsAvailable.mock.calls.length;
			expect(runtime.mayNeedInstalledPluginRefresh(configuredId)).toBe(false);
			await runWithContext({ db, editMode: false }, () =>
				runtime!.refreshInstalledPluginRoute(configuredId),
			);
			const response = await runWithContext({ db, editMode: false }, () =>
				dispatchPluginApiRequest({
					runtime: runtime!,
					pluginId: configuredId,
					path: "/health",
					request: new Request(`https://example.test/_emdash/api/plugins/${configuredId}/health`),
				}),
			);
			expect(response.status).toBe(200);
			expect(counts.generation).toBe(0);
			expect(counts.snapshot).toBe(0);
			expect(storage.downloadCount).toBe(downloads);
			expect(deps.runnerIsAvailable).toHaveBeenCalledTimes(probes);
		});

		it("applies only newer generation snapshots and never lets a stale replica undo them", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, [], true);
			await putBundle(storage, source, "2.0.0", false, pluginId, [], false);
			await putBundle(storage, source, "3.0.0", false, pluginId, [], false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			replica = await setupTestDatabase();
			const primary = new PluginStateRepository(runtime.db);
			const secondary = new PluginStateRepository(replica);
			await primary.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await secondary.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await primary.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			await runtime.refreshPluginState();
			const counts = { generation: 0, snapshot: 0 };
			const stale = countingDb(replica, counts);
			expect(await secondary.getGeneration()).toBeLessThan(await primary.getGeneration());
			const requestFromReplica = () =>
				runWithContext({ db: stale, editMode: false }, async () => {
					await runtime!.refreshPluginState(pluginId);
					return dispatchPluginApiRequest({
						runtime: runtime!,
						pluginId,
						path: "/submit",
						request: new Request("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
					});
				});
			expect((await requestFromReplica()).status).toBe(401);
			expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toMatchObject({ public: false });
			expect(counts.generation).toBe(1);
			expect(counts.snapshot).toBe(0);
			await primary.upsert(pluginId, "3.0.0", "active", stateOptions(source, "3.0.0"));
			await runtime.refreshPluginState();
			expect(await get(runtime)).toMatchObject({ success: true, data: { version: "3.0.0" } });
			await primary.delete(pluginId);
			await runtime.refreshPluginState();
			expect((await requestFromReplica()).status).toBe(404);
			expect(counts.generation).toBe(2);
			expect(counts.snapshot).toBe(0);
		});

		it("does not allow an old generation to win an interleaved refresh", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			await putBundle(storage, source, "2.0.0", false, pluginId, [], false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			replica = await setupTestDatabase();
			const primary = new PluginStateRepository(runtime.db);
			const secondary = new PluginStateRepository(replica);
			await primary.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await secondary.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let paused = false;
			const pausedIds = new Set<unknown>();
			const aDb = replica.withPlugin({
				transformQuery: ({ node, queryId }) => {
					const q = runtime!.db.getExecutor().compileQuery(node, queryId);
					if (
						!paused &&
						q.parameters.includes(PLUGIN_STATE_GENERATION_OPTION) &&
						!q.sql.includes("_plugin_state")
					) {
						pausedIds.add(queryId);
					}
					return node;
				},
				async transformResult({ queryId, result }) {
					if (pausedIds.has(queryId)) {
						paused = true;
						await released;
					}
					return result;
				},
			} satisfies KyselyPlugin);
			const a = runWithContext({ db: aDb, editMode: false }, () =>
				runtime!.refreshPluginState(pluginId),
			);
			try {
				await vi.waitFor(() => expect(paused).toBe(true));
				await primary.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
				await runtime.refreshPluginState();
				release();
				await expect(a).resolves.toBeUndefined();
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
				release();
				await a.catch(() => undefined);
			}
		});

		it("allows an intentional version rollback published at a newer generation", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			await putBundle(storage, source, "2.0.0", false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			await runtime.refreshInstalledPluginRoute(pluginId);
			invokeRoute = async () => undefined;
			expect(await get(runtime)).toMatchObject({ success: true, data: { version: "2.0.0" } });
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await runtime.refreshInstalledPluginRoute(pluginId);
			expect(await get(runtime)).toMatchObject({ success: true, data: { version: "1.0.0" } });
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

		it.each([false, true])(
			"runs uninstall lifecycle after disable without duplicating deactivation (deleteData=%s)",
			async (deleteData) => {
				const storage = new MemoryStorage();
				await putBundle(storage, source, "1.0.0", false, pluginId, [
					"plugin:deactivate",
					"plugin:uninstall",
				]);
				const deps = createDeps(storage, source);
				runtime = await EmDashRuntime.create(deps);
				const states = new PluginStateRepository(runtime.db);
				await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
				await syncPlugins(runtime, source);

				await expect(disableRuntimePlugin(runtime, pluginId)).resolves.toMatchObject({
					success: true,
				});
				const deactivations = deps.runnerInvokeHook.mock.calls.filter(
					([hook]) => hook === "plugin:deactivate",
				);
				expect(deactivations).toHaveLength(1);

				const uninstall =
					source === "registry"
						? handleRegistryUninstall(runtime.db, storage, pluginId, {
								deleteData,
								beforeDelete: () => runtime!.runPluginUninstallLifecycle(pluginId, deleteData),
							})
						: handleMarketplaceUninstall(runtime.db, storage, pluginId, {
								deleteData,
								beforeDelete: () => runtime!.runPluginUninstallLifecycle(pluginId, deleteData),
							});
				await expect(uninstall).resolves.toMatchObject({ success: true });
				await syncPlugins(runtime, source);

				expect(deps.runnerInvokeHook).toHaveBeenCalledWith("plugin:uninstall", { deleteData });
				expect(
					deps.runnerInvokeHook.mock.calls.filter(([hook]) => hook === "plugin:deactivate"),
				).toHaveLength(1);
			},
		);

		it("warns when superseded uninstall cleanup skips remaining cleanup", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, ["plugin:uninstall"]);
			const deps = createDeps(storage, source);
			const instances: Array<{ active: boolean }> = [];
			let releaseHook!: () => void;
			const hookReleased = new Promise<void>((resolve) => (releaseHook = resolve));
			let uninstallEntered = false;
			const uninstallStarted = new Promise<void>((resolve) => {
				deps.runnerInvokeHook.mockImplementation(async (hook: string) => {
					if (hook !== "plugin:uninstall") return;
					uninstallEntered = true;
					expect(instances.at(-1)?.active).toBe(true);
					resolve();
					await hookReleased;
				});
			});
			deps.runnerLoad.mockImplementation(async (m: { id: string; version: string }) => {
				const state = { active: true };
				instances.push(state);
				return {
					id: `${m.id}:${m.version}`,
					invokeHook: async (hook: string, event: unknown) => deps.runnerInvokeHook(hook, event),
					invokeRoute: async () => ({ version: m.version }),
					setActive: (active: boolean) => {
						state.active = active;
					},
					terminate: vi.fn(async () => undefined),
				};
			});
			const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			let cleanup: Promise<void> | undefined;
			try {
				runtime = await EmDashRuntime.create(deps);
				const states = new PluginStateRepository(runtime.db);
				await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
				await syncPlugins(runtime, source);
				await states.disable(pluginId, "1.0.0");
				await syncPlugins(runtime, source);
				expect(instances[0]?.active).toBe(false);
				expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toBeNull();

				cleanup = runtime.runPluginUninstallLifecycle(pluginId, false);
				await uninstallStarted;
				now.mockReturnValue(1_016_001);
				await syncPlugins(runtime, source);
				expect(instances.at(-1)?.active).toBe(false);
				expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toBeNull();

				releaseHook();
				await cleanup;
				expect(uninstallEntered).toBe(true);
				expect(warning.mock.calls.flat().join(" ")).toContain("Uninstall cleanup");
				expect(warning.mock.calls.flat().join(" ")).toContain("superseded");
				expect(warning.mock.calls.flat().join(" ")).toContain("remaining cleanup was skipped");
				expect(await states.get(pluginId)).toMatchObject({ status: "inactive" });
			} finally {
				releaseHook();
				await cleanup?.catch(() => undefined);
				warning.mockRestore();
				now.mockRestore();
			}
		});

		it.skipIf(source !== "marketplace")(
			"recovers an inactive bypassed marketplace plugin for deactivation after sync removes it",
			async () => {
				const storage = new MemoryStorage();
				await putBundle(storage, "marketplace", "1.0.0", false);
				const keyName = `emdash:test:bypass-deactivate:${randomUUID()}`;
				const key = Symbol.for(keyName);
				const calls = { deactivate: 0, uninstall: [] as boolean[] };
				const globals = globalThis as Record<symbol, unknown>;
				globals[key] = calls;
				storage.putText(
					`marketplace/${pluginId}/1.0.0/backend.js`,
					`const calls = globalThis[Symbol.for(${JSON.stringify(keyName)})];
				export default { hooks: {
					"plugin:deactivate": async () => { calls.deactivate++; },
					"plugin:uninstall": async (event) => { calls.uninstall.push(event.deleteData); }
				} };`,
				);
				const deps = createDeps(storage, "marketplace");
				deps.sandboxBypassed = true;
				try {
					runtime = await EmDashRuntime.create(deps);
					const states = new PluginStateRepository(runtime.db);
					await states.upsert(pluginId, "1.0.0", "active", stateOptions("marketplace", "1.0.0"));
					await runtime.syncMarketplacePlugins();
					expect(runtime.configuredPlugins.some((plugin) => plugin.id === pluginId)).toBe(true);

					await states.disable(pluginId, "1.0.0");
					const oldGeneration = states.getLastWrittenGeneration();
					await states.upsert("unrelated-plugin", "1.0.0", "inactive", { source: "config" });
					await runtime.syncMarketplacePlugins();
					expect(runtime.configuredPlugins.some((plugin) => plugin.id === pluginId)).toBe(false);

					await runtime.setPluginStatus(pluginId, "inactive", oldGeneration);
					expect(calls.deactivate).toBe(1);
					await runtime.runPluginUninstallLifecycle(pluginId, true);
					expect(calls.uninstall).toEqual([true]);
					expect(calls.deactivate).toBe(1);
				} finally {
					delete globals[key];
				}
			},
		);

		it("serializes status changes with a snapshot refresh", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, ["plugin:activate"]);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			let paused = false;
			const ids = new Set<unknown>();
			const db = runtime.db.withPlugin({
				transformQuery: ({ node, queryId }) => {
					const q = runtime!.db.getExecutor().compileQuery(node, queryId);
					if (!paused && q.sql.includes("_plugin_state") && q.sql.includes("options")) {
						paused = true;
						ids.add(queryId);
					}
					return node;
				},
				async transformResult({ queryId, result }) {
					if (ids.has(queryId)) await released;
					return result;
				},
			} satisfies KyselyPlugin);
			const refresh = runWithContext({ db, editMode: false }, () => runtime!.refreshPluginState());
			try {
				await vi.waitFor(() => expect(paused).toBe(true));
				await states.upsert(pluginId, "1.0.0", "inactive", stateOptions(source, "1.0.0"));
				let disabled = false;
				const disable = runtime
					.setPluginStatus(pluginId, "inactive", states.getLastWrittenGeneration())
					.then(() => {
						disabled = true;
						return undefined;
					});
				await new Promise((resolve) => setImmediate(resolve));
				expect(disabled).toBe(false);
				release();
				await refresh;
				await disable;
				expect(await get(runtime)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
				expect(runtime.hooks.getHookCount("plugin:activate")).toBe(0);
			} finally {
				release();
				await refresh.catch(() => undefined);
			}
		});

		it("runs activation after a newer unrelated generation refresh", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, ["plugin:activate"]);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "inactive", stateOptions(source, "1.0.0"));
			await runtime.refreshPluginState();

			await states.enable(pluginId, "1.0.0");
			const generation = states.getLastWrittenGeneration();
			expect(generation).toBeDefined();
			await states.upsert("unrelated-plugin", "1.0.0", "inactive", { source: "config" });
			await runtime.refreshPluginState();
			deps.runnerInvokeHook.mockClear();

			await runtime.setPluginStatus(pluginId, "active", generation);

			expect(deps.runnerInvokeHook).toHaveBeenCalledTimes(1);
			expect(deps.runnerInvokeHook).toHaveBeenCalledWith("plugin:activate", {});
		});

		it("runs deactivation after a newer unrelated generation refresh", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, ["plugin:deactivate"]);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await runtime.refreshPluginState();

			await states.disable(pluginId, "1.0.0");
			const generation = states.getLastWrittenGeneration();
			expect(generation).toBeDefined();
			await states.upsert("unrelated-plugin", "1.0.0", "inactive", { source: "config" });
			await runtime.refreshPluginState();
			deps.runnerInvokeHook.mockClear();

			await runtime.setPluginStatus(pluginId, "inactive", generation);

			expect(deps.runnerInvokeHook).toHaveBeenCalledTimes(1);
			expect(deps.runnerInvokeHook).toHaveBeenCalledWith("plugin:deactivate", {});
			expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toBeNull();
			expect(await get(runtime)).toMatchObject({
				success: false,
				error: { code: "NOT_FOUND" },
			});
		});

		it("rolls back a failed activation after a newer unrelated generation", async () => {
			let failActivation = false;
			const activated = vi.fn(async () => {
				if (failActivation) throw new Error("activation failed");
			});
			const deps = createDeps(new MemoryStorage(), source);
			deps.plugins = [
				definePlugin({
					id: "activation-rollback",
					version: "1.0.0",
					hooks: {
						"plugin:activate": activated,
					},
				}),
			];
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.disable("activation-rollback", "1.0.0");
			await runtime.setPluginStatus(
				"activation-rollback",
				"inactive",
				states.getLastWrittenGeneration(),
			);
			activated.mockClear();
			failActivation = true;
			const target = runtime;
			const delayed: PluginLifecycleRuntime = {
				db: target.db,
				configuredPlugins: target.configuredPlugins,
				sandboxedPluginEntries: target.sandboxedPluginEntries,
				syncMarketplacePlugins: () => target.syncMarketplacePlugins(),
				syncRegistryPlugins: () => target.syncRegistryPlugins(),
				setPluginStatus: async (id, status, generation) => {
					await states.upsert("unrelated-generation", "1.0.0", "inactive");
					await target.refreshPluginState();
					await target.setPluginStatus(id, status, generation);
				},
			};
			expect(await enableRuntimePlugin(delayed, "activation-rollback")).toMatchObject({
				success: false,
				error: { code: "PLUGIN_ENABLE_ERROR" },
			});
			expect(activated).toHaveBeenCalledOnce();
			expect(await states.get("activation-rollback")).toMatchObject({ status: "inactive" });
		});

		it("does not reactivate a newer disabled state when local callers share a write receipt", async () => {
			const activated = vi.fn();
			const deps = createDeps(new MemoryStorage(), source);
			deps.plugins = [
				definePlugin({
					id: "shared-status",
					version: "1.0.0",
					routes: {
						health: { public: true, handler: async () => ({ ok: true }) },
					},
					hooks: {
						"plugin:activate": async () => {
							activated();
						},
					},
				}),
			];
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.disable("shared-status", "1.0.0");
			await runtime.setPluginStatus("shared-status", "inactive", states.getLastWrittenGeneration());
			await states.enable("shared-status", "1.0.0");
			await states.disable("shared-status", "1.0.0");
			await runtime.refreshPluginState();
			activated.mockClear();
			await runtime.setPluginStatus("shared-status", "active", states.getLastWrittenGeneration());
			expect(runtime.getPluginRouteMeta("shared-status", "/health")).toBeNull();
			expect(activated).not.toHaveBeenCalled();
		});

		it("reads one generation key for unchanged state and one snapshot for a changed generation", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await runtime.refreshPluginState();
			const counts = { generation: 0, snapshot: 0 };
			const db = countingDb(runtime.db, counts);
			await runWithContext({ db, editMode: false }, () => runtime!.refreshPluginState(pluginId));
			expect(counts.generation).toBe(1);
			expect(counts.snapshot).toBe(0);
			await putBundle(storage, source, "2.0.0", false);
			await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
			counts.generation = 0;
			counts.snapshot = 0;
			await runWithContext({ db, editMode: false }, () => runtime!.refreshPluginState());
			expect(counts.snapshot).toBe(1);
		});

		it("does not block healthy routes on an unrelated bundle download", async () => {
			const unrelatedId = "slow-unrelated";
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			await putBundle(storage, source, "1.0.0", false, unrelatedId);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await runtime.refreshInstalledPluginRoute(pluginId);
			const healthyDownloads = storage.downloadCount;
			await states.upsert(
				unrelatedId,
				"1.0.0",
				"active",
				stateOptions(source, "1.0.0", unrelatedId),
			);

			const requestHealthy = async () => {
				await runtime!.refreshInstalledPluginRoute(pluginId);
				return dispatchPluginApiRequest({
					runtime: runtime!,
					pluginId,
					path: "/submit",
					request: new Request(`https://example.test/_emdash/api/plugins/${pluginId}/submit`),
				});
			};
			storage.pauseNextDownload();
			let firstFinished = false;
			const firstHealthy = requestHealthy().then(
				(response) => {
					firstFinished = true;
					return response;
				},
				(error) => {
					firstFinished = true;
					throw error;
				},
			);
			void firstHealthy.catch(() => undefined);
			let unrelatedRefresh: Promise<unknown> | undefined;
			let secondHealthy: Promise<Response> | undefined;
			try {
				await vi.waitFor(() => expect(firstFinished).toBe(true), { timeout: 1000 });
				await expect(firstHealthy).resolves.toMatchObject({ status: 200 });
				expect(storage.downloadCount).toBe(healthyDownloads);

				storage.pauseNextDownload();
				unrelatedRefresh = runtime.refreshInstalledPluginRoute(unrelatedId);
				void unrelatedRefresh.catch(() => undefined);
				await storage.downloadStarted;
				let secondFinished = false;
				secondHealthy = requestHealthy().then((response) => {
					secondFinished = true;
					return response;
				});
				void secondHealthy.catch(() => undefined);
				await vi.waitFor(() => expect(secondFinished).toBe(true), { timeout: 1000 });
				await expect(secondHealthy).resolves.toMatchObject({ status: 200 });
			} finally {
				storage.resumeDownload();
				await Promise.allSettled(
					[firstHealthy, unrelatedRefresh, secondHealthy].filter(
						(value): value is Promise<unknown> => value !== undefined,
					),
				);
			}
		});

		it("tries the full snapshot for healthy and broken plugins when generation changes", async () => {
			const bad = "broken-plugin";
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			await putBundle(storage, source, "1.0.0", false, bad);
			const deps = createDeps(storage, source);
			deps.runnerLoad.mockImplementation(async (m: { id: string; version: string }) => {
				if (m.id === bad) throw new Error("Broken plugin");
				return {
					id: `${m.id}:${m.version}`,
					invokeHook: vi.fn(),
					invokeRoute: async () => ({ version: m.version }),
					terminate: vi.fn(async () => undefined),
				};
			});
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await states.upsert(bad, "1.0.0", "active", stateOptions(source, "1.0.0", bad));
			await expect(runtime.refreshPluginState()).resolves.toBeUndefined();
			expect(await post(runtime)).toMatchObject({ success: true });
			await expect(runtime.refreshInstalledPluginRoute(bad)).rejects.toThrow("Broken plugin");
			expect(await post(runtime)).toMatchObject({ success: true });
			expect(deps.runnerLoad).toHaveBeenCalledTimes(2);
		});

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
					if (
						!paused &&
						query.parameters.some(
							(value) => typeof value === "string" && value.startsWith("emdash:exclusive_hook:"),
						)
					) {
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

		it.each(["after drop", "before drop", "pending response"] as const)(
			"reclaims an interrupted index drop before restoring a previous declaration (%s)",
			async (pausePoint) => {
				const storage = new MemoryStorage();
				await putBundle(storage, source, "1.0.0", true);
				const uniqueIndexName = generateIndexName(pluginId, "records", ["externalId"], {
					unique: true,
				});
				const deps = createDeps(storage, source);
				let releaseOldSync!: () => void;
				const oldSyncReleased = new Promise<void>((resolve) => (releaseOldSync = resolve));
				let dropPaused = false;
				let physicalDropApplied = false;
				let signalPhysicalDropApplied!: () => void;
				const physicalDropAppliedPromise = new Promise<void>((resolve) => {
					signalPhysicalDropApplied = resolve;
				});
				let releaseDropResponse!: () => void;
				const dropResponseReleased = new Promise<void>((resolve) => {
					releaseDropResponse = resolve;
				});
				let interceptDrops = false;
				if (pausePoint === "before drop" || pausePoint === "pending response") {
					const createDialect = deps.createDialect;
					deps.createDialect = (config) => {
						const dialect = createDialect(config);
						const createAdapter = dialect.createAdapter.bind(dialect);
						dialect.createAdapter = () => {
							const adapter = createAdapter();
							// D1 statements can proceed independently of a stalled request.
							Object.defineProperty(adapter, "supportsMultipleConnections", { value: true });
							return adapter;
						};
						const createDriver = dialect.createDriver.bind(dialect);
						dialect.createDriver = () => {
							const driver = createDriver();
							const acquire = driver.acquireConnection.bind(driver);
							driver.acquireConnection = async () => {
								const connection = await acquire();
								return {
									executeQuery: async (query) => {
										if (
											interceptDrops &&
											!dropPaused &&
											query.sql.toUpperCase().includes("DROP INDEX") &&
											query.sql.includes(uniqueIndexName)
										) {
											dropPaused = true;
											await oldSyncReleased;
											const result = await connection.executeQuery(query);
											if (pausePoint === "pending response") {
												physicalDropApplied = true;
												signalPhysicalDropApplied();
												await dropResponseReleased;
											}
											return result;
										}
										return connection.executeQuery(query);
									},
									streamQuery: connection.streamQuery.bind(connection),
								};
							};
							return driver;
						};
						return dialect;
					};
				}
				runtime = await EmDashRuntime.create(deps);
				const states = new PluginStateRepository(runtime.db);
				await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
				await syncPlugins(runtime, source);
				const routeHandler = vi.fn(async () => ({ ok: true }));
				invokeRoute = routeHandler;
				expect(await post(runtime)).toMatchObject({ success: true });
				routeHandler.mockClear();

				const repository = new PluginStorageRepository<{ externalId: string }>(
					runtime.db,
					pluginId,
					"records",
					["externalId"],
				);
				await repository.put("one", { externalId: "duplicate" });
				await expect(repository.put("two", { externalId: "duplicate" })).rejects.toThrow();

				await putBundle(storage, source, "2.0.0", false);
				const nextManifest = manifest("2.0.0", false);
				nextManifest.storage.records.indexes = ["status", "externalId"];
				storage.putText(`${source}/${pluginId}/2.0.0/manifest.json`, JSON.stringify(nextManifest));
				await states.upsert(pluginId, "2.0.0", "active", stateOptions(source, "2.0.0"));
				await syncPlugins(runtime, source);

				const pausedQueryIds = new Set<unknown>();
				const oldSyncDb =
					pausePoint === "before drop" || pausePoint === "pending response"
						? runtime.db
						: runtime.db.withPlugin({
								transformQuery: ({ node, queryId }) => {
									const query = runtime!.db.getExecutor().compileQuery(node, queryId);
									if (
										!dropPaused &&
										query.sql.toUpperCase().includes("DROP INDEX") &&
										query.sql.includes(`"${uniqueIndexName}"`)
									) {
										pausedQueryIds.add(queryId);
									}
									return node;
								},
								async transformResult({ queryId, result }) {
									if (pausedQueryIds.has(queryId)) {
										dropPaused = true;
										await oldSyncReleased;
									}
									return result;
								},
							} satisfies KyselyPlugin);

				const now = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
				let oldSync: Promise<boolean> | undefined;
				try {
					interceptDrops = true;
					oldSync = runWithContext({ editMode: false, db: oldSyncDb }, () =>
						runtime!.ensureStorageIndexesSynced(pluginId),
					);
					await vi.waitFor(() => expect(dropPaused).toBe(true), { timeout: 1000 });

					await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
					await syncPlugins(runtime, source);
					now.mockReturnValue(3_020_001);

					await expect(post(runtime)).resolves.toMatchObject({
						success: false,
						error: { code: "STORAGE_INDEXES_NOT_READY" },
					});
					expect(routeHandler).not.toHaveBeenCalled();

					if (pausePoint === "pending response") {
						releaseOldSync();
						await physicalDropAppliedPromise;
						expect(physicalDropApplied).toBe(true);
						await expect(post(runtime)).resolves.toMatchObject({
							success: false,
							error: { code: "STORAGE_INDEXES_NOT_READY" },
						});
						expect(routeHandler).not.toHaveBeenCalled();
					}

					releaseOldSync();
					releaseDropResponse();
					await oldSync;
					await expect(post(runtime)).resolves.toMatchObject({ success: true });
					await expect(
						repository.put("after-recovery", { externalId: "duplicate" }),
					).rejects.toThrow();

					const physicalIndex = await sql<{ name: string }>`
					SELECT name FROM sqlite_master
					WHERE type = 'index' AND name = ${uniqueIndexName}
				`.execute(runtime.db);
					expect(physicalIndex.rows).toHaveLength(1);
				} finally {
					releaseDropResponse();
					releaseOldSync();
					await oldSync?.catch(() => undefined);
					now.mockRestore();
				}
			},
		);

		it("keeps an unrelated old plugin version serving until its replacement loads", async () => {
			const storage = new MemoryStorage();
			const a = "healthy-a";
			const b = "healthy-b";
			await putBundle(storage, source, "1.0.0", false, a);
			await putBundle(storage, source, "1.0.0", false, b, ["plugin:activate"]);
			await putBundle(storage, source, "2.0.0", false, b, ["plugin:activate"]);
			for (const version of ["1.0.0", "2.0.0"]) {
				storage.putText(
					`${source}/${b}/${version}/manifest.json`,
					JSON.stringify({
						...manifest(version, false, b, ["plugin:activate"]),
						routes: [],
					}),
				);
			}
			const deps = createDeps(storage, source);
			const hookVersions: string[] = [];
			deps.runnerLoad.mockImplementation(async (m: { id: string; version: string }) => ({
				id: `${m.id}:${m.version}`,
				invokeHook: async (...args: Parameters<SandboxedPluginInstance["invokeHook"]>) => {
					if (m.id === b) hookVersions.push(m.version);
					await deps.runnerInvokeHook(...args);
				},
				invokeRoute: async () => ({ version: m.version }),
				terminate: vi.fn(async () => undefined),
			}));
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(a, "1.0.0", "active", stateOptions(source, "1.0.0", a));
			await states.upsert(b, "1.0.0", "active", stateOptions(source, "1.0.0", b));
			await syncPlugins(runtime, source);
			await runtime.hooks.runPluginActivate(b);
			hookVersions.length = 0;

			await states.upsert(b, "2.0.0", "active", stateOptions(source, "2.0.0", b));
			await runtime.refreshInstalledPluginRoute(a);
			const response = await dispatchPluginApiRequest({
				runtime,
				pluginId: a,
				path: "/submit",
				request: new Request(`https://example.test/_emdash/api/plugins/${a}/submit`, {
					method: "POST",
				}),
			});
			expect(response.status).toBe(200);
			await runtime.hooks.runPluginActivate(b);
			expect(hookVersions).toEqual(["1.0.0"]);
			expect(deps.runnerLoad).not.toHaveBeenCalledWith(
				expect.objectContaining({ id: b, version: "2.0.0" }),
			);

			await runtime.refreshPluginState();
			await runtime.hooks.runPluginActivate(b);
			expect(hookVersions).toEqual(["1.0.0", "2.0.0"]);
		});

		it("disables a plugin and cron tasks even when its bundle is unavailable", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false, pluginId, ["plugin:deactivate"]);
			runtime = await EmDashRuntime.create(createDeps(storage, source));
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			await syncPlugins(runtime, source);
			await new CronAccessImpl(runtime.db, pluginId, () => undefined).schedule("cleanup", {
				schedule: "0 * * * *",
			});

			await states.disable(pluginId, "1.0.0");
			await runtime.refreshPluginState();
			storage.failDownloads = true;
			await expect(disableRuntimePlugin(runtime, pluginId)).resolves.toMatchObject({
				success: true,
			});
			expect(await states.get(pluginId)).toMatchObject({ status: "inactive" });
			expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toBeNull();
			const task = await runtime.db
				.selectFrom("_emdash_cron_tasks")
				.select(["enabled"])
				.where("plugin_id", "=", pluginId)
				.where("task_name", "=", "cleanup")
				.executeTakeFirst();
			expect(task?.enabled).toBe(0);
		});

		it("persists lifecycle changes when sandbox instances are unavailable", async () => {
			const storage = new MemoryStorage();
			const deps = createDeps(storage, source);
			deps.runnerIsAvailable.mockReturnValue(false);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "inactive", stateOptions(source, "1.0.0"));

			await expect(enableRuntimePlugin(runtime, pluginId)).resolves.toMatchObject({
				success: true,
			});
			expect(await states.get(pluginId)).toMatchObject({ status: "active" });
			await expect(disableRuntimePlugin(runtime, pluginId)).resolves.toMatchObject({
				success: true,
			});
			expect(await states.get(pluginId)).toMatchObject({ status: "inactive" });
		});

		it.skipIf(source !== "marketplace")(
			"enables and disables bypassed marketplace hooks once per mutation",
			async () => {
				const storage = new MemoryStorage();
				await putBundle(storage, source, "1.0.0", false);
				const keyName = `emdash:test:bypass-status:${randomUUID()}`;
				const key = Symbol.for(keyName);
				const calls = { active: 0, inactive: 0 };
				const globals = globalThis as Record<symbol, unknown>;
				globals[key] = calls;
				storage.putText(
					`${source}/${pluginId}/1.0.0/backend.js`,
					`
				const calls = globalThis[Symbol.for(${JSON.stringify(keyName)})];
				export default { hooks: {
					"plugin:activate": async () => { calls.active++; },
					"plugin:deactivate": async () => { calls.inactive++; }
				} };
			`,
				);
				const deps = createDeps(storage, source);
				deps.sandboxBypassed = true;
				try {
					runtime = await EmDashRuntime.create(deps);
					const states = new PluginStateRepository(runtime.db);
					await states.upsert(pluginId, "1.0.0", "inactive", stateOptions(source, "1.0.0"));
					await expect(enableRuntimePlugin(runtime, pluginId)).resolves.toMatchObject({
						success: true,
					});
					expect(calls).toEqual({ active: 1, inactive: 0 });
					await expect(disableRuntimePlugin(runtime, pluginId)).resolves.toMatchObject({
						success: true,
					});
					expect(calls).toEqual({ active: 1, inactive: 1 });
					expect(await states.get(pluginId)).toMatchObject({ status: "inactive" });
					await expect(enableRuntimePlugin(runtime, pluginId)).resolves.toMatchObject({
						success: true,
					});
					expect(calls).toEqual({ active: 2, inactive: 1 });
					expect(deps.runnerLoad).not.toHaveBeenCalled();
				} finally {
					delete globals[key];
				}
			},
		);

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
