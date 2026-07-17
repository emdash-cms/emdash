/**
 * EmDashRuntime.create() — cold-boot initialization
 *
 * Exercises the full static create() path end-to-end against a real
 * in-memory SQLite database: migrations, the parallelized plugin-state +
 * site-info reads, pipeline creation, batched exclusive hook resolution,
 * and cron init. Asserts that the per-phase timing instrumentation still
 * records every phase individually after parallelization.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_COMMENT_MODERATOR_PLUGIN_ID } from "../../../src/comments/moderator.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ContentBeforeSaveHandler } from "../../../src/plugins/types.js";
import { runWithContext } from "../../../src/request-context.js";

function createDeps(): RuntimeDependencies {
	return {
		config: {
			database: {
				// Unique entrypoint per test so the module-level dbCache in
				// emdash-runtime.ts never serves a stale instance across tests.
				entrypoint: `test-runtime-create-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [
			definePlugin({
				id: "test-exclusive-provider",
				version: "1.0.0",
				capabilities: ["content:write", "content:read"],
				hooks: {
					"content:beforeSave": {
						exclusive: true,
						handler: vi.fn() as unknown as ContentBeforeSaveHandler,
					},
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

describe("EmDashRuntime.create — cold boot", () => {
	it("initializes end-to-end and records each phase's own timing", async () => {
		const timings: Array<{ name: string; dur: number; desc?: string }> = [];
		const runtime = await EmDashRuntime.create(createDeps(), timings);

		try {
			// Every phase records its own entry exactly once.
			const names = timings.map((t) => t.name);
			for (const expected of [
				"rt.db",
				"rt.seedcheck",
				"rt.plugins",
				"rt.site",
				"rt.sandbox",
				"rt.hooks",
				"rt.cron",
			]) {
				expect(names.filter((n) => n === expected)).toHaveLength(1);
			}
			// rt.market / rt.registry are not configured — no phantom phases.
			expect(names).not.toContain("rt.market");
			expect(names).not.toContain("rt.registry");
			for (const t of timings) {
				expect(t.dur).toBeGreaterThanOrEqual(0);
				expect(Number.isFinite(t.dur)).toBe(true);
			}

			// Exclusive hooks resolved: sole providers auto-selected, both in
			// memory and persisted to the options table.
			expect(runtime.hooks.getExclusiveSelection("content:beforeSave")).toBe(
				"test-exclusive-provider",
			);
			expect(runtime.hooks.getExclusiveSelection("comment:moderate")).toBe(
				DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
			);

			const row = await runtime.db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:exclusive_hook:content:beforeSave")
				.executeTakeFirst();
			expect(row).toBeDefined();
			expect(JSON.parse(row!.value)).toBe("test-exclusive-provider");
		} finally {
			await runtime.stopCron();
		}
	});

	it("creates a runtime without a timings array (backwards compatible)", async () => {
		const runtime = await EmDashRuntime.create(createDeps());
		try {
			expect(runtime.hooks.getExclusiveSelection("content:beforeSave")).toBe(
				"test-exclusive-provider",
			);
		} finally {
			await runtime.stopCron();
		}
	});

	it("passes normalized site information to the sandbox runner", async () => {
		const sqlite = new Database(":memory:");
		const setupDb = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(setupDb);
		const options = new OptionsRepository(setupDb);
		await options.set("emdash:setup_complete", true);
		await options.set("emdash:site_title", "Example Site");
		await options.set("emdash:site_url", "https://example.com/");
		await options.set("emdash:locale", "nl");

		const runner = {
			isAvailable: () => true,
			isHealthy: () => true,
			load: vi.fn(),
			setEmailSend: vi.fn(),
			terminateAll: vi.fn(),
		};
		const createSandboxRunner = vi.fn(() => runner as never);
		const deps: RuntimeDependencies = {
			...createDeps(),
			createDialect: () => new SqliteDialect({ database: sqlite }),
			sandboxEnabled: true,
			createSandboxRunner,
		};

		const runtime = await EmDashRuntime.create(deps);
		try {
			expect(createSandboxRunner).toHaveBeenCalledWith(
				expect.objectContaining({
					siteInfo: {
						name: "Example Site",
						url: "https://example.com",
						locale: "nl",
					},
				}),
			);
		} finally {
			await runtime.stopCron();
			await setupDb.destroy();
		}
	});

	// The init read phase feeds plugin enablement: a plugin marked inactive in
	// _plugin_state must be excluded from the pipeline, so its exclusive hook is
	// never auto-selected. A shared DB seeds the _plugin_state row before
	// create() reads it.
	it("excludes a plugin disabled in _plugin_state from the initial pipeline", async () => {
		const sqlite = new Database(":memory:");
		const setupDb = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(setupDb);
		await setupDb
			.insertInto("_plugin_state")
			.values({ plugin_id: "test-exclusive-provider", version: "1.0.0", status: "inactive" })
			.execute();
		// Mark setup complete so create() doesn't attempt the (test-unavailable)
		// virtual seed module; keeps the run focused on the plugin-state read.
		await setupDb
			.insertInto("options")
			.values({ name: "emdash:setup_complete", value: "true" })
			.execute();

		const deps: RuntimeDependencies = {
			...createDeps(),
			createDialect: () => new SqliteDialect({ database: sqlite }),
		};
		const runtime = await EmDashRuntime.create(deps);
		try {
			// Disabled provider is not in the pipeline -> no candidate -> unselected.
			expect(runtime.hooks.getExclusiveSelection("content:beforeSave")).toBeUndefined();
			// The always-enabled built-in moderator is unaffected.
			expect(runtime.hooks.getExclusiveSelection("comment:moderate")).toBe(
				DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
			);
		} finally {
			await runtime.stopCron();
			await setupDb.destroy();
		}
	});

	// When a coalescing dialect is provided, the cold-start read phase must run
	// on it (one batched round trip), not the singleton. Prove the routing: the
	// coalescing db marks the provider inactive while the singleton leaves it
	// enabled, so reading from the coalescing db excludes the provider and
	// leaves its exclusive hook unselected.
	it("routes the cold-start read phase through createCoalescingDialect", async () => {
		const singletonSqlite = new Database(":memory:");
		const singletonSetup = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: singletonSqlite }),
		});
		await runMigrations(singletonSetup);
		await singletonSetup
			.insertInto("options")
			.values({ name: "emdash:setup_complete", value: "true" })
			.execute();

		const coalescingSqlite = new Database(":memory:");
		const coalescingSetup = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: coalescingSqlite }),
		});
		await runMigrations(coalescingSetup);
		await coalescingSetup
			.insertInto("_plugin_state")
			.values({ plugin_id: "test-exclusive-provider", version: "1.0.0", status: "inactive" })
			.execute();
		await coalescingSetup
			.insertInto("options")
			.values({ name: "emdash:setup_complete", value: "true" })
			.execute();

		let coalescingCalls = 0;
		const deps: RuntimeDependencies = {
			...createDeps(),
			createDialect: () => new SqliteDialect({ database: singletonSqlite }),
			createCoalescingDialect: () => {
				coalescingCalls += 1;
				return new SqliteDialect({ database: coalescingSqlite });
			},
		};
		const runtime = await EmDashRuntime.create(deps);
		try {
			// The read phase built exactly one coalescing connection...
			expect(coalescingCalls).toBe(1);
			// ...and read plugin state from it (provider inactive there), so the
			// provider is excluded and its exclusive hook is unselected. Reading
			// from the singleton (provider enabled) would have selected it.
			expect(runtime.hooks.getExclusiveSelection("content:beforeSave")).toBeUndefined();
		} finally {
			await runtime.stopCron();
			// create() destroys the read connection, which closes coalescingSqlite;
			// the setup handles may already be closed.
			try {
				await singletonSetup.destroy();
			} catch {
				// already closed
			}
			try {
				await coalescingSetup.destroy();
			} catch {
				// already closed
			}
		}
	});

	// A failed migration must not be retried on every create() call: on
	// Workers each request in a warm isolate re-enters create(), and without
	// a backoff every request re-runs the failing migration against the
	// database (#1744). The failure is remembered per database entrypoint
	// and re-attempts are skipped for a backoff window.
	it("backs off after a migration failure instead of retrying immediately", async () => {
		// A database whose next migration deterministically fails: fully
		// migrated, then the 001_initial bookkeeping row is removed so the
		// migrator re-runs it against existing tables.
		const sqlite = new Database(":memory:");
		const setupDb = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(setupDb);
		await sql`DELETE FROM _emdash_migrations WHERE name = '001_initial'`.execute(setupDb);

		let dialectCalls = 0;
		const deps: RuntimeDependencies = {
			...createDeps(),
			createDialect: () => {
				dialectCalls += 1;
				return new SqliteDialect({ database: sqlite });
			},
		};

		await expect(EmDashRuntime.create(deps)).rejects.toThrow(/Migration failed/i);
		expect(dialectCalls).toBe(1);

		// An immediate retry (same entrypoint → same failure record) must
		// fail fast without building a new connection or touching the db.
		await expect(EmDashRuntime.create(deps)).rejects.toThrow(/backing off/i);
		expect(dialectCalls).toBe(1);
	});

	// A per-request isolated db (playground / DO preview) must never be
	// auto-seeded. With an isolated, empty, not-set-up db, a broken guard would
	// run the gate (rt.seedcheck appears) and attempt a seed; assert neither
	// happens.
	it("does not run the auto-seed gate for an isolated request db", async () => {
		const sqlite = new Database(":memory:");
		const isolated = new Kysely<EmDashDatabase>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(isolated);
		// Sentinel: mark the configured provider inactive ONLY in the isolated
		// db. If create() reads plugin state from this db (proving it honored
		// ctx.db), the provider is excluded and its exclusive hook is unselected.
		// If it silently used a different db, the provider would be selected and
		// the assertion below would fail — so this proves the routing, which a
		// bare "collections still 0" check cannot.
		await isolated
			.insertInto("_plugin_state")
			.values({ plugin_id: "test-exclusive-provider", version: "1.0.0", status: "inactive" })
			.execute();
		// Empty + not set up: this is exactly the state that WOULD seed on the
		// configured-singleton path. The guard must skip it for an isolated db.
		const before = await isolated
			.selectFrom("_emdash_collections")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(before.count).toBe(0);

		const timings: Array<{ name: string; dur: number; desc?: string }> = [];
		const runtime = await runWithContext(
			{ editMode: false, db: isolated, dbIsIsolated: true },
			() => EmDashRuntime.create(createDeps(), timings),
		);
		try {
			// create() read plugin state from the ISOLATED db (honored ctx.db):
			// the sentinel inactive row excluded the provider from the pipeline.
			expect(runtime.hooks.getExclusiveSelection("content:beforeSave")).toBeUndefined();
			// Guard skipped the gate entirely: no rt.seedcheck phase.
			expect(timings.map((t) => t.name)).not.toContain("rt.seedcheck");
			// And nothing was seeded onto the borrowed db.
			const after = await isolated
				.selectFrom("_emdash_collections")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.executeTakeFirstOrThrow();
			expect(after.count).toBe(0);
		} finally {
			await runtime.stopCron();
			await isolated.destroy();
		}
	});
});
