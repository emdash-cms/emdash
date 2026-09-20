import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { describe, expect, it, vi } from "vitest";

import { POST } from "../../../src/astro/routes/api/content/[collection]/[id]/plugin-extensions/[pluginId]/[kind]/[extensionId].js";

function createLocals(
	role: RoleLevel | null,
	userId = "owner",
	routePublic = false,
	permission = "content:edit_own",
) {
	const handlePluginApiRoute = vi.fn(async () => ({ success: true, data: { blocks: [] } }));
	const handleContentGet = vi.fn(async () => ({
		success: true,
		data: {
			item: { id: "entry-1", authorId: "owner", locale: "en", version: 7 },
		},
	}));
	const cacheInvalidate = vi.fn(async () => undefined);
	return {
		user: role === null ? null : { id: userId, role },
		emdash: {
			getPluginEditorExtension: () => ({
				kind: "panel",
				extension: { id: "health", title: "Health", route: "entry-health" },
				policy: {},
			}),
			getPluginRouteMeta: () => ({ public: routePublic, permission }),
			handleContentGet,
			handlePluginApiRoute,
		},
		handleContentGet,
		handlePluginApiRoute,
		cacheInvalidate,
	};
}

function invoke(
	locals: ReturnType<typeof createLocals>,
	body: unknown = { type: "panel_load" },
	options: {
		csrf?: boolean;
		kind?: "panel" | "action";
		contentLength?: string;
		contentEncoding?: string;
	} = {},
) {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (options.csrf !== false) headers.set("X-EmDash-Request", "1");
	if (options.contentLength) headers.set("Content-Length", options.contentLength);
	if (options.contentEncoding) headers.set("Content-Encoding", options.contentEncoding);
	return (POST as APIRoute)({
		params: {
			collection: "posts",
			id: "entry-1",
			pluginId: "content-guard",
			kind: options.kind ?? "panel",
			extensionId: "health",
		},
		request: new Request(
			"https://example.test/_emdash/api/content/posts/entry-1/plugin-extensions/content-guard/panel/health?locale=en",
			{ method: "POST", headers, body: JSON.stringify(body) },
		),
		locals,
		cache: { enabled: true, invalidate: locals.cacheInvalidate },
	} as never);
}

describe("saved-entry plugin extension authorization", () => {
	it("re-fetches the entry and passes only canonical identity to the plugin", async () => {
		const locals = createLocals(Role.AUTHOR);
		const response = await invoke(locals);
		expect(response.status).toBe(200);
		expect(locals.handleContentGet).toHaveBeenCalledWith("posts", "entry-1", "en");
		expect(locals.handlePluginApiRoute).toHaveBeenCalledWith(
			"content-guard",
			"POST",
			"entry-health",
			expect.any(Request),
			expect.objectContaining({ id: "owner" }),
			expect.any(Function),
			expect.objectContaining({
				kind: "panel",
				ui: expect.objectContaining({
					surface: "content-editor-panel",
					extensionId: "health",
					entry: { collection: "posts", id: "entry-1", locale: "en", version: 7 },
				}),
			}),
		);
		const invalidateContentCache = locals.handlePluginApiRoute.mock.calls[0]?.[5];
		await invalidateContentCache?.(["content:posts:entry-1"]);
		expect(locals.cacheInvalidate).toHaveBeenCalledWith({ tags: ["content:posts:entry-1"] });
		const pluginRequest = locals.handlePluginApiRoute.mock.calls[0]?.[3];
		await expect(pluginRequest?.json()).resolves.toEqual({ type: "panel_load" });
	});

	it("denies another author before plugin invocation", async () => {
		const locals = createLocals(Role.AUTHOR, "other-author");
		const response = await invoke(locals);
		expect(response.status).toBe(403);
		expect(locals.handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("rejects unauthenticated requests before loading content", async () => {
		const locals = createLocals(null);
		expect((await invoke(locals)).status).toBe(401);
		expect(locals.handleContentGet).not.toHaveBeenCalled();
		expect(locals.handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("retains CSRF and private-route enforcement", async () => {
		const missingCsrf = createLocals(Role.AUTHOR);
		expect((await invoke(missingCsrf, undefined, { csrf: false })).status).toBe(403);
		expect(missingCsrf.handleContentGet).not.toHaveBeenCalled();
		expect(missingCsrf.handlePluginApiRoute).not.toHaveBeenCalled();

		const publicRoute = createLocals(Role.AUTHOR, "owner", true);
		expect((await invoke(publicRoute)).status).toBe(500);
		expect(publicRoute.handleContentGet).not.toHaveBeenCalled();
		expect(publicRoute.handlePluginApiRoute).not.toHaveBeenCalled();

		const strongerPermission = createLocals(Role.AUTHOR, "owner", false, "plugins:manage");
		expect((await invoke(strongerPermission)).status).toBe(403);
		expect(strongerPermission.handleContentGet).not.toHaveBeenCalled();
		expect(strongerPermission.handlePluginApiRoute).not.toHaveBeenCalled();

		const inheritedPermission = createLocals(Role.ADMIN, "owner", false, "toString");
		expect((await invoke(inheritedPermission)).status).toBe(500);
		expect(inheritedPermission.handleContentGet).not.toHaveBeenCalled();
		expect(inheritedPermission.handlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("rejects forged host context fields and creates action input itself", async () => {
		const forged = createLocals(Role.AUTHOR);
		expect((await invoke(forged, { type: "panel_load", entry: { id: "other" } })).status).toBe(400);
		expect(forged.handlePluginApiRoute).not.toHaveBeenCalled();

		const action = createLocals(Role.AUTHOR);
		expect(
			(
				await invoke(
					action,
					{ entry: { id: "other" } },
					{
						kind: "action",
						contentLength: "4096",
						contentEncoding: "gzip",
					},
				)
			).status,
		).toBe(200);
		const pluginRequest = action.handlePluginApiRoute.mock.calls[0]?.[3];
		expect(pluginRequest?.headers.get("content-length")).toBeNull();
		expect(pluginRequest?.headers.get("content-encoding")).toBeNull();
		await expect(pluginRequest?.json()).resolves.toEqual({ type: "editor_action" });
	});
});
