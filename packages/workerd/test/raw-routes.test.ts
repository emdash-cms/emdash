import type { PluginManifest } from "emdash";
import { Miniflare } from "miniflare";
import { beforeAll, describe, expect, it } from "vitest";

import { generatePluginWrapper as cloudflareWrapper } from "../../cloudflare/src/sandbox/wrapper.js";
import { buildBodyModePlugin } from "../../core/tests/utils/body-mode-plugin.js";
import { MiniflareDevRunner } from "../src/sandbox/dev-runner.js";
import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

const manifest: PluginManifest = {
	id: "raw-http",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [],
	admin: {},
};
const code = `export default { routes: {
	binary: async () => new Response(new Uint8Array([0, 255, 128, 10]), { status: 206, headers: { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="data.bin"' } }),
	empty: async () => new Response(null, { status: 204 }),
	redirect: async () => Response.redirect("https://example.com/feed", 307),
	json: async ({ input }) => ({ input, body: "ordinary JSON", status: 201, headers: {} }),
	raw: async ({ input }) => new Response(input, { headers: { "Content-Type": "text/plain" } }),
} };`;

const requestMeta = {
	url: "https://example.com/",
	method: "POST",
	headers: {},
	meta: { ip: null, userAgent: null, referer: null, geo: null },
};

const runners = [
	{ name: "Miniflare", Runner: MiniflareDevRunner },
	{ name: "workerd", Runner: WorkerdSandboxRunner },
];

describe("raw responses across sandbox transports", () => {
	it.each(runners)(
		"preserves binary, empty, redirect, text, and JSON output through $name",
		async ({ Runner }) => {
			const runner = new Runner({ db: null as never });
			try {
				const plugin = await runner.load(manifest, code);
				const binary = await plugin.invokeRoute("binary", undefined, requestMeta);
				expect(binary).toBeInstanceOf(Response);
				if (!(binary instanceof Response)) throw new Error("Expected a response");
				expect(binary.status).toBe(206);
				expect(binary.headers.get("Content-Disposition")).toBe('attachment; filename="data.bin"');
				expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([0, 255, 128, 10]);
				const empty = await plugin.invokeRoute("empty", undefined, requestMeta);
				expect(empty).toMatchObject({ status: 204, body: null });
				const redirect = await plugin.invokeRoute("redirect", undefined, requestMeta);
				if (!(redirect instanceof Response)) throw new Error("Expected a response");
				expect(redirect.status).toBe(307);
				expect(redirect.headers.get("Location")).toBe("https://example.com/feed");
				const raw = await plugin.invokeRoute("raw", "Olá\r\n", requestMeta);
				if (!(raw instanceof Response)) throw new Error("Expected a response");
				expect(await raw.text()).toBe("Olá\r\n");
				expect(await plugin.invokeRoute("json", { value: 7 }, requestMeta)).toEqual({
					input: { value: 7 },
					body: "ordinary JSON",
					status: 201,
					headers: {},
				});
			} finally {
				await runner.terminateAll();
			}
		},
	);

	it("passes raw text and a native Response over Cloudflare Worker RPC", async () => {
		const mf = new Miniflare({
			workers: [
				{
					name: "host",
					compatibilityDate: "2026-04-01",
					modules: true,
					serviceBindings: { PLUGIN: "plugin" },
					script: `export default { async fetch(request, env) {
					return env.PLUGIN.invokeRoute("raw", await request.text(), { url: request.url, method: request.method, headers: {} });
				} };`,
				},
				{
					name: "plugin",
					compatibilityDate: "2026-04-01",
					modulesRoot: "/",
					modules: [
						{ type: "ESModule", path: "worker.js", contents: cloudflareWrapper(manifest) },
						{ type: "ESModule", path: "sandbox-plugin.js", contents: code },
					],
				},
			],
		});
		try {
			const response = await mf.dispatchFetch("https://example.com/", {
				method: "POST",
				body: "Olá\r\n",
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("text/plain");
			expect(await response.text()).toBe("Olá\r\n");
		} finally {
			await mf.dispose();
		}
	});
});

describe("sandbox body schema validation", () => {
	let pluginCode: string;
	beforeAll(async () => {
		pluginCode = await buildBodyModePlugin();
	});

	it.each(runners)(
		"validates and transforms text, bytes, and JSON through $name",
		async ({ Runner }) => {
			const runner = new Runner({ db: null as never });
			try {
				const plugin = await runner.load(manifest, pluginCode);
				expect(await plugin.invokeRoute("text", "41", requestMeta)).toBe(42);
				expect(await plugin.invokeRoute("bytes", new Uint8Array([0xff, 0]), requestMeta)).toBe(3);
				expect(await plugin.invokeRoute("json", { amount: 41 }, requestMeta)).toBe(42);
				for (const [name, input] of [
					["text", "invalid"],
					["bytes", new Uint8Array()],
					["json", { amount: -1 }],
				] as const) {
					await expect(plugin.invokeRoute(name, input, requestMeta)).rejects.toMatchObject({
						code: "VALIDATION_ERROR",
						status: 400,
					});
				}
				const data = { inputEncoding: "bytes", input: [1, 2] };
				expect(await plugin.invokeRoute("echo", data, requestMeta)).toEqual(data);
			} finally {
				await runner.terminateAll();
			}
		},
	);

	it("validates and transforms text, bytes, and JSON over Cloudflare RPC", async () => {
		const mf = new Miniflare({
			workers: [
				{
					name: "host",
					compatibilityDate: "2026-04-01",
					modules: true,
					serviceBindings: { PLUGIN: "plugin" },
					script: `export default { async fetch(request, env) {
				const name = new URL(request.url).pathname.slice(1);
				const input = name === "bytes" ? new Uint8Array(await request.arrayBuffer()) : name === "text" ? await request.text() : await request.json();
				return Response.json(await env.PLUGIN.invokeRoute(name, input, { url: request.url, method: request.method, headers: {} }));
			} };`,
				},
				{
					name: "plugin",
					compatibilityDate: "2026-04-01",
					modulesRoot: "/",
					modules: [
						{ type: "ESModule", path: "worker.js", contents: cloudflareWrapper(manifest) },
						{ type: "ESModule", path: "sandbox-plugin.js", contents: pluginCode },
					],
				},
			],
		});
		try {
			const text = await mf.dispatchFetch("https://example.com/text", {
				method: "POST",
				body: "41",
			});
			expect(await text.json()).toBe(42);
			const bytes = await mf.dispatchFetch("https://example.com/bytes", {
				method: "POST",
				body: new Uint8Array([0xff, 0]),
			});
			expect(await bytes.json()).toBe(3);
			const json = await mf.dispatchFetch("https://example.com/json", {
				method: "POST",
				body: '{"amount":41}',
			});
			expect(await json.json()).toBe(42);
			for (const [name, body] of [
				["text", "invalid"],
				["bytes", ""],
				["json", '{"amount":-1}'],
			]) {
				const response = await mf.dispatchFetch("https://example.com/" + name, {
					method: "POST",
					body,
				});
				expect(await response.json()).toMatchObject({
					__emdashSandboxRouteError: true,
					error: { code: "VALIDATION_ERROR", status: 400 },
				});
			}
		} finally {
			await mf.dispose();
		}
	});
});
