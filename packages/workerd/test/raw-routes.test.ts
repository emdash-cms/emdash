import type { PluginManifest } from "emdash";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

import { generatePluginWrapper as cloudflareWrapper } from "../../cloudflare/src/sandbox/wrapper.js";
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
	bytes: async ({ input }) => ({ isBytes: input instanceof Uint8Array, body: [...input] }),
	json: async ({ input }) => ({ input, body: "ordinary JSON", status: 201, headers: {} }),
} };`;

const requestMeta = {
	url: "https://example.com/",
	method: "POST",
	headers: {},
	meta: { ip: null, userAgent: null, referer: null, geo: null },
};

function createCloudflareRpcFixture(pluginCode: string, hostCode: string) {
	return new Miniflare({
		workers: [
			{
				name: "host",
				compatibilityDate: "2026-04-01",
				modules: true,
				serviceBindings: { PLUGIN: "plugin" },
				script: hostCode,
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
}

const runners = [
	{ name: "Miniflare", Runner: MiniflareDevRunner },
	{ name: "workerd", Runner: WorkerdSandboxRunner },
];

describe("raw responses across sandbox transports", () => {
	it.each(runners)("preserves binary, empty, and JSON output through $name", async ({ Runner }) => {
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
			expect(await plugin.invokeRoute("bytes", new Uint8Array([0, 255]), requestMeta)).toEqual({
				isBytes: true,
				body: [0, 255],
			});
			expect(await plugin.invokeRoute("json", { value: 7 }, requestMeta)).toEqual({
				input: { value: 7 },
				body: "ordinary JSON",
				status: 201,
				headers: {},
			});
		} finally {
			await runner.terminateAll();
		}
	});

	it("passes a binary Response over Cloudflare Worker RPC", async () => {
		const mf = createCloudflareRpcFixture(
			code,
			`export default { async fetch(request, env) {
						return env.PLUGIN.invokeRoute("binary", undefined, { url: request.url, method: request.method, headers: {} });
					} };`,
		);
		try {
			const response = await mf.dispatchFetch("https://example.com/");
			expect(response.status).toBe(206);
			expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
			expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 128, 10]);
		} finally {
			await mf.dispose();
		}
	});
});
