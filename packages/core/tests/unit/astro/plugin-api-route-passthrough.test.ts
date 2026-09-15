/**
 * Response passthrough through the plugin API catch-all (#2110).
 *
 * A trusted plugin's route handler may return a `Response` to serve non-JSON
 * content. The catch-all sends it as-is, but it keeps the envelope's caching
 * rule: private routes always send `private, no-store`, a public route starts
 * from that default, and a public GET/HEAD takes the route's `cacheControl`
 * unless the handler set `Cache-Control` on its own Response.
 */

import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { describe, expect, it, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/plugins/[pluginId]/[...path].js";

const CACHE_VALUE = "public, max-age=60, stale-while-revalidate=300";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function passthrough(init: ResponseInit = {}, body: BodyInit | null = PNG) {
	const response = new Response(body, {
		...init,
		headers: { "Content-Type": "image/png", ...(init.headers as Record<string, string>) },
	});
	return { success: true, response, status: response.status };
}

function createLocals({
	routePublic = true,
	cacheControl,
	result = passthrough(),
}: {
	routePublic?: boolean;
	cacheControl?: string;
	result?: unknown;
} = {}) {
	return {
		user: routePublic ? null : { id: "u1", role: Role.ADMIN },
		emdash: {
			handlePluginApiRoute: vi.fn(async () => result),
			// Mirrors getRouteMeta: cacheControl is only ever present on public routes.
			getPluginRouteMeta: () => ({
				public: routePublic,
				cacheControl: routePublic ? cacheControl : undefined,
			}),
		},
	};
}

function invoke(handler: APIRoute, method: string, locals: unknown) {
	const request = new Request("https://example.com/_emdash/api/plugins/demo/image", {
		method,
		headers: { "X-EmDash-Request": "1" },
	});
	return handler({
		params: { pluginId: "demo", path: "image" },
		request,
		locals,
	} as never);
}

describe("plugin API catch-all Response passthrough (#2110)", () => {
	it("sends the handler's body, status and content type instead of the JSON envelope", async () => {
		const res = await invoke(GET, "GET", createLocals());

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});

	it("carries a non-200 status and its headers", async () => {
		const result = passthrough({ status: 302, headers: { Location: "/elsewhere" } }, null);
		const res = await invoke(GET, "GET", createLocals({ result }));

		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/elsewhere");
	});

	it("keeps private, no-store on a public route that declares no cacheControl", async () => {
		const res = await invoke(GET, "GET", createLocals());

		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("applies a public route's cacheControl on GET when the handler set none", async () => {
		const res = await invoke(GET, "GET", createLocals({ cacheControl: CACHE_VALUE }));

		expect(res.headers.get("Cache-Control")).toBe(CACHE_VALUE);
	});

	it("lets a public handler's own Cache-Control win over the route's cacheControl", async () => {
		const result = passthrough({ headers: { "Cache-Control": "public, max-age=5" } });
		const res = await invoke(GET, "GET", createLocals({ cacheControl: CACHE_VALUE, result }));

		expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
	});

	it("keeps private, no-store on a public POST even when cacheControl is set", async () => {
		const res = await invoke(POST, "POST", createLocals({ cacheControl: CACHE_VALUE }));

		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("forces private, no-store on a private route whatever the handler set", async () => {
		const result = passthrough({ headers: { "Cache-Control": "public, max-age=600" } });
		const res = await invoke(GET, "GET", createLocals({ routePublic: false, result }));

		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
	});
});
