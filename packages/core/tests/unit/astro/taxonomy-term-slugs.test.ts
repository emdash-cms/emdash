import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DELETE, GET, PUT } from "../../../src/astro/routes/api/taxonomies/[name]/terms/[slug].js";
import {
	GET as getTranslations,
	POST as postTranslation,
} from "../../../src/astro/routes/api/taxonomies/[name]/terms/[slug]/translations.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("invalid taxonomy term URL slugs", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabase>>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it.each([
		{ method: "GET", route: GET, suffix: "" },
		{ method: "PUT", route: PUT, suffix: "" },
		{ method: "DELETE", route: DELETE, suffix: "" },
		{ method: "GET", route: getTranslations, suffix: "/translations" },
		{ method: "POST", route: postTranslation, suffix: "/translations" },
	] as const)(
		"checks permission and validates malformed slugs for $method $suffix",
		async ({ method, route, suffix }) => {
			const request = new Request(
				`http://localhost/_emdash/api/taxonomies/category/terms/%E0%A4%A${suffix}`,
				{ method },
			);
			const context = {
				request,
				params: { name: "category", slug: "%E0%A4%A" },
				locals: { emdash: { db }, user: { id: "admin", role: Role.ADMIN } },
			} as Parameters<typeof GET>[0];

			const denied = await route({ ...context, locals: { ...context.locals, user: undefined } });
			expect(denied.status).toBe(401);
			const invalid = await route(context);
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		},
	);
});
