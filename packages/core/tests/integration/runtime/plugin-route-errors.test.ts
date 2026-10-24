import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import { PluginRouteError } from "../../../src/plugins/route-error.js";
import type { PluginRoute } from "../../../src/plugins/types.js";

const runtimes: EmDashRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

async function invoke(route: PluginRoute, body: unknown) {
	const runtime = await EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [definePlugin({ id: "errors-demo", version: "1.0.0", routes: { test: route } })],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
	runtimes.push(runtime);
	return dispatchPluginApiRequest({
		runtime,
		pluginId: "errors-demo",
		path: "/test",
		request: new Request("https://example.com/_emdash/api/plugins/errors-demo/test", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	});
}

describe("plugin route error responses", () => {
	it("passes a PluginRouteError's details through to the client", async () => {
		const response = await invoke(
			{
				public: true,
				handler: async () => {
					throw PluginRouteError.badRequest("Check the highlighted fields", {
						fields: { phone: "Enter a phone number" },
					});
				},
			},
			{ phone: "" },
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BAD_REQUEST",
				message: "Check the highlighted fields",
				details: { fields: { phone: "Enter a phone number" } },
			},
		});
	});

	it("includes the input schema's field errors in a validation failure", async () => {
		let invoked = false;
		const response = await invoke(
			{
				public: true,
				input: z.object({ email: z.string().email() }),
				handler: async () => {
					invoked = true;
					return { ok: true };
				},
			},
			{ email: "not-an-email" },
		);
		expect(invoked).toBe(false);
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error: { code: string; details?: { email?: { _errors: string[] } } };
		};
		expect(body.error.code).toBe("VALIDATION_ERROR");
		expect(body.error.details?.email?._errors.length).toBeGreaterThan(0);
	});

	it("still hides the details of an unexpected error", async () => {
		const response = await invoke(
			{
				public: true,
				handler: async () => {
					throw new Error("database password is hunter2");
				},
			},
			{},
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		const text = await response.text();
		expect(text).not.toContain("hunter2");
		expect(JSON.parse(text).error.details).toBeUndefined();
	});
});
