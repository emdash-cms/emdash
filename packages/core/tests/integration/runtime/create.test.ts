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
import { SqliteDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_COMMENT_MODERATOR_PLUGIN_ID } from "../../../src/comments/moderator.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ContentBeforeSaveHandler } from "../../../src/plugins/types.js";

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
			// Every phase records its own entry exactly once — including the
			// parallelized rt.plugins / rt.site pair.
			const names = timings.map((t) => t.name);
			for (const expected of [
				"rt.db",
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
});
