/**
 * Integration tests for route auth metadata on config-declared sandboxed plugins.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";

let currentInvokeRoute: SandboxedPluginInstance["invokeRoute"] = async () => undefined;

function createDeps(
	invokeRoute: SandboxedPluginInstance["invokeRoute"] = vi.fn(),
): RuntimeDependencies {
	currentInvokeRoute = invokeRoute;
	const entrypoint = `test-sandboxed-route-meta-${randomUUID()}`;
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn().mockResolvedValue({
			invokeHook: vi.fn(),
			invokeRoute: (...args: Parameters<SandboxedPluginInstance["invokeRoute"]>) =>
				currentInvokeRoute(...args),
		}),
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
				version: randomUUID(),
				options: {},
				code: "",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				routes: [{ name: "ping", public: true }, { name: "admin" }],
				adminPages: [{ path: "/overview", label: "Overview" }],
				adminWidgets: [{ id: "status", title: "Status" }],
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

	it("attests the UI locale and validates a sandboxed Block Kit response", async () => {
		const invokeRoute = vi.fn(async (_name, _input, request) => ({
			blocks: [
				{
					type: "fields",
					fields: [{ label: "Direction", value: request.ui?.direction ?? "missing" }],
				},
			],
		}));
		const runtime = await EmDashRuntime.create(createDeps(invokeRoute));
		try {
			const result = await runtime.handlePluginApiRoute(
				"demo",
				"POST",
				"/admin",
				new Request("https://example.test/_emdash/api/plugins/demo/admin", {
					method: "POST",
					headers: { Cookie: "emdash-locale=ar" },
					body: JSON.stringify({ type: "page_load", page: "/overview" }),
				}),
			);

			expect(result).toMatchObject({ success: true });
			expect(invokeRoute).toHaveBeenCalledWith(
				"admin",
				{ type: "page_load", page: "/overview" },
				expect.objectContaining({
					ui: { surface: "admin-page", locale: "ar", direction: "rtl" },
				}),
			);

			await runtime.handlePluginApiRoute(
				"demo",
				"POST",
				"/admin",
				new Request("https://example.test/_emdash/api/plugins/demo/admin", {
					method: "POST",
					headers: { Cookie: "emdash-locale=not-enabled" },
					body: JSON.stringify({ type: "page_load", page: "/overview" }),
				}),
			);
			expect(invokeRoute).toHaveBeenLastCalledWith(
				"admin",
				{ type: "page_load", page: "/overview" },
				expect.objectContaining({
					ui: { surface: "admin-page", locale: "en", direction: "ltr" },
				}),
			);
		} finally {
			await runtime.stopCron();
		}
	});

	it("rejects undeclared UI surfaces and unapproved browser resources", async () => {
		const invokeRoute = vi.fn(async () => ({
			blocks: [{ type: "image", url: "https://tracker.example/pixel.gif", alt: "" }],
		}));
		const runtime = await EmDashRuntime.create(createDeps(invokeRoute));
		try {
			const undeclared = await runtime.handlePluginApiRoute(
				"demo",
				"POST",
				"/admin",
				new Request("https://example.test/_emdash/api/plugins/demo/admin", {
					method: "POST",
					body: JSON.stringify({ type: "page_load", page: "/missing" }),
				}),
			);
			expect(undeclared).toMatchObject({
				success: false,
				error: { code: "INVALID_PLUGIN_UI_CONTEXT" },
			});
			expect(invokeRoute).not.toHaveBeenCalled();

			const unsafe = await runtime.handlePluginApiRoute(
				"demo",
				"POST",
				"/admin",
				new Request("https://example.test/_emdash/api/plugins/demo/admin", {
					method: "POST",
					body: JSON.stringify({ type: "page_load", page: "/overview" }),
				}),
			);
			expect(unsafe).toMatchObject({
				success: false,
				status: 502,
				error: { code: "INVALID_BLOCK_RESPONSE" },
			});
		} finally {
			await runtime.stopCron();
		}
	});
});
