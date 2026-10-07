import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import {
	EmDashRuntime,
	type RuntimeDependencies,
	type SandboxedPluginEntry,
} from "../../../src/emdash-runtime.js";
import { definePlugin, definePluginRoute } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import type { PluginRoute, UserInfo } from "../../../src/plugins/types.js";

const runtimes: EmDashRuntime[] = [];

function adminUser(): UserInfo {
	return {
		id: "user-admin",
		email: "admin@example.com",
		name: "Admin",
		role: 50,
		createdAt: new Date().toISOString(),
	};
}

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

async function invokeTrusted(
	route: PluginRoute,
	request: Request,
	options: { user?: UserInfo } = {},
) {
	const runtime = await EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [definePlugin({ id: "resp-demo", version: "1.0.0", routes: { test: route } })],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
	runtimes.push(runtime);
	return dispatchPluginApiRequest({
		runtime,
		pluginId: "resp-demo",
		path: "/test",
		request,
		user: options.user,
	});
}

async function invokeSandboxed(
	invokeRoute: SandboxedPluginInstance["invokeRoute"],
	request: Request,
) {
	let currentInvokeRoute = invokeRoute;
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
	const entry: SandboxedPluginEntry = {
		id: "sandbox-demo",
		version: "1.0.0",
		options: {},
		code: "",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		routes: [{ name: "test", public: true }],
	};
	const deps: RuntimeDependencies = {
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [entry],
		// eslint-disable-next-line typescript/no-explicit-any -- test fake matches the SandboxRunner shape create.test.ts already uses
		createSandboxRunner: (() => runner) as any,
	};
	const runtime = await EmDashRuntime.create(deps);
	runtimes.push(runtime);
	return dispatchPluginApiRequest({
		runtime,
		pluginId: "sandbox-demo",
		path: "/test",
		request,
	});
}

describe("trusted plugin route raw Response passthrough", () => {
	it("passes a trusted handler's Response through (status, Set-Cookie, body) and applies the default Cache-Control policy", async () => {
		const response = await invokeTrusted(
			definePluginRoute({
				public: true,
				handler: async () =>
					new Response("x", {
						status: 201,
						headers: { "Set-Cookie": "a=b", "Content-Type": "text/plain" },
					}),
			}),
			new Request("https://example.com/_emdash/api/plugins/resp-demo/test", { method: "POST" }),
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("Set-Cookie")).toBe("a=b");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.text()).toBe("x");
	});

	it("still apiSuccess-wraps a plain object result from a trusted handler", async () => {
		const response = await invokeTrusted(
			definePluginRoute({
				public: true,
				handler: async () => ({ ok: true }),
			}),
			new Request("https://example.com/_emdash/api/plugins/resp-demo/test", { method: "POST" }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { ok: true } });
	});

	it("leaves sandboxed wire results unchanged (no Response objects cross the wire)", async () => {
		const response = await invokeSandboxed(
			vi.fn(async () => ({ message: "sandbox-data" })),
			new Request("https://example.com/_emdash/api/plugins/sandbox-demo/test", { method: "POST" }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: { message: "sandbox-data" },
		});
	});
});

describe("trusted plugin route raw Response passthrough Cache-Control policy", () => {
	it("applies private, no-store to a passthrough Response on a private route", async () => {
		const response = await invokeTrusted(
			definePluginRoute({
				public: false,
				handler: async () => new Response("session-data"),
			}),
			new Request("https://example.com/_emdash/api/plugins/resp-demo/test", {
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
			}),
			{ user: adminUser() },
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("session-data");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("applies the route's cacheControl to a passthrough Response on public GET/HEAD", async () => {
		const route = definePluginRoute({
			public: true,
			cacheControl: "public, max-age=60",
			handler: async () => new Response("cached-body"),
		});
		const getResponse = await invokeTrusted(
			route,
			new Request("https://example.com/_emdash/api/plugins/resp-demo/test", { method: "GET" }),
		);
		expect(getResponse.headers.get("Cache-Control")).toBe("public, max-age=60");
		expect(await getResponse.text()).toBe("cached-body");

		const headResponse = await invokeTrusted(
			route,
			new Request("https://example.com/_emdash/api/plugins/resp-demo/test", { method: "HEAD" }),
		);
		expect(headResponse.headers.get("Cache-Control")).toBe("public, max-age=60");
	});

	it("does not override a Cache-Control the handler set itself", async () => {
		const response = await invokeTrusted(
			definePluginRoute({
				public: true,
				cacheControl: "public, max-age=60",
				handler: async () =>
					new Response("stream", {
						headers: { "Cache-Control": "no-cache", "Content-Type": "text/plain" },
					}),
			}),
			new Request("https://example.com/_emdash/api/plugins/resp-demo/test", { method: "GET" }),
		);
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(await response.text()).toBe("stream");
	});
});
