/**
 * Auth for the plugin API catch-all (`/_emdash/api/plugins/{id}/*`).
 *
 * Regression coverage for #1853: because plugin routes dispatch by name only
 * (the HTTP method never selects a different handler), a route reached via GET
 * or HEAD runs the same code as one reached via POST. The route must not tier
 * permission or CSRF by method — every private invocation needs
 * the route's declared permission (defaulting to `plugins:manage`) and the
 * CSRF header, so a caller cannot change authorization by choosing the method.
 */

import type { RoleLevel } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { describe, expect, it, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/plugins/[pluginId]/[...path].js";

function createLocals(role: RoleLevel | null, routePublic: boolean, permission?: string) {
	const handlePluginApiRoute = vi.fn(async () => ({ success: true, data: { ok: true } }));
	return {
		locals: {
			user: role == null ? null : { id: "u1", role },
			emdash: {
				handlePluginApiRoute,
				getPluginRouteMeta: () => ({ public: routePublic, permission }),
			},
		},
		handlePluginApiRoute,
	};
}

function invoke(
	handler: APIRoute,
	method: string,
	locals: unknown,
	{ csrf = true }: { csrf?: boolean } = {},
) {
	const headers = new Headers();
	if (csrf) headers.set("X-EmDash-Request", "1");
	const request = new Request("https://example.com/_emdash/api/plugins/demo/updateHomeConfig", {
		method,
		headers,
	});
	// The catch-all reads params.pluginId / params.path and locals.
	return handler({
		params: { pluginId: "demo", path: "updateHomeConfig" },
		request,
		locals,
	} as never);
}

describe("plugin API catch-all auth (#1853)", () => {
	it("does not run a private route for an editor via GET", async () => {
		const { locals, handlePluginApiRoute } = createLocals(Role.EDITOR, false);
		const res = await invoke(GET, "GET", locals);
		expect(res.status).toBe(403);
		expect(handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("does not run a private route for an editor via HEAD (dispatched to GET export)", async () => {
		const { locals, handlePluginApiRoute } = createLocals(Role.EDITOR, false);
		const res = await invoke(GET, "HEAD", locals);
		expect(res.status).toBe(403);
		expect(handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("still blocks an editor via POST", async () => {
		const { locals, handlePluginApiRoute } = createLocals(Role.EDITOR, false);
		const res = await invoke(POST, "POST", locals);
		expect(res.status).toBe(403);
		expect(handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("honors a private route's explicitly declared permission", async () => {
		const { locals, handlePluginApiRoute } = createLocals(Role.EDITOR, false, "content:create");
		const res = await invoke(POST, "POST", locals);
		expect(res.status).toBe(200);
		expect(handlePluginApiRoute).toHaveBeenCalledOnce();
	});

	it("rejects a private GET without the CSRF header even for an admin", async () => {
		const { locals, handlePluginApiRoute } = createLocals(Role.ADMIN, false);
		const res = await invoke(GET, "GET", locals, { csrf: false });
		expect(res.status).toBe(403);
		expect(handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("allows an admin with the CSRF header (GET)", async () => {
		const { locals, handlePluginApiRoute } = createLocals(Role.ADMIN, false);
		const res = await invoke(GET, "GET", locals);
		expect(res.status).toBe(200);
		expect(handlePluginApiRoute).toHaveBeenCalledOnce();
	});

	it("allows an admin with the CSRF header (POST)", async () => {
		const { locals, handlePluginApiRoute } = createLocals(Role.ADMIN, false);
		const res = await invoke(POST, "POST", locals);
		expect(res.status).toBe(200);
		expect(handlePluginApiRoute).toHaveBeenCalledOnce();
	});

	it("leaves public routes reachable without auth or CSRF", async () => {
		const { locals, handlePluginApiRoute } = createLocals(null, true);
		const res = await invoke(GET, "GET", locals, { csrf: false });
		expect(res.status).toBe(200);
		expect(handlePluginApiRoute).toHaveBeenCalledOnce();
	});
});
