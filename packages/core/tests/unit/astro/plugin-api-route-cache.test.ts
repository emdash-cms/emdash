/**
 * Cache-Control for the plugin API catch-all (`/_emdash/api/plugins/{id}/*`).
 *
 * Public routes may opt in to caching via `cacheControl` on the route
 * definition. The header must only appear on successful GET/HEAD responses of
 * public routes — everything else keeps the API default `private, no-store`.
 */

import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { describe, expect, it, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/plugins/[pluginId]/[...path].js";

const CACHE_VALUE = "public, max-age=60, stale-while-revalidate=300";

function createLocals({
	cacheControl,
	result = { success: true, data: { ok: true } },
}: {
	cacheControl?: string;
	result?: unknown;
} = {}) {
	const handlePluginApiRoute = vi.fn(async () => result);
	return {
		locals: {
			user: null,
			emdash: {
				handlePluginApiRoute,
				// Mirrors getRouteMeta: cacheControl is only ever present on public routes.
				getPluginRouteMeta: () => ({ public: true, cacheControl }),
			},
		},
		handlePluginApiRoute,
	};
}

function invoke(handler: APIRoute, method: string, locals: unknown) {
	const request = new Request("https://example.com/_emdash/api/plugins/demo/catalog", { method });
	return handler({
		params: { pluginId: "demo", path: "catalog" },
		request,
		locals,
	} as never);
}

describe("plugin API catch-all Cache-Control", () => {
	it("sets the route's Cache-Control on a successful public GET", async () => {
		const { locals } = createLocals({ cacheControl: CACHE_VALUE });
		const res = await invoke(GET, "GET", locals);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe(CACHE_VALUE);
	});

	it("sets the route's Cache-Control on HEAD (dispatched to the GET export)", async () => {
		const { locals } = createLocals({ cacheControl: CACHE_VALUE });
		const res = await invoke(GET, "HEAD", locals);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe(CACHE_VALUE);
	});

	it("keeps the private, no-store default when the route sets no cacheControl", async () => {
		const { locals } = createLocals();
		const res = await invoke(GET, "GET", locals);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("keeps the private, no-store default on POST even when cacheControl is set", async () => {
		const { locals } = createLocals({ cacheControl: CACHE_VALUE });
		const res = await invoke(POST, "POST", locals);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("never caches error responses", async () => {
		const { locals } = createLocals({
			cacheControl: CACHE_VALUE,
			result: { success: false, status: 404, error: { code: "NOT_FOUND", message: "nope" } },
		});
		const res = await invoke(GET, "GET", locals);
		expect(res.status).toBe(404);
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});
});

describe("plugin API raw responses", () => {
	it("preserves custom HTTP output", async () => {
		const { locals } = createLocals({
			result: {
				success: true,
				data: new Response("<urlset/>", {
					status: 201,
					headers: { "Content-Type": "application/xml" },
				}),
			},
		});
		const res = await invoke(GET, "GET", locals);
		expect(res.status).toBe(201);
		expect(res.headers.get("Content-Type")).toBe("application/xml");
		expect(await res.text()).toBe("<urlset/>");
	});
});

it("keeps private raw responses uncacheable", async () => {
	const response = await GET({
		params: { pluginId: "demo", path: "export" },
		request: new Request("https://example.com/_emdash/api/plugins/demo/export", {
			headers: { "X-EmDash-Request": "1" },
		}),
		locals: {
			user: { id: "admin", role: Role.ADMIN },
			emdash: {
				getPluginRouteMeta: () => ({ public: false, cacheControl: CACHE_VALUE }),
				handlePluginApiRoute: async () => ({
					success: true,
					data: new Response("private export", {
						headers: { "Cache-Control": CACHE_VALUE, "Content-Type": "text/csv" },
					}),
				}),
			},
		},
	} as never);
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(await response.text()).toBe("private export");
});

it.each(["GET", "HEAD"])("honors response caching on a public %s", async (method) => {
	const { locals } = createLocals({
		result: {
			success: true,
			data: new Response("feed", { headers: { "Cache-Control": CACHE_VALUE } }),
		},
	});
	const response = await invoke(GET, method, locals);
	expect(response.headers.get("Cache-Control")).toBe(CACHE_VALUE);
});

it("lets the route cache option override raw response headers", async () => {
	const { locals } = createLocals({
		cacheControl: CACHE_VALUE,
		result: {
			success: true,
			data: new Response("feed", { headers: { "Cache-Control": "public, max-age=1" } }),
		},
	});
	const response = await invoke(GET, "GET", locals);
	expect(response.headers.get("Cache-Control")).toBe(CACHE_VALUE);
});
