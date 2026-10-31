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
	async download(key: string) {
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

function manifest(version: string, unique = false) {
	return {
		id: pluginId,
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
): RuntimeDependencies {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn(async (loadedManifest: { id: string; version: string }) => ({
			id: `${loadedManifest.id}:${loadedManifest.version}`,
			invokeHook: vi.fn(async () => undefined),
			invokeRoute: (...args: Parameters<SandboxedPluginInstance["invokeRoute"]>) =>
				invokeRoute(...args),
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
	};
}

async function putBundle(
	storage: MemoryStorage,
	source: "registry" | "marketplace",
	version: string,
	unique: boolean,
): Promise<void> {
	storage.putText(
		`${source}/${pluginId}/${version}/manifest.json`,
		JSON.stringify(manifest(version, unique)),
	);
	storage.putText(`${source}/${pluginId}/${version}/backend.js`, "export default {};");
}

function stateOptions(source: "registry" | "marketplace", version: string) {
	return source === "marketplace"
		? { source, marketplaceVersion: version }
		: { source, registryPublisherDid: "did:plc:test", registrySlug: pluginId };
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

describe.each(["registry", "marketplace"] as const)(
	"runtime plugin storage index updates (%s)",
	(source) => {
		let runtime: EmDashRuntime | undefined;
		afterEach(async () => {
			await runtime?.shutdown();
			runtime = undefined;
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
			expect(indexesSeenByRoute).toContain(`uidx_plugin_${pluginId}_records_externalId`);
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
			expect(indexesSeenByRoute).toContain(`uidx_plugin_${pluginId}_records_externalId`);
		});
	},
);
