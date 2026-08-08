/**
 * Object-cache purge route: registration and authorization.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import {
	GET as statusGet,
	POST as purgePost,
} from "../../../src/astro/routes/api/admin/cache/object.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("object-cache purge route registration", () => {
	it("registers /_emdash/api/admin/cache/object", () => {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);
		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
		expect(patterns).toContain("/_emdash/api/admin/cache/object");
	});
});

describe("object-cache purge route", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	const makePostContext = (user: { id: string; role: number } | null, body?: unknown) =>
		({
			request: new Request("http://localhost/_emdash/api/admin/cache/object", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify(body ?? {}),
			}),
			locals: {
				emdash: { db },
				user,
			},
		}) as unknown as Parameters<typeof purgePost>[0];

	const makeGetContext = (user: { id: string; role: number } | null) =>
		({
			request: new Request("http://localhost/_emdash/api/admin/cache/object"),
			locals: {
				emdash: { db },
				user,
			},
		}) as unknown as Parameters<typeof statusGet>[0];

	it("GET returns 401 for anonymous users", async () => {
		const response = await statusGet(makeGetContext(null));
		expect(response.status).toBe(401);
	});

	it("GET returns configured status for admins", async () => {
		const response = await statusGet(makeGetContext({ id: "u1", role: Role.ADMIN }));
		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			success: boolean;
			data: { configured: boolean };
		};
		expect(json.success).toBe(true);
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

	it("POST purges for admins", async () => {
		const response = await purgePost(
			makePostContext({ id: "u1", role: Role.ADMIN }, { namespaces: ["menus"] }),
		);
		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			success: boolean;
			data: { configured: boolean; purged: string[] };
		};
		expect(json.success).toBe(true);
		expect(json.data.purged).toEqual(["menus"]);
	});
});
