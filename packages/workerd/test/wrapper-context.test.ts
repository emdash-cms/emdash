import { describe, expect, it } from "vitest";

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
					status: 200,
					statusText: "OK",
					headers: { "content-type": "application/json" },
					bodyBase64: btoa('{"ok":true}'),
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
		await expect(response.json()).resolves.toEqual({ ok: true });
		expect(calls).toEqual([
			"http://bridge/users/get",
			"http://bridge/cron/list",
			"http://bridge/http/fetch",
		]);
	});
});
