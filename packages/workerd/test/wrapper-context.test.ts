import { describe, expect, it } from "vitest";

import { generatePluginWrapper } from "../src/sandbox/wrapper.js";

describe("Workerd generated plugin context", () => {
	it("omits content and schema when their capabilities are absent", () => {
		const generated = generatePluginWrapper(
			{
				id: "no-discovery",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
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
		// eslint-disable-next-line no-implied-eval -- generated worker context is exercised with a local bridge
		const factory = new Function("fetch", "pluginModule", `${source}\nreturn createContext();`);
		const context = factory(() => undefined, {}) as Record<string, unknown>;

		expect(context.content).toBeUndefined();
		expect(context.schema).toBeUndefined();
	});

	it("exposes schema discovery and separately gated revision methods", async () => {
		const generated = generatePluginWrapper(
			{
				id: "content-discovery",
				version: "1.0.0",
				capabilities: ["schema:read", "content:revisions:read"],
				allowedHosts: [],
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
			if (url.endsWith("/schema/listCollections"))
				return Response.json({ result: [{ slug: "posts" }] });
			if (url.endsWith("/content/listRevisions"))
				return Response.json({ result: [{ id: "rev-1" }] });
			return Response.json({ result: null });
		};
		// eslint-disable-next-line no-implied-eval -- generated worker context is exercised with a local bridge
		const factory = new Function("fetch", "pluginModule", `${source}\nreturn createContext();`);
		const context = factory(fetch, {}) as {
			schema: { listCollections(): Promise<Array<{ slug: string }>> };
			content: { listRevisions(collection: string, id: string): Promise<Array<{ id: string }>> };
		};

		await expect(context.schema.listCollections()).resolves.toEqual([{ slug: "posts" }]);
		await expect(context.content.listRevisions("posts", "post-1")).resolves.toEqual([
			{ id: "rev-1" },
		]);
		expect(calls).toEqual([
			"http://bridge/schema/listCollections",
			"http://bridge/content/listRevisions",
		]);
	});

	it("exposes comment reads and moderation when only the implying capability is declared", async () => {
		const generated = generatePluginWrapper(
			{
				id: "comment-wrapper",
				version: "1.0.0",
				capabilities: ["comments:moderate"],
				allowedHosts: [],
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
			return Response.json({ result: { id: "comment-1", status: "approved" } });
		};
		// eslint-disable-next-line no-implied-eval -- generated worker context is exercised with a local bridge
		const factory = new Function("fetch", "pluginModule", `${source}\nreturn createContext();`);
		const context = factory(fetch, {}) as {
			comments: {
				get(id: string): Promise<unknown>;
				setStatus(
					id: string,
					status: string,
					options: { expectedStatus: string },
				): Promise<unknown>;
			};
		};
		await context.comments.get("comment-1");
		await context.comments.setStatus("comment-1", "approved", { expectedStatus: "pending" });
		expect(calls).toEqual(["http://bridge/comments/get", "http://bridge/comments/setStatus"]);
	});

	it("exposes canonical users access, cron, and real HTTP responses", async () => {
		const generated = generatePluginWrapper(
			{
				id: "context-wrapper",
				version: "1.0.0",
				capabilities: ["users:read", "network:request", "redirects:read", "content:publish"],
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
			if (url.endsWith("/redirect/list")) {
				return Response.json({
					result: { ok: true, value: { items: [{ source: "/old" }], hasMore: false } },
				});
			}
			if (url.endsWith("/content/getVersioned")) {
				return Response.json({ result: { item: { id: "post-1" }, _rev: "rev-1" } });
			}
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
			content: {
				getVersioned(collection: string, id: string): Promise<unknown>;
				getTranslations?: unknown;
				getPublicUrl?: unknown;
			};
			users: { get(id: string): Promise<{ id: string }> };
			cron: { list(): Promise<unknown[]> };
			redirects: { list(): Promise<{ items: Array<{ source: string }> }>; create?: unknown };
			http: { fetch(url: string): Promise<Response> };
		};

		await expect(context.content.getVersioned("posts", "post-1")).resolves.toEqual({
			item: { id: "post-1" },
			_rev: "rev-1",
		});
		expect(context.content.getTranslations).toBeTypeOf("function");
		expect(context.content.getPublicUrl).toBeTypeOf("function");
		await expect(context.users.get("user-1")).resolves.toEqual({ id: "user-1" });
		await expect(context.cron.list()).resolves.toEqual([]);
		await expect(context.redirects.list()).resolves.toEqual({
			items: [{ source: "/old" }],
			hasMore: false,
		});
		expect(context.redirects.create).toBeUndefined();
		const response = await context.http.fetch("https://api.example.com/status");
		expect(response).toBeInstanceOf(Response);
		await expect(response.json()).resolves.toEqual({ ok: true });
		expect(calls).toEqual([
			"http://bridge/content/getVersioned",
			"http://bridge/users/get",
			"http://bridge/cron/list",
			"http://bridge/redirect/list",
			"http://bridge/http/fetch",
		]);
	});
});
