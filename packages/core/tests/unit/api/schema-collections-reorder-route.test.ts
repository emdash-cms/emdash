import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../../../src/astro/routes/api/schema/collections/reorder.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type RouteContext = Parameters<typeof POST>[0];

describe("schema collections reorder route", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createCollection({ slug: "authors", label: "Authors" });
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("persists the requested sidebar order", async () => {
		const response = await POST(reorderContext(["posts", "authors", "pages"]));

		expect(response.status).toBe(200);

		const collections = await registry.listCollections();
		expect(collections.map((collection) => collection.slug)).toEqual(["posts", "authors", "pages"]);
		expect(collections.map((collection) => collection.sortOrder)).toEqual([0, 1, 2]);
	});

	function reorderContext(slugs: string[]): RouteContext {
		return {
			request: new Request("http://localhost/_emdash/api/schema/collections/reorder", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({ slugs }),
			}),
			locals: {
				emdash: { db },
				user: { id: "admin-1", role: Role.ADMIN },
			},
		} as RouteContext;
	}
});
