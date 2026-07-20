/**
 * Trusted plugin routes with `rawBody: true` must receive the delivered
 * body as a UTF-8 string on `ctx.rawBody`, alongside the parsed `ctx.input`.
 *
 * The dispatcher reads `request.text()` once, parses JSON from the same
 * buffer into `ctx.input`, and only surfaces `rawBody` to opted-in routes —
 * the behavioral core of the raw-body feature that unit tests invoking
 * `PluginRouteHandler.invoke` directly do not exercise.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { Storage } from "../../../src/storage/types.js";

const stubStorage: Storage = {
	async upload() {
		throw new Error("storage not used by this test");
	},
	async download() {
		throw new Error("storage not used by this test");
	},
	async delete() {},
	async exists() {
		return false;
	},
	async list() {
		return { items: [] };
	},
	async getSignedUploadUrl() {
		throw new Error("storage not used by this test");
	},
	getPublicUrl: (key) => `/media/${key}`,
};

interface Captured {
	hasRawBody: boolean;
	rawBody: string | undefined;
	input: unknown;
}

function createDeps(captured: Captured, rawBodyOptIn: boolean): RuntimeDependencies {
	const entrypoint = `test-plugin-raw-body-${randomUUID()}`;
	return {
		config: {
			database: { entrypoint, config: {}, type: "sqlite" },
			storage: { entrypoint, config: {} },
		},
		plugins: [
			definePlugin({
				id: "webhook-sink",
				version: "1.0.0",
				capabilities: [],
				routes: {
					hook: {
						rawBody: rawBodyOptIn,
						handler: async (ctx) => {
							captured.hasRawBody = "rawBody" in ctx && ctx.rawBody !== undefined;
							captured.rawBody = ctx.rawBody;
							captured.input = ctx.input;
							return { ok: true };
						},
					},
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: () => stubStorage,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

function post(json: string): Request {
	return new Request("http://test.local/_emdash/api/plugin/webhook-sink/hook", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: json,
	});
}

describe("EmDashRuntime.handlePluginApiRoute — rawBody", () => {
	it("populates ctx.rawBody with the exact delivered text and ctx.input with parsed JSON", async () => {
		const captured: Captured = { hasRawBody: false, rawBody: undefined, input: undefined };
		const runtime = await EmDashRuntime.create(createDeps(captured, true));
		try {
			// Whitespace and key order must survive in rawBody even though
			// ctx.input is the parsed equivalent.
			const payload = '{  "b": 1,\n  "a": "x"  }';
			const result = await runtime.handlePluginApiRoute(
				"webhook-sink",
				"POST",
				"/hook",
				post(payload),
			);

			expect(result.success).toBe(true);
			expect(captured.hasRawBody).toBe(true);
			expect(captured.rawBody).toBe(payload);
			expect(captured.input).toEqual({ a: "x", b: 1 });
		} finally {
			await runtime.stopCron();
		}
	});

	it("leaves ctx.input undefined for non-JSON payloads but still exposes rawBody", async () => {
		const captured: Captured = { hasRawBody: false, rawBody: undefined, input: undefined };
		const runtime = await EmDashRuntime.create(createDeps(captured, true));
		try {
			const result = await runtime.handlePluginApiRoute(
				"webhook-sink",
				"POST",
				"/hook",
				post("not json at all"),
			);

			expect(result.success).toBe(true);
			expect(captured.rawBody).toBe("not json at all");
			expect(captured.input).toBeUndefined();
		} finally {
			await runtime.stopCron();
		}
	});

	it("does not populate ctx.rawBody for routes that did not opt in", async () => {
		const captured: Captured = { hasRawBody: false, rawBody: undefined, input: undefined };
		const runtime = await EmDashRuntime.create(createDeps(captured, false));
		try {
			const result = await runtime.handlePluginApiRoute(
				"webhook-sink",
				"POST",
				"/hook",
				post('{"a":1}'),
			);

			expect(result.success).toBe(true);
			expect(captured.hasRawBody).toBe(false);
			expect(captured.input).toEqual({ a: 1 });
		} finally {
			await runtime.stopCron();
		}
	});
});
