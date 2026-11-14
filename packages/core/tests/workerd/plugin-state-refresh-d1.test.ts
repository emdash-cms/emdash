import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../src/emdash-runtime.js";
import { definePlugin, definePluginRoute } from "../../src/plugins/define-plugin.js";
import { PluginStateRepository } from "../../src/plugins/state.js";
import type { PluginContext } from "../../src/plugins/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const pluginId = "d1-refreshable-plugin";
const runtimes: EmDashRuntime[] = [];
let db: Kysely<import("../../src/database/types.js").Database>;

function deps(counters: { activate: () => void; deactivate: () => void }): RuntimeDependencies {
	return {
		config: { database: { entrypoint: "plugin-state-refresh-d1", config: {}, type: "d1" } },
		plugins: [
			definePlugin({
				id: pluginId,
				version: "1.0.0",
				capabilities: ["media:read"],
				routes: {
					health: definePluginRoute({ public: true, handler: async () => ({ ok: true }) }),
				},
				hooks: {
					"media:afterUpload": async () => {},
					"plugin:activate": async (_event, _context: PluginContext) => counters.activate(),
					"plugin:deactivate": async (_event, _context: PluginContext) => counters.deactivate(),
				},
			}),
		],
		createDialect: () => new RawBindingD1Dialect({ database: env.DB }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
		migrationMode: "manual",
	};
}

async function route(runtime: EmDashRuntime) {
	return runtime.handlePluginApiRoute(
		pluginId,
		"GET",
		"health",
		new Request("https://example.test/health"),
	);
}

async function mediaHook(runtime: EmDashRuntime) {
	return runtime.hooks.runMediaAfterUpload({
		id: "media-1",
		filename: "file.txt",
		mimeType: "text/plain",
		size: 1,
		url: "https://example.test/file.txt",
		createdAt: new Date().toISOString(),
	});
}

beforeEach(async () => {
	db = new Kysely({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);
});

afterEach(async () => {
	vi.useRealTimers();
	for (const runtime of runtimes.splice(0)) {
		await runtime.shutdown();
		await runtime.db.destroy();
	}
	await db.destroy();
});

describe("Cloudflare plugin state refresh on D1", () => {
	it("refreshes a second warm runtime after external state writes without replaying lifecycle hooks", async () => {
		const writerLifecycle = { activate: 0, deactivate: 0 };
		const readerLifecycle = { activate: 0, deactivate: 0 };
		const writer = await EmDashRuntime.create(
			deps({
				activate: () => writerLifecycle.activate++,
				deactivate: () => writerLifecycle.deactivate++,
			}),
		);
		runtimes.push(writer);
		const reader = await EmDashRuntime.create(
			deps({
				activate: () => readerLifecycle.activate++,
				deactivate: () => readerLifecycle.deactivate++,
			}),
		);
		runtimes.push(reader);
		const repo = new PluginStateRepository(db);
		vi.useFakeTimers({ toFake: ["Date"] });

		expect((await route(reader)).success).toBe(true);
		expect(await mediaHook(reader)).toHaveLength(1);
		await repo.upsert(pluginId, "1.0.0", "inactive");

		// A warm isolate remains stale until its refresh interval elapses.
		expect((await route(reader)).success).toBe(true);
		expect(await mediaHook(reader)).toHaveLength(1);
		vi.advanceTimersByTime(5_001);
		await Promise.all([reader.ensurePluginStateFresh(), reader.ensurePluginStateFresh()]);

		expect((await route(reader)).success).toBe(false);
		expect(await mediaHook(reader)).toHaveLength(0);
		expect(readerLifecycle).toEqual({ activate: 0, deactivate: 0 });
		expect(writerLifecycle).toEqual({ activate: 1, deactivate: 0 });

		await repo.upsert(pluginId, "1.0.0", "active");
		vi.advanceTimersByTime(5_001);
		await reader.ensurePluginStateFresh();

		expect((await route(reader)).success).toBe(true);
		expect(await mediaHook(reader)).toHaveLength(1);
		expect(readerLifecycle).toEqual({ activate: 0, deactivate: 0 });
		expect(writerLifecycle).toEqual({ activate: 1, deactivate: 0 });
	});
});
