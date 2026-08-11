/**
 * Workers Cache admin route: registration and authorization.
 */

import { Role } from "@emdash-cms/auth";
import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import {
	GET as statusGet,
	POST as purgePost,
} from "../../../src/astro/routes/api/admin/cache/workers.js";

describe("workers-cache purge route registration", () => {
	it("registers /_emdash/api/admin/cache/workers", () => {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);
		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
		expect(patterns).toContain("/_emdash/api/admin/cache/workers");
	});
});

describe("workers-cache purge route", () => {
	const makeContext = (user: { id: string; role: number } | null) =>
		({
			request: new Request("http://localhost/_emdash/api/admin/cache/workers", {
				method: "GET",
				headers: { "X-EmDash-Request": "1" },
			}),
			locals: {
				user,
			},
		}) as unknown as Parameters<typeof statusGet>[0];

	const makePostContext = (user: { id: string; role: number } | null) =>
		({
			request: new Request("http://localhost/_emdash/api/admin/cache/workers", {
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
			}),
			locals: {
				user,
			},
		}) as unknown as Parameters<typeof purgePost>[0];

	it("GET returns 401 for anonymous users", async () => {
		const response = await statusGet(makeContext(null));
		expect(response.status).toBe(401);
	});

	it("GET returns configured status for admins", async () => {
		const response = await statusGet(makeContext({ id: "u1", role: Role.ADMIN }));
		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			success: boolean;
			data: { configured: boolean };
		};
		expect(json.success).toBe(true);
		// Unit tests run outside Workers — native purge unavailable
		expect(json.data.configured).toBe(false);
	});

	it("POST returns 401 for anonymous users", async () => {
		const response = await purgePost(makePostContext(null));
		expect(response.status).toBe(401);
	});

	it("POST returns 403 for editors (settings:manage is admin-only)", async () => {
		const response = await purgePost(makePostContext({ id: "u1", role: Role.EDITOR }));
		expect(response.status).toBe(403);
	});

	it("POST returns configured:false for admins outside Workers", async () => {
		const response = await purgePost(makePostContext({ id: "u1", role: Role.ADMIN }));
		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			success: boolean;
			data: { configured: boolean; purged: boolean };
		};
		expect(json.success).toBe(true);
		expect(json.data).toEqual({ configured: false, purged: false });
	});
});
