/**
 * End-to-end wiring for plugin-route `cacheControl`.
 *
 * The route-layer unit tests mock `getPluginRouteMeta`; this test exercises
 * the real path — a `ResolvedPlugin` with `cacheControl` registered on
 * `EmDashRuntime`, metadata resolved via `runtime.getPluginRouteMeta`, and the
 * catch-all handler applying the header — so a runtime that drops the field
 * (the original review finding) fails here.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/plugins/[pluginId]/[...path].js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";

const CACHE_VALUE = "public, max-age=60, stale-while-revalidate=300";

function createDeps(): RuntimeDependencies {
	const entrypoint = `test-plugin-cache-control-${randomUUID()}`;
	return {
		config: {
			database: { entrypoint, config: {}, type: "sqlite" },
			storage: { entrypoint, config: {} },
		},
		plugins: [
			definePlugin({
				id: "cache-demo",
				version: "1.0.0",
				capabilities: [],
				routes: {
					catalog: {
						public: true,
						cacheControl: CACHE_VALUE,
						handler: async () => ({ items: [] }),
					},
					uncached: {
						public: true,
						handler: async () => ({ items: [] }),
					},
					// Misconfigured on purpose: cacheControl on a private route
					// must never surface.
					admin: {
						cacheControl: CACHE_VALUE,
						handler: async () => ({ secret: true }),
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

function invokeCatchAll(runtime: EmDashRuntime, routeName: string, method: string) {
	const request = new Request(`http://test.local/_emdash/api/plugins/cache-demo/${routeName}`, {
		method,
	});
	const handler = method === "POST" ? POST : GET;
	return handler({
		params: { pluginId: "cache-demo", path: routeName },
		request,
		locals: { user: null, emdash: runtime },
	} as never);
}

describe("plugin route cacheControl — runtime wiring", () => {
	let runtime: EmDashRuntime;

	beforeAll(async () => {
		runtime = await EmDashRuntime.create(createDeps());
	});

	afterAll(async () => {
		await runtime.stopCron();
	});

	it("runtime.getPluginRouteMeta carries cacheControl for public trusted routes", () => {
		expect(runtime.getPluginRouteMeta("cache-demo", "/catalog")).toEqual({
			public: true,
			cacheControl: CACHE_VALUE,
		});
	});

	it("runtime.getPluginRouteMeta never exposes cacheControl for private routes", () => {
		expect(runtime.getPluginRouteMeta("cache-demo", "/admin")).toEqual({ public: false });
	});

	it("applies the header end-to-end on a public GET through the catch-all", async () => {
		const res = await invokeCatchAll(runtime, "catalog", "GET");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe(CACHE_VALUE);
	});

	it("keeps the private, no-store default without the option", async () => {
		const res = await invokeCatchAll(runtime, "uncached", "GET");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("keeps the default on POST to a cached route", async () => {
		const res = await invokeCatchAll(runtime, "catalog", "POST");
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});
});
