import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listMedia } from "../../../src/astro/routes/api/media.js";
import { PUT as updateMedia } from "../../../src/astro/routes/api/media/[id].js";
import {
	DELETE as deleteFolder,
	GET as getFolder,
	PUT as updateFolder,
} from "../../../src/astro/routes/api/media/folders/[id].js";
import {
	GET as listFolders,
	POST as createFolder,
} from "../../../src/astro/routes/api/media/folders/index.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import {
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describe("media folder routes", () => {
	let ctx: DialectTestContext;
	const user = (role: (typeof Role)[keyof typeof Role], id = "user-1") => ({ id, role });

	beforeEach(async () => {
		ctx = await setupForDialect("sqlite");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function routeContext(
		request: Request,
		role: (typeof Role)[keyof typeof Role],
		params: Record<string, string> = {},
	) {
		return {
			params,
			request,
			locals: { emdash: { db: ctx.db }, user: user(role) },
		} as Parameters<typeof listFolders>[0];
	}

	it("allows media readers to list folders but requires edit-any to create them", async () => {
		await new MediaFolderRepository(ctx.db).create("Existing");
		const listRequest = new Request("http://localhost/_emdash/api/media/folders");
		const listResponse = await listFolders(routeContext(listRequest, Role.SUBSCRIBER));
		expect(listResponse.status).toBe(200);
		await expect(listResponse.json()).resolves.toMatchObject({
			data: { items: [{ name: "Existing" }] },
		});
		const invalidList = await listFolders(
			routeContext(
				new Request("http://localhost/_emdash/api/media/folders?limit=101"),
				Role.SUBSCRIBER,
			),
		);
		expect(invalidList.status).toBe(400);
		const emptyCursor = await listFolders(
			routeContext(
				new Request("http://localhost/_emdash/api/media/folders?cursor="),
				Role.SUBSCRIBER,
			),
		);
		expect(emptyCursor.status).toBe(400);

		const authorRequest = new Request("http://localhost/_emdash/api/media/folders", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ name: "Author folder" }),
		});
		expect(await createFolder(routeContext(authorRequest, Role.AUTHOR))).toMatchObject({
			status: 403,
		});

		const editorRequest = new Request("http://localhost/_emdash/api/media/folders", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ name: "  Editor folder  " }),
		});
		const editorResponse = await createFolder(routeContext(editorRequest, Role.EDITOR));
		expect(editorResponse.status).toBe(201);
		await expect(editorResponse.json()).resolves.toMatchObject({
			data: { item: { name: "Editor folder" } },
		});
	});

	it("requires edit-any for rename and delete and validates folder IDs", async () => {
		const folder = await new MediaFolderRepository(ctx.db).create("Drafts");
		const authorRequest = new Request(`http://localhost/_emdash/api/media/folders/${folder.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ name: "Published" }),
		});
		expect(
			await updateFolder(
				routeContext(authorRequest, Role.AUTHOR, { id: folder.id }) as Parameters<
					typeof updateFolder
				>[0],
			),
		).toMatchObject({ status: 403 });

		const editorRequest = new Request(`http://localhost/_emdash/api/media/folders/${folder.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ name: "Published" }),
		});
		const updated = await updateFolder(
			routeContext(editorRequest, Role.EDITOR, { id: folder.id }) as Parameters<
				typeof updateFolder
			>[0],
		);
		expect(updated.status).toBe(200);

		const invalidId = "x".repeat(65);
		const invalidRequest = new Request(`http://localhost/_emdash/api/media/folders/${invalidId}`, {
			method: "DELETE",
			headers: { "X-EmDash-Request": "1" },
		});
		expect(
			await deleteFolder(
				routeContext(invalidRequest, Role.EDITOR, { id: invalidId }) as Parameters<
					typeof deleteFolder
				>[0],
			),
		).toMatchObject({ status: 400 });

		const deleteRequest = new Request(`http://localhost/_emdash/api/media/folders/${folder.id}`, {
			method: "DELETE",
			headers: { "X-EmDash-Request": "1" },
		});
		expect(
			await deleteFolder(
				routeContext(deleteRequest, Role.AUTHOR, { id: folder.id }) as Parameters<
					typeof deleteFolder
				>[0],
			),
		).toMatchObject({ status: 403 });

		const editorDeleteRequest = new Request(
			`http://localhost/_emdash/api/media/folders/${folder.id}`,
			{ method: "DELETE", headers: { "X-EmDash-Request": "1" } },
		);
		expect(
			await deleteFolder(
				routeContext(editorDeleteRequest, Role.EDITOR, { id: folder.id }) as Parameters<
					typeof deleteFolder
				>[0],
			),
		).toMatchObject({ status: 200 });
	});

	it("allows readers to get one folder and validates direct folder IDs", async () => {
		const folder = await new MediaFolderRepository(ctx.db).create("Direct");
		const request = new Request(`http://localhost/_emdash/api/media/folders/${folder.id}`);

		const response = await getFolder(
			routeContext(request, Role.SUBSCRIBER, { id: folder.id }) as Parameters<typeof getFolder>[0],
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ data: { item: folder } });

		const missing = await getFolder(
			routeContext(request, Role.SUBSCRIBER, { id: "missing-folder" }) as Parameters<
				typeof getFolder
			>[0],
		);
		expect(missing.status).toBe(404);

		const invalidId = "x".repeat(65);
		const invalid = await getFolder(
			routeContext(request, Role.SUBSCRIBER, { id: invalidId }) as Parameters<typeof getFolder>[0],
		);
		expect(invalid.status).toBe(400);
	});

	it("maps unfiled list requests to Main library", async () => {
		const handleMediaList = vi.fn().mockResolvedValue({ success: true, data: { items: [] } });
		const request = new Request("http://localhost/_emdash/api/media?folderId=unfiled");

		const response = await listMedia({
			request,
			locals: { emdash: { handleMediaList }, user: user(Role.SUBSCRIBER) },
		} as Parameters<typeof listMedia>[0]);

		expect(response.status).toBe(200);
		expect(handleMediaList).toHaveBeenCalledWith(expect.objectContaining({ folderId: null }));
	});

	it("maps unfiled update requests to Main library", async () => {
		const handleMediaGet = vi.fn().mockResolvedValue({
			success: true,
			data: { item: { id: "media-1", authorId: "author-1" } },
		});
		const handleMediaUpdate = vi.fn().mockResolvedValue({
			success: true,
			data: { item: { id: "media-1", folderId: null } },
		});
		const request = new Request("http://localhost/_emdash/api/media/media-1", {
			method: "PUT",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ folderId: "unfiled" }),
		});

		const response = await updateMedia({
			params: { id: "media-1" },
			request,
			locals: {
				emdash: { handleMediaGet, handleMediaUpdate },
				user: user(Role.EDITOR),
			},
		} as Parameters<typeof updateMedia>[0]);

		expect(response.status).toBe(200);
		expect(handleMediaUpdate).toHaveBeenCalledWith(
			"media-1",
			expect.objectContaining({ folderId: null }),
		);
	});

	it("preserves ownership checks when assigning a folder to media", async () => {
		const handleMediaGet = vi.fn().mockResolvedValue({
			success: true,
			data: { item: { id: "media-1", authorId: "author-1" } },
		});
		const handleMediaUpdate = vi.fn().mockResolvedValue({
			success: true,
			data: { item: { id: "media-1", folderId: "folder-1" } },
		});
		const makeRequest = () =>
			new Request("http://localhost/_emdash/api/media/media-1", {
				method: "PUT",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({ folderId: "folder-1" }),
			});

		const ownResponse = await updateMedia({
			params: { id: "media-1" },
			request: makeRequest(),
			locals: {
				emdash: { handleMediaGet, handleMediaUpdate },
				user: user(Role.AUTHOR, "author-1"),
			},
		} as Parameters<typeof updateMedia>[0]);
		expect(ownResponse.status).toBe(200);
		expect(handleMediaUpdate).toHaveBeenCalledWith(
			"media-1",
			expect.objectContaining({ folderId: "folder-1" }),
		);

		handleMediaUpdate.mockClear();
		const otherResponse = await updateMedia({
			params: { id: "media-1" },
			request: makeRequest(),
			locals: {
				emdash: { handleMediaGet, handleMediaUpdate },
				user: user(Role.AUTHOR, "author-2"),
			},
		} as Parameters<typeof updateMedia>[0]);
		expect(otherResponse.status).toBe(403);
		expect(handleMediaUpdate).not.toHaveBeenCalled();
	});
});
