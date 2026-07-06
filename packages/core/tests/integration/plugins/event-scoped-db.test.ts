/**
 * Event-scoped DB resolution (#1622)
 *
 * Long-lived subsystems built once at runtime init — the plugin context
 * factory, the cron executor, and media providers — must resolve the database
 * connection at use-time, not capture it at construction. On connection-backed
 * adapters (Postgres over Hyperdrive) the per-isolate singleton's socket is
 * bound to the request that opened it, so a later request or the Cron Trigger
 * must use the current event-scoped connection instead.
 *
 * These tests prove resolution happens per operation by pointing a resolver at
 * two independent databases and asserting each operation reads/writes the one
 * the resolver currently returns. They use plain SQLite (stateless across
 * events) where the resolver simply makes the indirection observable; the same
 * indirection is what lets Hyperdrive swap the ALS-scoped connection in.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { PluginContextFactory } from "../../../src/plugins/context.js";
import { CronExecutor } from "../../../src/plugins/cron.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { CronHandler, ResolvedHook, ResolvedPlugin } from "../../../src/plugins/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [], fieldWidgets: {} },
		hooks: {},
		routes: {},
		settings: undefined,
		...overrides,
	};
}

/** A plugin whose cron hook writes a marker through ctx.kv (always available). */
function cronMarkerPlugin(id: string): ResolvedPlugin {
	const cron: ResolvedHook<CronHandler> = {
		priority: 0,
		timeout: 5_000,
		dependencies: [],
		errorPolicy: "continue",
		exclusive: false,
		pluginId: id,
		handler: async (_event, ctx) => {
			await ctx.kv.set("ran", "yes");
		},
	};
	return createTestPlugin({ id, hooks: { cron } });
}

/** Read a raw option value (the kv store) from a db. */
async function optionValue(db: Kysely<DbSchema>, name: string): Promise<string | undefined> {
	const row = await db
		.selectFrom("options")
		.select("value")
		.where("name", "=", name)
		.executeTakeFirst();
	return row?.value;
}

async function makeDb(): Promise<Kysely<DbSchema>> {
	const db = new Kysely<DbSchema>({
		dialect: new SqliteDialect({ database: new Database(":memory:") }),
	});
	await runMigrations(db);
	return db;
}

/** Insert a single due one-shot cron task into the given db. */
async function seedDueOneshot(db: Kysely<DbSchema>, pluginId: string, taskName: string) {
	const past = new Date(Date.now() - 60_000).toISOString();
	await db
		.insertInto("_emdash_cron_tasks" as never)
		.values({
			id: `task_${taskName}`,
			plugin_id: pluginId,
			task_name: taskName,
			schedule: past,
			is_oneshot: 1,
			data: null,
			status: "idle",
			enabled: 1,
			next_run_at: past,
			locked_at: null,
			last_run_at: null,
			created_at: past,
		} as never)
		.execute();
}

describe("event-scoped DB resolution (#1622)", () => {
	let dbA: Kysely<DbSchema>;
	let dbB: Kysely<DbSchema>;

	beforeEach(async () => {
		dbA = await makeDb();
		dbB = await makeDb();
	});

	afterEach(async () => {
		await dbA.destroy();
		await dbB.destroy();
	});

	describe("PluginContextFactory", () => {
		it("resolves the connection per createContext() via getDb", async () => {
			let current = dbA;
			const getDb = vi.fn(() => current);
			// `db` is the required fallback; getDb takes precedence.
			const factory = new PluginContextFactory({ db: dbA, getDb });
			const plugin = createTestPlugin({ id: "kv-plugin" });

			// Write through a context resolved to dbB.
			current = dbB;
			const ctxWrite = factory.createContext(plugin);
			await ctxWrite.kv.set("color", "blue");

			// A context resolved to dbA must not see it (different connection).
			current = dbA;
			const ctxA = factory.createContext(plugin);
			expect(await ctxA.kv.get("color")).toBeNull();

			// Back to dbB: the value is there. Proves each createContext built its
			// repos from the currently-resolved connection, not a snapshot.
			current = dbB;
			const ctxB = factory.createContext(plugin);
			expect(await ctxB.kv.get("color")).toBe("blue");

			// Resolver consulted once per createContext call.
			expect(getDb).toHaveBeenCalledTimes(3);
		});

		it("falls back to the fixed db when getDb is omitted (stateless adapters)", async () => {
			const factory = new PluginContextFactory({ db: dbA });
			const plugin = createTestPlugin({ id: "kv-plugin" });

			const ctx = factory.createContext(plugin);
			await ctx.kv.set("k", "v");

			// Written to dbA, the fixed connection.
			const repoOptions = await dbA
				.selectFrom("options")
				.select("value")
				.where("name", "=", "plugin:kv-plugin:k")
				.executeTakeFirst();
			expect(repoOptions?.value).toBe(JSON.stringify("v"));
		});
	});

	describe("CronExecutor", () => {
		it("resolves the connection at tick time, not construction", async () => {
			let current = dbA;
			const getDb = vi.fn(() => current);
			const invoked: string[] = [];
			const executor = new CronExecutor(getDb, async (pluginId) => {
				invoked.push(pluginId);
			});

			// A due task exists only in dbB.
			await seedDueOneshot(dbB, "cron-plugin", "sweep");

			// Resolver points at dbA (empty): nothing to process.
			current = dbA;
			expect(await executor.tick()).toBe(0);
			expect(invoked).toEqual([]);

			// Repoint at dbB: the same executor now processes the due task.
			current = dbB;
			expect(await executor.tick()).toBe(1);
			expect(invoked).toEqual(["cron-plugin"]);

			// One-shot was consumed from dbB.
			const remaining = await dbB
				.selectFrom("_emdash_cron_tasks" as never)
				.selectAll()
				.execute();
			expect(remaining).toHaveLength(0);
			expect(getDb).toHaveBeenCalled();
		});

		it("accepts a plain Kysely for callers that don't need ALS", async () => {
			await seedDueOneshot(dbA, "cron-plugin", "sweep");
			const executor = new CronExecutor(dbA, async () => {});
			expect(await executor.tick()).toBe(1);
		});
	});

	describe("hook pipeline rebuild (#1622 regression)", () => {
		// rebuildHookPipeline() reconstructs the pipeline from
		// pipelineFactoryOptions. getDb must live in those options (not only in
		// the conditional email setContextFactory call), or a plugin toggle on an
		// email-less deployment would silently revert plugin contexts to the
		// singleton db.
		it("resolves via getDb when the pipeline is built from factory options", async () => {
			let current = dbA;
			const pipeline = createHookPipeline([cronMarkerPlugin("cron-hook")], {
				db: dbA,
				getDb: () => current,
			});

			current = dbB;
			const res = await pipeline.invokeCronHook("cron-hook", { name: "t" });
			expect(res.success).toBe(true);

			// Wrote to dbB (the resolved connection), not dbA (the fixed fallback).
			expect(await optionValue(dbB, "plugin:cron-hook:ran")).toBe(JSON.stringify("yes"));
			expect(await optionValue(dbA, "plugin:cron-hook:ran")).toBeUndefined();
		});

		it("keeps getDb across a setContextFactory merge (cron/email wiring)", async () => {
			let current = dbA;
			const pipeline = createHookPipeline([cronMarkerPlugin("cron-hook")], {
				db: dbA,
				getDb: () => current,
			});
			// A partial merge like the rebuild's email / cron-reschedule calls must
			// not drop the previously-set getDb.
			pipeline.setContextFactory({ cronReschedule: () => {} });

			current = dbB;
			await pipeline.invokeCronHook("cron-hook", { name: "t" });
			expect(await optionValue(dbB, "plugin:cron-hook:ran")).toBe(JSON.stringify("yes"));
		});
	});

	describe("local media provider", () => {
		it("resolves the connection per operation via getDb", async () => {
			let current = dbA;
			const getDb = vi.fn(() => current);
			const provider = createMediaProvider({ db: dbA, getDb });

			// Seed a media row into dbB only.
			await new MediaRepository(dbB).create({
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				storageKey: "media/photo.jpg",
			});

			// Resolver at dbA: empty.
			current = dbA;
			expect((await provider.list({})).items).toHaveLength(0);

			// Resolver at dbB: the row is visible without rebuilding the provider.
			current = dbB;
			const listed = await provider.list({});
			expect(listed.items).toHaveLength(1);
			expect(listed.items[0]!.filename).toBe("photo.jpg");

			expect(getDb).toHaveBeenCalled();
		});
	});

	describe("runtime schemaRegistry (#1622 regression)", () => {
		function createDeps(): RuntimeDependencies {
			return {
				config: {
					database: {
						entrypoint: `test-schema-registry-${randomUUID()}`,
						config: {},
						type: "sqlite",
					},
				},
				plugins: [],
				createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
				createStorage: null,
				sandboxEnabled: false,
				sandboxedPluginEntries: [],
				createSandboxRunner: null,
			};
		}

		it("resolves against the event-scoped db, not the captured singleton", async () => {
			// Regression: the runtime used to capture `new SchemaRegistry(parts.db)`
			// at construction. On a connection-backed adapter that singleton's
			// socket belongs to an earlier event; handleContentUpdate's catch would
			// then treat a revision-enabled collection as non-revisioned and write
			// draft edits to live columns. The registry must resolve `this.db`.
			const runtime = await EmDashRuntime.create(createDeps());
			try {
				// A separate event-scoped db with a revision-enabled collection the
				// runtime's singleton does not have.
				const scopedDb = new Kysely<DbSchema>({
					dialect: new SqliteDialect({ database: new Database(":memory:") }),
				});
				await runMigrations(scopedDb);
				await new SchemaRegistry(scopedDb).createCollection({
					slug: "widgets",
					label: "Widgets",
					supports: ["drafts", "revisions"],
				});

				try {
					// No ALS context: the registry resolves the singleton, which lacks it.
					expect(await runtime.schemaRegistry.getCollectionWithFields("widgets")).toBeNull();

					// Under the scoped db: the registry resolves it (and sees revisions).
					const found = await runWithContext({ editMode: false, db: scopedDb }, () =>
						runtime.schemaRegistry.getCollectionWithFields("widgets"),
					);
					expect(found?.slug).toBe("widgets");
					expect(found?.supports).toContain("revisions");
				} finally {
					await scopedDb.destroy();
				}
			} finally {
				await runtime.stopCron();
			}
		});
	});
});
