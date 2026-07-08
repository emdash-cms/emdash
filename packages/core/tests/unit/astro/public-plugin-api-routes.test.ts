import { describe, expect, it, vi } from "vitest";

import { createPublicPluginApiRouteHandler } from "../../../src/astro/public-plugin-api-routes.js";

function createRuntime(meta: { public: boolean } | null) {
	const result = { success: true, data: { ok: true } };
	const handlePluginApiRoute = vi.fn(async () => result);
	const getPluginRouteMeta = vi.fn(() => meta);

	return {
		runtime: {
			getPluginRouteMeta,
			handlePluginApiRoute,
		},
		getPluginRouteMeta,
		handlePluginApiRoute,
		result,
	};
}

describe("createPublicPluginApiRouteHandler", () => {
	it("delegates to the runtime when the plugin route is public", async () => {
		const { runtime, getPluginRouteMeta, handlePluginApiRoute, result } = createRuntime({
			public: true,
		});
		const request = new Request("https://example.com/_emdash/api/plugins/demo/definition", {
			method: "POST",
			body: "{}",
		});

		const handler = createPublicPluginApiRouteHandler(runtime);
		const actual = await handler("demo", "POST", "/definition", request);

		expect(getPluginRouteMeta).toHaveBeenCalledWith("demo", "/definition");
		expect(handlePluginApiRoute).toHaveBeenCalledWith("demo", "POST", "/definition", request);
		expect(actual).toBe(result);
	});

	it("returns not found without invoking private plugin routes", async () => {
		const { runtime, handlePluginApiRoute } = createRuntime({ public: false });
		const handler = createPublicPluginApiRouteHandler(runtime);

		const result = await handler(
			"demo",
			"POST",
			"/admin",
			new Request("https://example.com/_emdash/api/plugins/demo/admin"),
		);

		expect(handlePluginApiRoute).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: false,
			error: {
				code: "NOT_FOUND",
				message: "Plugin route not found",
			},
		});
	});

	it("returns not found without invoking missing plugin routes", async () => {
		const { runtime, handlePluginApiRoute } = createRuntime(null);
		const handler = createPublicPluginApiRouteHandler(runtime);

		const result = await handler(
			"demo",
			"POST",
			"/missing",
			new Request("https://example.com/_emdash/api/plugins/demo/missing"),
		);

		expect(handlePluginApiRoute).not.toHaveBeenCalled();
		expect(result.error?.code).toBe("NOT_FOUND");
	});
});
