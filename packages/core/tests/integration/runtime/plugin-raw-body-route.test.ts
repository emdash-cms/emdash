/**
 * End-to-end wiring for plugin-route `rawBody`.
 *
 * The route-layer unit tests pass `rawBody` into `PluginRouteHandler.invoke`
 * manually; this test exercises the real path — `EmDashRuntime.
 * handlePluginApiRoute` reading the request stream once, parsing `ctx.input`
 * from the same buffer, and forwarding the raw string only to routes that
 * opted in with `rawBody: true`.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";

/** What the handler saw for the last invocation, keyed by route name. */
const seen = new Map<string, { rawBody?: string; input?: unknown }>();

function createDeps(): RuntimeDependencies {
	const entrypoint = `test-plugin-raw-body-${randomUUID()}`;
	return {
		config: {
			database: { entrypoint, config: {}, type: "sqlite" },
			storage: { entrypoint, config: {} },
		},
		plugins: [
			definePlugin({
				id: "webhook-demo",
				version: "1.0.0",
				capabilities: [],
				routes: {
					webhook: {
						rawBody: true,
						handler: async (ctx) => {
							seen.set("webhook", { rawBody: ctx.rawBody, input: ctx.input });
							return { ok: true };
						},
					},
					normal: {
						handler: async (ctx) => {
							seen.set("normal", { rawBody: ctx.rawBody, input: ctx.input });
							return { ok: true };
						},
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

function post(runtime: EmDashRuntime, route: string, body?: string) {
	return runtime.handlePluginApiRoute(
		"webhook-demo",
		"POST",
		`/${route}`,
		new Request(`http://test.local/_emdash/api/plugins/webhook-demo/${route}`, {
			method: "POST",
			body,
		}),
	);
}

describe("EmDashRuntime.handlePluginApiRoute — rawBody", () => {
	let runtime: EmDashRuntime;

	beforeAll(async () => {
		runtime = await EmDashRuntime.create(createDeps());
	});

	afterAll(async () => {
		await runtime.stopCron();
	});

	it("delivers the unparsed body string and the parsed input from the same buffer", async () => {
		// Whitespace and key order must survive: a signature computed over a
		// re-serialized ctx.input would not match this string.
		const raw = `{"b": 2,  "a":1}`;
		const result = await post(runtime, "webhook", raw);

		expect(result.success).toBe(true);
		expect(seen.get("webhook")).toEqual({ rawBody: raw, input: { a: 1, b: 2 } });
	});

	it("delivers non-JSON bodies with input undefined", async () => {
		const raw = "event=order.paid&id=42";
		const result = await post(runtime, "webhook", raw);

		expect(result.success).toBe(true);
		expect(seen.get("webhook")).toEqual({ rawBody: raw, input: undefined });
	});

	it("leaves rawBody undefined without a request body", async () => {
		const result = await post(runtime, "webhook");

		expect(result.success).toBe(true);
		const call = seen.get("webhook");
		expect(call?.rawBody).toBeFalsy();
		expect(call?.input).toBeUndefined();
	});

	it("does not expose rawBody to routes without the flag", async () => {
		const raw = `{"a":1}`;
		const result = await post(runtime, "normal", raw);

		expect(result.success).toBe(true);
		expect(seen.get("normal")).toEqual({ rawBody: undefined, input: { a: 1 } });
	});
});
