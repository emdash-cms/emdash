/**
 * Redirect write routes must purge the cached source path so a stale page is
 * not served after a redirect is created, updated or deleted.
 */

import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRedirectCreate } from "../../../src/api/handlers/redirects.js";
import {
	DELETE as deleteRedirect,
	PUT as updateRedirect,
} from "../../../src/astro/routes/api/redirects/[id].js";
import { POST as createRedirectList } from "../../../src/astro/routes/api/redirects/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Redirect write routes — edge cache invalidation", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabase>>;

	const admin = { id: "user-1", role: Role.ADMIN };

	function makeContext<const P extends Record<string, string>>(params: P) {
		const invalidate = vi.fn().mockResolvedValue(undefined);
		return {
			locals: { emdash: { db, storage: null }, user: admin },
			params,
			cache: { enabled: true, invalidate },
			invalidate,
		};
	}

	function makeFailingContext<const P extends Record<string, string>>(params: P) {
		const invalidate = vi.fn().mockRejectedValue(new Error("purge failed"));
		return {
			locals: { emdash: { db, storage: null }, user: admin },
			params,
			cache: { enabled: true, invalidate },
			invalidate,
		};
	}

	function makeRequest(method: string, body: unknown, url = "http://localhost/") {
		return new Request(url, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("create", () => {
		it("invalidates the source path with and without a trailing slash", async () => {
			const { cache, invalidate } = makeContext({});
			const request = makeRequest("POST", {
				source: "/posts/notes-on-simplicity",
				destination: "/posts",
				type: 301,
			});

			const response = await createRedirectList({
				request,
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof createRedirectList>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledTimes(2);
			expect(invalidate).toHaveBeenCalledWith({ path: "/posts/notes-on-simplicity" });
			expect(invalidate).toHaveBeenCalledWith({ path: "/posts/notes-on-simplicity/" });
		});

		it("returns success when the cache purge fails", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { cache, invalidate } = makeFailingContext({});
			const request = makeRequest("POST", {
				source: "/posts/notes-on-simplicity",
				destination: "/posts",
				type: 301,
			});

			const response = await createRedirectList({
				request,
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof createRedirectList>[0]);

			expect(response.status).toBe(201);
			expect(invalidate).toHaveBeenCalledTimes(2);
			expect(errorSpy).toHaveBeenCalledTimes(2);
			errorSpy.mockRestore();
		});
	});

	describe("update", () => {
		it("invalidates the old and new source paths when the source changes", async () => {
			const created = await handleRedirectCreate(db, {
				source: "/old-source",
				destination: "/target",
				type: 301,
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const { cache, invalidate } = makeContext({ id: created.data.id });
			const request = makeRequest("PUT", {
				source: "/new-source",
				destination: "/target",
			});

			const response = await updateRedirect({
				request,
				params: { id: created.data.id },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof updateRedirect>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledTimes(4);
			expect(invalidate).toHaveBeenCalledWith({ path: "/old-source" });
			expect(invalidate).toHaveBeenCalledWith({ path: "/old-source/" });
			expect(invalidate).toHaveBeenCalledWith({ path: "/new-source" });
			expect(invalidate).toHaveBeenCalledWith({ path: "/new-source/" });
		});

		it("invalidates only the source path when only the destination changes", async () => {
			const created = await handleRedirectCreate(db, {
				source: "/source-path",
				destination: "/old-target",
				type: 301,
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const { cache, invalidate } = makeContext({ id: created.data.id });
			const request = makeRequest("PUT", { destination: "/new-target" });

			const response = await updateRedirect({
				request,
				params: { id: created.data.id },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof updateRedirect>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledTimes(2);
			expect(invalidate).toHaveBeenCalledWith({ path: "/source-path" });
			expect(invalidate).toHaveBeenCalledWith({ path: "/source-path/" });
		});

		it("returns success when the cache purge fails", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const created = await handleRedirectCreate(db, {
				source: "/source-path",
				destination: "/old-target",
				type: 301,
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const { cache, invalidate } = makeFailingContext({ id: created.data.id });
			const request = makeRequest("PUT", { destination: "/new-target" });

			const response = await updateRedirect({
				request,
				params: { id: created.data.id },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof updateRedirect>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledTimes(2);
			expect(errorSpy).toHaveBeenCalledTimes(2);
			errorSpy.mockRestore();
		});
	});

	describe("delete", () => {
		it("invalidates the source path of the deleted redirect", async () => {
			const created = await handleRedirectCreate(db, {
				source: "/to-delete",
				destination: "/target",
				type: 301,
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const { cache, invalidate } = makeContext({ id: created.data.id });
			const request = makeRequest("DELETE", {});

			const response = await deleteRedirect({
				request,
				params: { id: created.data.id },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteRedirect>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledTimes(2);
			expect(invalidate).toHaveBeenCalledWith({ path: "/to-delete" });
			expect(invalidate).toHaveBeenCalledWith({ path: "/to-delete/" });
		});

		it("returns success when the cache purge fails", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const created = await handleRedirectCreate(db, {
				source: "/to-delete",
				destination: "/target",
				type: 301,
			});
			expect(created.success).toBe(true);
			if (!created.success) return;

			const { cache, invalidate } = makeFailingContext({ id: created.data.id });
			const request = makeRequest("DELETE", {});

			const response = await deleteRedirect({
				request,
				params: { id: created.data.id },
				url: new URL(request.url),
				locals: { emdash: { db, storage: null }, user: admin },
				cache,
			} as Parameters<typeof deleteRedirect>[0]);

			expect(response.status).toBe(200);
			expect(invalidate).toHaveBeenCalledTimes(2);
			expect(errorSpy).toHaveBeenCalledTimes(2);
			errorSpy.mockRestore();
		});
	});
});
