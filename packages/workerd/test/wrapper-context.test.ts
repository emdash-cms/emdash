import { describe, expect, it } from "vitest";

import {
	bytesOverLimit,
	INVALID_PLUGIN_HTTP_BYTES,
} from "../../core/tests/fixtures/plugin-http.js";
import { generatePluginWrapper } from "../src/sandbox/wrapper.js";

describe("Workerd generated plugin context", () => {
	it("exposes canonical users access, cron, and real HTTP responses", async () => {
		const generated = generatePluginWrapper(
			{
				id: "context-wrapper",
				version: "1.0.0",
				capabilities: ["users:read", "network:request"],
				allowedHosts: ["api.example.com"],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			{ backingServiceUrl: "http://bridge", authToken: "auth", invokeToken: "invoke" },
		);
		const end = generated.indexOf("\nexport default {");
		if (end < 0) throw new Error("Generated worker entry point is missing");
		const source = generated
			.slice(0, end)
			.replace('import pluginModule from "sandbox-plugin.js";', "");
		const calls: string[] = [];
		const fetch = async (url: string) => {
			calls.push(url);
			if (url.endsWith("/users/get")) return Response.json({ result: { id: "user-1" } });
			if (url.endsWith("/cron/list")) return Response.json({ result: [] });
			return Response.json({
				result: {
					status: 206,
					statusText: "Partial Content",
					headers: [["content-type", "application/octet-stream"]],
					finalUrl: "https://cdn.example.com/final",
					redirected: true,
					body: {
						__emdashBytes: btoa(String.fromCharCode(...INVALID_PLUGIN_HTTP_BYTES)),
					},
				},
			});
		};
		// eslint-disable-next-line no-implied-eval -- generated worker context is exercised with a local bridge
		const factory = new Function("fetch", "pluginModule", `${source}\nreturn createContext();`);
		const context = factory(fetch, {}) as {
			users: { get(id: string): Promise<{ id: string }> };
			cron: { list(): Promise<unknown[]> };
			http: { fetch(url: string): Promise<Response> };
		};

		await expect(context.users.get("user-1")).resolves.toEqual({ id: "user-1" });
		await expect(context.cron.list()).resolves.toEqual([]);
		const response = await context.http.fetch("https://api.example.com/status");
		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(206);
		expect(response.statusText).toBe("Partial Content");
		expect(response.url).toBe("https://cdn.example.com/final");
		expect(response.redirected).toBe(true);
		const clone = response.clone();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(INVALID_PLUGIN_HTTP_BYTES);
		expect(new Uint8Array(await clone.arrayBuffer())).toEqual(INVALID_PLUGIN_HTTP_BYTES);
		expect(clone.url).toBe("https://cdn.example.com/final");
		expect(calls).toEqual([
			"http://bridge/users/get",
			"http://bridge/cron/list",
			"http://bridge/http/fetch",
		]);
	});

	it("rejects a streamed request before calling the backing bridge", async () => {
		const generated = generatePluginWrapper(
			{
				id: "request-limit-wrapper",
				version: "1.0.0",
				capabilities: ["network:request"],
				allowedHosts: ["api.example.com"],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			{ backingServiceUrl: "http://bridge", authToken: "auth", invokeToken: "invoke" },
		);
		const end = generated.indexOf("\nexport default {");
		if (end < 0) throw new Error("Generated worker entry point is missing");
		const source = generated
			.slice(0, end)
			.replace('import pluginModule from "sandbox-plugin.js";', "");
		const fetch = async () => {
			throw new Error("bridge must not be called");
		};
		// eslint-disable-next-line no-implied-eval -- generated worker context is exercised with a local bridge
		const factory = new Function("fetch", "pluginModule", `${source}\nreturn createContext();`);
		const context = factory(fetch, {}) as {
			http: { fetch(url: string, init: RequestInit): Promise<Response> };
		};

		await expect(
			context.http.fetch("https://api.example.com/upload", {
				method: "POST",
				body: bytesOverLimit(8 * 1024 * 1024),
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Node's fetch runtime requires duplex for streamed request bodies but lib.dom omits it
				duplex: "half",
			} as RequestInit),
		).rejects.toThrow(/request body exceeds the 8388608 byte limit/i);
	});
});
