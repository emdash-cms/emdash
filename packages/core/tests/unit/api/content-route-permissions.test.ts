import { Role } from "@emdash-cms/auth";
import { describe, it, expect, vi } from "vitest";

import { PUT as updateContent } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { POST as createContent } from "../../../src/astro/routes/api/content/[collection]/index.js";

/**
 * Regression tests for the `publishedAt` / `createdAt` permission gate.
 *
 * The gate must trigger on *any* explicit presence of these fields —
 * including `null` (explicit clear) — not just on non-null values. Checking
 * only `!= null` would let a regular AUTHOR clear `published_at` on any item
 * they can edit, bypassing `content:publish_any`.
 */
describe("content route — publishedAt / createdAt permission gate", () => {
	const makeUser = (role: (typeof Role)[keyof typeof Role]) => ({
		id: "user-1",
		role,
	});

	const makeCache = () => ({ enabled: false, invalidate: vi.fn() });

	describe("POST /_emdash/api/content/{collection}", () => {
		it("returns 403 when an AUTHOR tries to set publishedAt", async () => {
			const request = new Request("http://localhost/_emdash/api/content/post", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					data: { title: "Hi" },
					publishedAt: "2019-03-15T10:30:00.000Z",
				}),
			});

			const response = await createContent({
				params: { collection: "post" },
				request,
				locals: {
					emdash: {
						handleContentCreate: vi.fn(),
						handleContentGet: vi.fn(),
					},
					user: makeUser(Role.AUTHOR),
				},
				cache: makeCache(),
			} as Parameters<typeof createContent>[0]);

			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toMatchObject({
				error: { code: "FORBIDDEN" },
			});
		});

		it("returns 403 when an AUTHOR tries to clear publishedAt via null", async () => {
			const request = new Request("http://localhost/_emdash/api/content/post", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Hi" }, publishedAt: null }),
			});

			const response = await createContent({
				params: { collection: "post" },
				request,
				locals: {
					emdash: {
						handleContentCreate: vi.fn(),
						handleContentGet: vi.fn(),
					},
					user: makeUser(Role.AUTHOR),
				},
				cache: makeCache(),
			} as Parameters<typeof createContent>[0]);

			expect(response.status).toBe(403);
		});

		it("returns 403 when an AUTHOR tries to set createdAt", async () => {
			const request = new Request("http://localhost/_emdash/api/content/post", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					data: { title: "Hi" },
					createdAt: "2019-03-15T10:30:00.000Z",
				}),
			});

			const response = await createContent({
				params: { collection: "post" },
				request,
				locals: {
					emdash: {
						handleContentCreate: vi.fn(),
						handleContentGet: vi.fn(),
					},
					user: makeUser(Role.AUTHOR),
				},
				cache: makeCache(),
			} as Parameters<typeof createContent>[0]);

			expect(response.status).toBe(403);
		});

		it("lets EDITOR set publishedAt", async () => {
			const handleContentCreate = vi.fn().mockResolvedValue({
				success: true,
				data: {
					item: { id: "c1", publishedAt: "2019-03-15T10:30:00.000Z" },
					_rev: "rev1",
				},
			});

			const request = new Request("http://localhost/_emdash/api/content/post", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					data: { title: "Hi" },
					publishedAt: "2019-03-15T10:30:00.000Z",
				}),
			});

			const response = await createContent({
				params: { collection: "post" },
				request,
				locals: {
					emdash: { handleContentCreate, handleContentGet: vi.fn() },
					user: makeUser(Role.EDITOR),
				},
				cache: makeCache(),
			} as Parameters<typeof createContent>[0]);

			expect(response.status).toBe(201);
			expect(handleContentCreate).toHaveBeenCalledWith(
				"post",
				expect.objectContaining({ publishedAt: "2019-03-15T10:30:00.000Z" }),
			);
		});

		it("lets AUTHOR create without date overrides", async () => {
			const handleContentCreate = vi.fn().mockResolvedValue({
				success: true,
				data: { item: { id: "c1" }, _rev: "rev1" },
			});

			const request = new Request("http://localhost/_emdash/api/content/post", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Hi" } }),
			});

			const response = await createContent({
				params: { collection: "post" },
				request,
				locals: {
					emdash: { handleContentCreate, handleContentGet: vi.fn() },
					user: makeUser(Role.AUTHOR),
				},
				cache: makeCache(),
			} as Parameters<typeof createContent>[0]);

			expect(response.status).toBe(201);
			expect(handleContentCreate).toHaveBeenCalled();
		});
	});

	describe("PUT /_emdash/api/content/{collection}/{id}", () => {
		const ownedItem = {
			success: true,
			data: { item: { id: "c1", authorId: "user-1" }, _rev: "rev1" },
		};

		it("returns 403 when an AUTHOR tries to clear publishedAt via null on their own post", async () => {
			const handleContentGet = vi.fn().mockResolvedValue(ownedItem);
			const handleContentUpdate = vi.fn();

			const request = new Request("http://localhost/_emdash/api/content/post/c1", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publishedAt: null }),
			});

			const response = await updateContent({
				params: { collection: "post", id: "c1" },
				request,
				locals: {
					emdash: { handleContentUpdate, handleContentGet },
					user: makeUser(Role.AUTHOR),
				},
				cache: makeCache(),
			} as Parameters<typeof updateContent>[0]);

			expect(response.status).toBe(403);
			expect(handleContentUpdate).not.toHaveBeenCalled();
		});

		it("returns 403 when an AUTHOR tries to set publishedAt on their own post", async () => {
			const handleContentGet = vi.fn().mockResolvedValue(ownedItem);
			const handleContentUpdate = vi.fn();

			const request = new Request("http://localhost/_emdash/api/content/post/c1", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publishedAt: "2019-03-15T10:30:00.000Z" }),
			});

			const response = await updateContent({
				params: { collection: "post", id: "c1" },
				request,
				locals: {
					emdash: { handleContentUpdate, handleContentGet },
					user: makeUser(Role.AUTHOR),
				},
				cache: makeCache(),
			} as Parameters<typeof updateContent>[0]);

			expect(response.status).toBe(403);
			expect(handleContentUpdate).not.toHaveBeenCalled();
		});

		it("lets EDITOR set publishedAt", async () => {
			const handleContentGet = vi.fn().mockResolvedValue(ownedItem);
			const handleContentUpdate = vi.fn().mockResolvedValue({
				success: true,
				data: {
					item: { id: "c1", publishedAt: "2019-03-15T10:30:00.000Z" },
					_rev: "rev2",
				},
			});

			const request = new Request("http://localhost/_emdash/api/content/post/c1", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publishedAt: "2019-03-15T10:30:00.000Z" }),
			});

			const response = await updateContent({
				params: { collection: "post", id: "c1" },
				request,
				locals: {
					emdash: { handleContentUpdate, handleContentGet },
					user: makeUser(Role.EDITOR),
				},
				cache: makeCache(),
			} as Parameters<typeof updateContent>[0]);

			expect(response.status).toBe(200);
			expect(handleContentUpdate).toHaveBeenCalledWith(
				"post",
				"c1",
				expect.objectContaining({ publishedAt: "2019-03-15T10:30:00.000Z" }),
			);
		});

		it("lets AUTHOR update their own post without date overrides", async () => {
			const handleContentGet = vi.fn().mockResolvedValue(ownedItem);
			const handleContentUpdate = vi.fn().mockResolvedValue({
				success: true,
				data: { item: { id: "c1" }, _rev: "rev2" },
			});

			const request = new Request("http://localhost/_emdash/api/content/post/c1", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Edited" } }),
			});

			const response = await updateContent({
				params: { collection: "post", id: "c1" },
				request,
				locals: {
					emdash: { handleContentUpdate, handleContentGet },
					user: makeUser(Role.AUTHOR),
				},
				cache: makeCache(),
			} as Parameters<typeof updateContent>[0]);

			expect(response.status).toBe(200);
			expect(handleContentUpdate).toHaveBeenCalled();
		});
	});
});
