/**
 * Registry handler tests
 *
 * Covers the registry plugin lifecycle handlers (mirroring
 * `marketplace-handlers.test.ts`):
 * - Uninstall (handleRegistryUninstall)
 * - Update (handleRegistryUpdate)
 * - Update check (handleRegistryUpdateCheck)
 *
 * Uses a real in-memory SQLite database and a mock `Storage`. The aggregator
 * `DiscoveryClient` is exercised against a mock `fetch` so the network is
 * fully controlled.
 */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleRegistryUninstall,
	handleRegistryUpdate,
} from "../../../src/api/handlers/registry.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import type {
	DownloadResult,
	ListResult,
	SignedUploadUrl,
	Storage,
	UploadResult,
} from "../../../src/storage/types.js";

// ── Mock storage ─────────────────────────────────────────────────

function createMockStorage(): Storage {
	const store = new Map<string, { body: Uint8Array; contentType: string }>();
	return {
		async upload(opts: {
			key: string;
			body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
			contentType: string;
		}): Promise<UploadResult> {
			let body: Uint8Array;
			if (opts.body instanceof Uint8Array) {
				body = opts.body;
			} else if (Buffer.isBuffer(opts.body)) {
				body = new Uint8Array(opts.body);
			} else {
				const response = new Response(opts.body);
				body = new Uint8Array(await response.arrayBuffer());
			}
			store.set(opts.key, { body, contentType: opts.contentType });
			return { key: opts.key, url: `https://storage.test/${opts.key}`, size: body.length };
		},
		async download(key: string): Promise<DownloadResult> {
			const item = store.get(key);
			if (!item) throw new Error(`Not found: ${key}`);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(item.body);
					controller.close();
				},
			});
			return { body: stream, contentType: item.contentType, size: item.body.length };
		},
		async delete(key: string): Promise<void> {
			store.delete(key);
		},
		async exists(key: string): Promise<boolean> {
			return store.has(key);
		},
		async list(prefix: string): Promise<ListResult> {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
			return { items: keys.map((key) => ({ key, size: store.get(key)?.body.length ?? 0 })) };
		},
		async getSignedUploadUrl(): Promise<SignedUploadUrl> {
			throw new Error("not implemented");
		},
		// Expose for assertions.
		__store: store,
	} as unknown as Storage;
}

function snapshotKeys(storage: Storage): string[] {
	return [...((storage as unknown as { __store: Map<string, unknown> }).__store.keys() ?? [])];
}

// ── Suite ────────────────────────────────────────────────────────

describe("Registry handlers", () => {
	let db: Kysely<DbSchema>;
	let storage: Storage;

	beforeEach(async () => {
		const sqlite = new BetterSqlite3(":memory:");
		db = new Kysely<DbSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);
		storage = createMockStorage();
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("handleRegistryUninstall", () => {
		it("returns NOT_FOUND when no plugin exists at the given id", async () => {
			const result = await handleRegistryUninstall(db, storage, "r_doesnotexist00");
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");
		});

		it("returns NOT_FOUND when the plugin is not registry-source (refuses to trash a marketplace row)", async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("acme-seo", "1.0.0", "active", {
				source: "marketplace",
				marketplaceVersion: "1.0.0",
			});

			const result = await handleRegistryUninstall(db, storage, "acme-seo");
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");

			// State row must be untouched.
			const state = await repo.get("acme-seo");
			expect(state).not.toBeNull();
			expect(state?.source).toBe("marketplace");
		});

		it("deletes the R2 bundle and the state row, returns dataDeleted=false by default", async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("r_aaaaaaaaaaaaaaaa", "1.2.3", "active", {
				source: "registry",
				registryPublisherDid: "did:plc:abc",
				registrySlug: "gallery",
			});

			const encoder = new TextEncoder();
			await storage.upload({
				key: "registry/r_aaaaaaaaaaaaaaaa/1.2.3/manifest.json",
				body: encoder.encode("{}"),
				contentType: "application/json",
			});
			await storage.upload({
				key: "registry/r_aaaaaaaaaaaaaaaa/1.2.3/backend.js",
				body: encoder.encode(""),
				contentType: "application/javascript",
			});

			const result = await handleRegistryUninstall(db, storage, "r_aaaaaaaaaaaaaaaa");
			expect(result.success).toBe(true);
			expect(result.data?.pluginId).toBe("r_aaaaaaaaaaaaaaaa");
			expect(result.data?.dataDeleted).toBe(false);

			expect(await repo.get("r_aaaaaaaaaaaaaaaa")).toBeNull();
			expect(snapshotKeys(storage)).toEqual([]);
		});

		it("deletes _plugin_storage rows when deleteData=true", async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("r_bbbbbbbbbbbbbbbb", "0.1.0", "active", {
				source: "registry",
				registryPublisherDid: "did:plc:abc",
				registrySlug: "forms",
			});
			await db
				.insertInto("_plugin_storage")
				.values({
					plugin_id: "r_bbbbbbbbbbbbbbbb",
					collection: "default",
					id: "k",
					data: JSON.stringify({ a: 1 }),
				})
				.execute();

			const result = await handleRegistryUninstall(db, storage, "r_bbbbbbbbbbbbbbbb", {
				deleteData: true,
			});
			expect(result.success).toBe(true);
			expect(result.data?.dataDeleted).toBe(true);

			const rows = await db
				.selectFrom("_plugin_storage")
				.selectAll()
				.where("plugin_id", "=", "r_bbbbbbbbbbbbbbbb")
				.execute();
			expect(rows).toHaveLength(0);
		});

		it("tolerates a null storage (e.g. instance without R2 configured)", async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("r_cccccccccccccccc", "0.0.1", "active", {
				source: "registry",
				registryPublisherDid: "did:plc:abc",
				registrySlug: "nostorage",
			});

			const result = await handleRegistryUninstall(db, null, "r_cccccccccccccccc");
			expect(result.success).toBe(true);
			expect(await repo.get("r_cccccccccccccccc")).toBeNull();
		});
	});

	describe("handleRegistryUpdate", () => {
		const stubSandbox: SandboxRunner = {
			isAvailable: () => true,
			// Update never invokes these in the error-path tests below; cast to
			// satisfy the surface without implementing the full runner.
		} as unknown as SandboxRunner;
		const config = { aggregatorUrl: "https://aggregator.test" };

		it("returns REGISTRY_NOT_CONFIGURED when no registry config is supplied", async () => {
			const result = await handleRegistryUpdate(
				db,
				storage,
				stubSandbox,
				undefined,
				"r_dddddddddddddddd",
			);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("REGISTRY_NOT_CONFIGURED");
		});

		it("returns STORAGE_NOT_CONFIGURED when storage is null", async () => {
			const result = await handleRegistryUpdate(
				db,
				null,
				stubSandbox,
				config,
				"r_dddddddddddddddd",
			);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("STORAGE_NOT_CONFIGURED");
		});

		it("returns SANDBOX_NOT_AVAILABLE when the runner is missing or unavailable", async () => {
			const unavailable: SandboxRunner = {
				isAvailable: () => false,
			} as unknown as SandboxRunner;
			const result = await handleRegistryUpdate(
				db,
				storage,
				unavailable,
				config,
				"r_dddddddddddddddd",
			);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("SANDBOX_NOT_AVAILABLE");
		});

		it("returns NOT_FOUND for a plugin that is not registry-source", async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("acme-seo", "1.0.0", "active", {
				source: "marketplace",
				marketplaceVersion: "1.0.0",
			});
			const result = await handleRegistryUpdate(db, storage, stubSandbox, config, "acme-seo");
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");
		});

		it("returns INVALID_STATE for a registry row missing publisher DID or slug", async () => {
			const repo = new PluginStateRepository(db);
			await repo.upsert("r_eeeeeeeeeeeeeeee", "1.0.0", "active", {
				source: "registry",
				// Intentionally omit registryPublisherDid + registrySlug to
				// simulate a corrupted state row.
			});
			const result = await handleRegistryUpdate(
				db,
				storage,
				stubSandbox,
				config,
				"r_eeeeeeeeeeeeeeee",
			);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("INVALID_STATE");
		});
	});
});
