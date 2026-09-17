import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { describe, expect, it, vi } from "vitest";

import { GET, HEAD, POST } from "../../../src/astro/routes/api/plugins/[pluginId]/[...path].js";
import { pluginResponse } from "../../../src/plugin-types.js";
import type { RouteMeta } from "../../../src/plugins/routes.js";

function createLocals(routeMeta: RouteMeta, data: unknown, user: unknown = null) {
	const handlePluginApiRoute = vi.fn(async () => ({ success: true, data }));
	return {
		locals: {
			user,
			emdash: {
				getPluginRouteMeta: () => routeMeta,
				handlePluginApiRoute,
			},
		},
		handlePluginApiRoute,
	};
}

function invoke(handler: APIRoute, method: string, locals: unknown) {
	return handler({
		params: { pluginId: "reports", path: "download" },
		request: new Request("https://example.com/_emdash/api/plugins/reports/download", {
			method,
			headers: { "X-EmDash-Request": "1" },
		}),
		locals,
	} as never);
}

describe("declared plugin route methods", () => {
	it("returns 405 with Allow before invoking a disallowed method", async () => {
		const { locals, handlePluginApiRoute } = createLocals(
			{ public: true, methods: ["POST", "DELETE"] },
			{ ok: true },
		);
		const response = await invoke(GET, "GET", locals);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST, DELETE");
		expect(handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("invokes an allowed declared method", async () => {
		const { locals, handlePluginApiRoute } = createLocals(
			{ public: true, methods: ["POST"] },
			{ ok: true },
		);
		const response = await invoke(POST, "POST", locals);
		expect(response.status).toBe(200);
		expect(handlePluginApiRoute).toHaveBeenCalledOnce();
	});
});

describe("raw plugin route responses", () => {
	it("serves declared bytes, status, and safe headers without a JSON envelope", async () => {
		const { locals } = createLocals(
			{ public: true, response: "raw", methods: ["GET"] },
			pluginResponse({
				status: 201,
				headers: { "content-type": "text/csv", "x-plugin": "reports" },
				body: { kind: "bytes", value: new Uint8Array([0, 255, 10]) },
			}),
		);
		const response = await invoke(GET, "GET", locals);
		expect(response.status).toBe(201);
		expect(response.headers.get("content-type")).toBe("text/csv");
		expect(response.headers.get("x-plugin")).toBe("reports");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 10]));
	});

	it("applies route-owned caching and strips plugin-owned cache and cookie headers", async () => {
		const { locals } = createLocals(
			{
				public: true,
				response: "raw",
				cacheControl: "public, max-age=60",
			},
			pluginResponse({
				headers: {
					"cache-control": "public, max-age=9999",
					"set-cookie": "session=secret",
				},
			}),
		);
		const response = await invoke(GET, "GET", locals);
		expect(response.headers.get("cache-control")).toBe("public, max-age=60");
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("does not cache a raw error status", async () => {
		const { locals } = createLocals(
			{
				public: true,
				response: "raw",
				cacheControl: "public, max-age=60",
			},
			pluginResponse({ status: 404, body: { kind: "text", value: "missing" } }),
		);
		const response = await invoke(GET, "GET", locals);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("forces private raw routes to remain private and no-store", async () => {
		const { locals } = createLocals(
			{ public: false, response: "raw", cacheControl: "public, max-age=600" },
			pluginResponse({ headers: { "cache-control": "public, max-age=9999" } }),
			{ id: "admin", role: Role.ADMIN },
		);
		const response = await invoke(GET, "GET", locals);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("rejects active content but keeps undeclared marker-shaped values as JSON", async () => {
		const active = createLocals(
			{ public: true, response: "raw" },
			pluginResponse({
				headers: { "content-type": "text/html" },
				body: { kind: "text", value: "<script>alert(1)</script>" },
			}),
		);
		expect((await invoke(GET, "GET", active.locals)).status).toBe(500);

		const undeclared = createLocals(
			{ public: true },
			pluginResponse({ body: { kind: "text", value: "plain" } }),
		);
		const response = await invoke(GET, "GET", undeclared.locals);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				__emdashPluginResponse: true,
				status: 200,
				headers: [],
				body: { kind: "text", value: "plain" },
			},
		});
	});

	it("keeps ordinary JSON response objects enveloped", async () => {
		const data = { status: 201, headers: {}, body: "ordinary JSON" };
		const { locals } = createLocals({ public: true }, data);
		const response = await invoke(GET, "GET", locals);
		expect(await response.json()).toEqual({ success: true, data });
	});

	it("exports a real HEAD handler that suppresses the raw body", async () => {
		const { locals } = createLocals(
			{ public: true, response: "raw", methods: ["HEAD"] },
			pluginResponse({ body: { kind: "text", value: "hidden" } }),
		);
		const response = await invoke(HEAD, "HEAD", locals);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
	});
});
