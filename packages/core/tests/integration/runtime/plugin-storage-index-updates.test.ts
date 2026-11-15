import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import type { KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import {
	generateIndexName,
	removeAllPluginIndexes,
	syncDeclaredStorageIndexes,
} from "../../../src/plugins/storage-indexes.js";
import { runWithContext } from "../../../src/request-context.js";
import type { Storage } from "../../../src/storage/types.js";

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

function manifest(version: string, unique = false, id = pluginId) {
	return {
		id,
		version,
		capabilities: [],
		allowedHosts: [],
		storage: {
			records: { indexes: ["status"], ...(unique ? { uniqueIndexes: ["externalId"] } : {}) },
		},
		hooks: [],
		routes: [{ name: "submit", public: true }],
		admin: {},
	};
}

function createDeps(
	storage: MemoryStorage,
	source: "registry" | "marketplace",
): RuntimeDependencies & { runnerLoad: ReturnType<typeof vi.fn> } {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn(async (loadedManifest: { id: string; version: string }) => ({
			id: `${loadedManifest.id}:${loadedManifest.version}`,
			invokeHook: vi.fn(async () => undefined),
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
	};
}

async function putBundle(
	storage: MemoryStorage,
	source: "registry" | "marketplace",
	version: string,
	unique: boolean,
	id = pluginId,
): Promise<void> {
	storage.putText(
		`${source}/${id}/${version}/manifest.json`,
		JSON.stringify(manifest(version, unique, id)),
	);
	storage.putText(`${source}/${id}/${version}/backend.js`, "export default {};");
}

function stateOptions(source: "registry" | "marketplace", version: string, id = pluginId) {
	return source === "marketplace"
		? { source, marketplaceVersion: version }
		: { source, registryPublisherDid: "did:plc:test", registrySlug: id };
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
		afterEach(async () => {
			await runtime?.shutdown();
			runtime = undefined;
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

		it("propagates a sandbox load failure and retries on the next refresh", async () => {
			const storage = new MemoryStorage();
			await putBundle(storage, source, "1.0.0", false);
			const deps = createDeps(storage, source);
			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			await states.upsert(pluginId, "1.0.0", "active", stateOptions(source, "1.0.0"));
			deps.runnerLoad.mockRejectedValueOnce(new Error("Sandbox unavailable"));
			await expect(runtime.refreshInstalledPluginRoute(pluginId)).rejects.toThrow(
				"Sandbox unavailable",
			);
			await runtime.refreshInstalledPluginRoute(pluginId);
			invokeRoute = async () => undefined;
			expect(await get(runtime)).toMatchObject({ success: true, data: { version: "1.0.0" } });
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
