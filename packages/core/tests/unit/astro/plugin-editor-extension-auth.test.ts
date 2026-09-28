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
			_rev: "rev-7",
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
				capabilities: [],
			}),
			getPluginEditorDraftSchema: vi.fn(async () => ({
				id: "collection-posts",
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
				fields: [
					{
						id: "field-title",
						collectionId: "collection-posts",
						slug: "title",
						label: "Title",
						type: "string",
						columnType: "TEXT",
						required: true,
						unique: false,
						sortOrder: 0,
						searchable: false,
						indexed: false,
						translatable: true,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
			})),
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

	it("bounds the decoded interaction body before sandbox invocation", async () => {
		const locals = createLocals(Role.AUTHOR);
		const response = await invoke(locals, { type: "panel_load" }, { contentLength: "300000" });
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "EDITOR_DRAFT_TOO_LARGE" },
		});
		expect(locals.handlePluginApiRoute).not.toHaveBeenCalled();
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

	it("forwards a server-sanitized explicit draft and host-attests the patch receipt", async () => {
		const locals = createLocals(Role.AUTHOR);
		locals.emdash.getPluginEditorExtension = () => ({
			kind: "panel" as const,
			extension: {
				id: "health",
				title: "Health",
				route: "entry-health",
				collections: ["posts"],
				draft: { read: { translatable: true as const }, patch: { fields: ["title"] } },
			},
			policy: {},
			capabilities: ["admin.editor-draft:read", "admin.editor-draft:patch"] as const,
		});
		locals.handlePluginApiRoute.mockResolvedValueOnce({
			success: true,
			data: {
				blocks: [],
				patch: {
					type: "editor-draft-patch",
					operations: [{ op: "set", field: "title", value: "Translated" }],
				},
			},
		});
		const response = await invoke(locals, {
			type: "block_action",
			action_id: "translate",
			draft: {
				collection: "posts",
				entryId: "entry-1",
				locale: "en",
				baseRevision: "rev-7",
				generation: 12,
				invocationId: "invocation_123456",
				fields: { title: "Unsaved" },
			},
		});
		expect(response.status).toBe(200);
		const pluginRequest = locals.handlePluginApiRoute.mock.calls[0]?.[3];
		await expect(pluginRequest?.json()).resolves.toMatchObject({
			type: "block_action",
			draft: {
				fields: { title: "Unsaved" },
				fieldDefinitions: [
					expect.objectContaining({ slug: "title", label: "Title", type: "string" }),
				],
			},
		});
		await expect(response.json()).resolves.toMatchObject({
			data: {
				patch: { operations: [{ field: "title", value: "Translated" }] },
				editorInvocation: {
					entryId: "entry-1",
					baseRevision: "rev-7",
					generation: 12,
					invocationId: "invocation_123456",
				},
			},
		});
	});
});
