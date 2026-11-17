import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
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
function countingDb(runtime: EmDashRuntime, counts: { generation: number; snapshot: number }) {
	return runtime.db.withPlugin({
		transformQuery: ({ node }) => {
			const q = runtime!.db.getExecutor().compileQuery(node);
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
			const db = countingDb(runtime, counts);
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
			const stale = countingDb(runtime, counts);
			await runWithContext({ db: stale, editMode: false }, () =>
				runtime!.refreshPluginState(pluginId),
			);
			expect(runtime.getPluginRouteMeta(pluginId, "/submit")).toMatchObject({ public: false });
			expect(counts.generation).toBe(1);
			expect(counts.snapshot).toBe(0);
			await expect(
				dispatchPluginApiRequest({
					runtime,
					pluginId,
					path: "/submit",
					request: new Request("https://example.test/_emdash/api/plugins/updated-plugin/submit"),
				}),
			).resolves.toMatchObject({ status: 401 });
			await primary.upsert(pluginId, "3.0.0", "active", stateOptions(source, "3.0.0"));
			await runtime.refreshPluginState();
			expect(await get(runtime)).toMatchObject({ success: true, data: { version: "3.0.0" } });
			await primary.delete(pluginId);
			await runtime.refreshPluginState();
			await runWithContext({ db: stale, editMode: false }, () =>
				runtime!.refreshPluginState(pluginId),
			);
			await expect(get(runtime)).resolves.toMatchObject({
				success: false,
				error: { code: "NOT_FOUND" },
			});
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
			const db = countingDb(runtime, counts);
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
