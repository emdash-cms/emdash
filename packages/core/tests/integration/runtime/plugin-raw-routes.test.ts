import { createHmac, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { MiniflareDevRunner } from "../../../../workerd/src/sandbox/dev-runner.js";
import { GET, POST } from "../../../src/astro/routes/api/plugins/[pluginId]/[...path].js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { PluginRoute } from "../../../src/plugins/types.js";

const runtimes: EmDashRuntime[] = [];
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.stopCron()));
});

async function invoke(
	route: PluginRoute,
	body?: string | Uint8Array<ArrayBuffer>,
	method = "POST",
) {
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
	return (method === "POST" ? POST : GET)({
		params: { pluginId: "raw-demo", path: "test" },
		request: new Request("https://example.com/_emdash/api/plugins/raw-demo/test", {
			method,
			...(body === undefined ? {} : { body }),
		}),
		locals: { emdash: runtime, user: null },
	} as never);
}

describe("raw plugin routes", () => {
	it("verifies a signature over the original webhook text", async () => {
		const body = '{ "message": "Olá",\r\n "amount": 1.00 }\n';
		const signature = createHmac("sha256", "webhook-secret")
			.update(Buffer.from(body))
			.digest("hex");
		const response = await invoke(
			{
				public: true,
				body: "text",
				handler: async (ctx) => {
					if (typeof ctx.input !== "string") throw new Error("Expected raw request text");
					expect(() => ctx.request.text()).toThrow("ctx.input");
					return {
						signature: createHmac("sha256", "webhook-secret").update(ctx.input).digest("hex"),
					};
				},
			},
			body,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: { signature },
		});
	});

	it.each(["", "not JSON\r\n"])("accepts raw text %j", async (body) => {
		const response = await invoke(
			{ public: true, body: "text", handler: async (ctx) => ctx.input },
			body,
		);
		expect(await response.json()).toEqual({ success: true, data: body });
	});

	it("keeps JSON validation and the consumed-body guard", async () => {
		const response = await invoke(
			{
				public: true,
				input: z.object({ value: z.number() }),
				handler: async (ctx) => {
					expect(() => ctx.request.text()).toThrow("ctx.input");
					return ctx.input;
				},
			},
			'{"value":7}',
		);
		expect(await response.json()).toEqual({ success: true, data: { value: 7 } });
	});

	it("serves a Response body, status, and headers without a JSON envelope", async () => {
		const response = await invoke(
			{
				public: true,
				handler: async () =>
					new Response("<urlset/>", {
						status: 201,
						headers: { "Content-Type": "application/xml", "X-Plugin": "demo" },
					}),
			},
			undefined,
			"GET",
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("Content-Type")).toBe("application/xml");
		expect(response.headers.get("X-Plugin")).toBe("demo");
		expect(await response.text()).toBe("<urlset/>");
	});

	it("preserves redirect responses with immutable headers", async () => {
		const response = await invoke(
			{ public: true, handler: async () => Response.redirect("https://example.com/feed", 307) },
			undefined,
			"GET",
		);
		expect(response.status).toBe(307);
		expect(response.headers.get("Location")).toBe("https://example.com/feed");
	});

	it("does not cache raw error responses", async () => {
		const response = await invoke(
			{
				public: true,
				cacheControl: "public, max-age=60",
				handler: async () =>
					new Response("no", { status: 404, headers: { "Cache-Control": "public, max-age=60" } }),
			},
			undefined,
			"GET",
		);
		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.text()).toBe("no");
	});
});

describe("sandboxed raw plugin routes", () => {
	it("verifies a webhook signature inside a real isolate", async () => {
		const body = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10, 128]);
		const signature = createHmac("sha256", "webhook-secret")
			.update(Buffer.from(body))
			.digest("hex");
		const runner = new MiniflareDevRunner({ db: null as never });
		try {
			const runtime = await EmDashRuntime.create({
				config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
				plugins: [],
				createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
				createStorage: null,
				sandboxEnabled: true,
				createSandboxRunner: () => runner,
				sandboxedPluginEntries: [
					{
						id: "raw-sandbox",
						version: "1.0.0",
						options: {},
						capabilities: [],
						allowedHosts: [],
						storage: {},
						routes: [{ name: "webhook", public: true, body: "bytes" }],
						code: `export default { routes: { webhook: { body: "bytes", handler: async (ctx) => {
						const encoder = new TextEncoder();
						const key = await crypto.subtle.importKey("raw", encoder.encode("webhook-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
						const digest = await crypto.subtle.sign("HMAC", key, ctx.input);
						const signature = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
						return new Response(signature, { status: ctx.input instanceof Uint8Array ? 202 : 400, headers: { "Content-Type": "text/plain", "X-Webhook": "verified" } });
					} } } };`,
					},
				],
			});
			runtimes.push(runtime);
			const response = await POST({
				params: { pluginId: "raw-sandbox", path: "webhook" },
				request: new Request("https://example.com/_emdash/api/plugins/raw-sandbox/webhook", {
					method: "POST",
					body,
				}),
				locals: { emdash: runtime, user: null },
			} as never);
			expect(response.status).toBe(202);
			expect(response.headers.get("Content-Type")).toBe("text/plain");
			expect(response.headers.get("X-Webhook")).toBe("verified");
			expect(await response.text()).toBe(signature);
		} finally {
			await runner.terminateAll();
		}
	});
});

it("preserves all request bytes, including a BOM and invalid UTF-8", async () => {
	const body = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0, 13, 10, 128]);
	const signature = createHmac("sha256", "secret").update(body).digest("hex");
	const response = await invoke(
		{
			public: true,
			body: "bytes",
			handler: async ({ input }) => {
				expect(input).toBeInstanceOf(Uint8Array);
				return createHmac("sha256", "secret").update(input).digest("hex");
			},
		},
		body,
	);
	expect(await response.json()).toEqual({ success: true, data: signature });
});

it("validates and transforms text input before calling the handler", async () => {
	const route: PluginRoute<number> = {
		public: true,
		body: "text",
		input: z.string().regex(/^\d+$/).transform(Number),
		handler: async ({ input }) => input + 1,
	};
	const valid = await invoke(route, "41");
	expect(await valid.json()).toEqual({ success: true, data: 42 });
	const invalid = await invoke(route, "not a number");
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toMatchObject({
		success: false,
		error: { code: "VALIDATION_ERROR" },
	});
});

it("validates byte input before calling the handler", async () => {
	const route: PluginRoute<Uint8Array> = {
		public: true,
		body: "bytes",
		input: z.instanceof(Uint8Array).refine((value) => value.length > 0),
		handler: async ({ input }) => input.length,
	};
	expect((await invoke(route, new Uint8Array())).status).toBe(400);
	const response = await invoke(route, new Uint8Array([255, 0]));
	expect(await response.json()).toEqual({ success: true, data: 2 });
});
