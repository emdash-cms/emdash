/**
 * A `sandboxed: []` (config-declared, non-marketplace) plugin never got its
 * route auth metadata populated -- unlike marketplace/registry installs,
 * which read `bundle.manifest.routes` off a downloaded bundle. Every one of
 * its non-admin routes fell through to the sandbox's `{ public: false }`
 * fallback regardless of what the plugin itself declared. See #2078.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";

function createDeps(): RuntimeDependencies {
	const entrypoint = `test-sandboxed-route-meta-${randomUUID()}`;
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn().mockResolvedValue({ invokeHook: vi.fn() }),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};
	return {
		config: { database: { entrypoint, config: {}, type: "sqlite" } },
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: "demo",
				version: "1.0.0",
				options: {},
				code: "",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				routes: [{ name: "ping", public: true }],
			},
		],
		// eslint-disable-next-line typescript/no-explicit-any -- test fake matches the SandboxRunner shape create.test.ts already uses
		createSandboxRunner: (() => runner) as any,
	};
}

describe("EmDashRuntime — config-declared sandboxed plugin route metadata", () => {
	it("honors public: true declared in the sandboxed entry's routes", async () => {
		const runtime = await EmDashRuntime.create(createDeps());
		try {
			expect(runtime.getPluginRouteMeta("demo", "ping")).toMatchObject({ public: true });
		} finally {
			await runtime.stopCron();
		}
	});

	it("still falls back to non-public for a route the entry didn't declare", async () => {
		const runtime = await EmDashRuntime.create(createDeps());
		try {
			expect(runtime.getPluginRouteMeta("demo", "other")).toMatchObject({ public: false });
		} finally {
			await runtime.stopCron();
		}
	});
});
