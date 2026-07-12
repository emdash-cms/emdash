/**
 * Admin navigation route tests
 *
 * - Route registration for /_emdash/api/admin/navigation
 * - Authorization: GET and PUT require the admin-only settings:manage
 *   permission
 * - Round-trip through the real handlers with a real database
 */

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET as navGet, PUT as navPut } from "../../../src/astro/routes/api/admin/navigation.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Minimal APIContext stand-in; the route only touches locals/request.
// eslint-disable-next-line typescript/no-explicit-any -- test double for APIContext
function ctx(overrides: Record<string, unknown>): any {
	return {
		locals: { emdash: { db: {} }, user: null },
		params: {},
		request: new Request("https://example.com/_emdash/api/admin/navigation"),
		...overrides,
	};
}

function putRequest(body: unknown): Request {
	return new Request("https://example.com/_emdash/api/admin/navigation", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("admin navigation route registration", () => {
	it("registers the navigation route", () => {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);

		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
		expect(patterns).toContain("/_emdash/api/admin/navigation");
	});
});

describe("admin navigation route authorization", () => {
	const cases: [string, (c: unknown) => Promise<Response>][] = [
		["GET /admin/navigation", (c) => navGet(c as never)],
		["PUT /admin/navigation", (c) => navPut(c as never)],
	];

	for (const [label, invoke] of cases) {
		it(`${label} rejects anonymous requests`, async () => {
			const res = await invoke(ctx({}));
			expect(res.status).toBe(401);
		});

		it(`${label} rejects editors (below admin)`, async () => {
			const res = await invoke(
				ctx({ locals: { emdash: { db: {} }, user: { id: "u1", role: 40 } } }),
			);
			expect(res.status).toBe(403);
		});
	}
});

describe("admin navigation route round-trip", () => {
	let db: Kysely<Database>;
	const adminLocals = () => ({ emdash: { db }, user: { id: "admin1", role: 50 } });

	beforeAll(async () => {
		db = await setupTestDatabase();
	});

	afterAll(async () => {
		await teardownTestDatabase(db);
	});

	it("GET returns null config before any save", async () => {
		const res = await navGet(ctx({ locals: adminLocals() }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { config: unknown } };
		expect(body.data.config).toBeNull();
	});

	it("PUT stores the config and GET returns it", async () => {
		const config = {
			version: 1,
			groups: [{ id: "editorial", label: "Editorial", order: 0 }],
			items: [{ id: "collection:posts", groupId: "editorial", order: 0 }],
		};

		const putRes = await navPut(ctx({ locals: adminLocals(), request: putRequest(config) }));
		expect(putRes.status).toBe(200);
		const putBody = (await putRes.json()) as { data: { config: unknown } };
		expect(putBody.data.config).toEqual(config);

		const getRes = await navGet(ctx({ locals: adminLocals() }));
		expect(getRes.status).toBe(200);
		const getBody = (await getRes.json()) as { data: { config: unknown } };
		expect(getBody.data.config).toEqual(config);
	});

	it("PUT rejects a schema-invalid body with 400", async () => {
		const res = await navPut(
			ctx({
				locals: adminLocals(),
				request: putRequest({
					version: 1,
					groups: [{ id: "Bad Id", label: "x", order: 0 }],
					items: [],
				}),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("PUT rejects a non-JSON body with 400", async () => {
		const res = await navPut(
			ctx({
				locals: adminLocals(),
				request: new Request("https://example.com/_emdash/api/admin/navigation", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: "{not json",
				}),
			}),
		);
		expect(res.status).toBe(400);
	});
});
