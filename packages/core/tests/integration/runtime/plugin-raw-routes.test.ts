import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { pluginResponse } from "../../../src/plugin-types.js";
import { definePlugin, definePluginRoute } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";
import type { PluginRoute } from "../../../src/plugins/types.js";

const runtimes: EmDashRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

async function invoke(route: PluginRoute, request: Request) {
	const runtime = await EmDashRuntime.create({
		config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
		plugins: [definePlugin({ id: "raw-demo", version: "1.0.0", routes: { test: route } })],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
	runtimes.push(runtime);
	return dispatchPluginApiRequest({
		runtime,
		pluginId: "raw-demo",
		path: "/test",
		request,
	});
}

describe("trusted raw plugin route runtime", () => {
	it("preserves request and response bytes across the full runtime boundary", async () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10, 128]);
		const response = await invoke(
			definePluginRoute({
				public: true,
				methods: ["POST"],
				request: { body: "bytes", maxBytes: 1024 },
				response: "raw",
				handler: async ({ input }) =>
					pluginResponse({
						status: 202,
						headers: { "content-type": "application/octet-stream" },
						body: { kind: "bytes", value: input },
					}),
			}),
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				body: bytes,
			}),
		);
		expect(response.status).toBe(202);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("preserves webhook text and keeps legacy JSON parsing unchanged", async () => {
		const text = '{  "b": 1,\r\n  "a": "x"  }';
		let delivered = "";
		const textResponse = await invoke(
			definePluginRoute({
				public: true,
				request: { body: "text" },
				handler: async ({ input }) => {
					delivered = input;
					return { ok: true };
				},
			}),
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				body: text,
			}),
		);
		expect(textResponse.status).toBe(200);
		expect(delivered).toBe(text);

		let legacyInput: unknown;
		const legacyResponse = await invoke(
			{
				public: true,
				handler: async ({ input }) => {
					legacyInput = input;
					return { ok: true };
				},
			},
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: text,
			}),
		);
		expect(legacyResponse.status).toBe(200);
		expect(legacyInput).toEqual({ a: "x", b: 1 });
	});

	it("returns a bounded request error before invoking the handler", async () => {
		let invoked = false;
		const response = await invoke(
			definePluginRoute({
				public: true,
				request: { body: "bytes", maxBytes: 2 },
				handler: async () => {
					invoked = true;
					return null;
				},
			}),
			new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
				method: "POST",
				body: new Uint8Array([1, 2, 3]),
			}),
		);
		expect(response.status).toBe(413);
		expect(invoked).toBe(false);
	});
});
