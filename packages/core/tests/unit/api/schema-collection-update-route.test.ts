import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT } from "../../../src/astro/routes/api/schema/collections/[slug]/index.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type RouteContext = Parameters<typeof PUT>[0];

describe("schema collection update route", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await db
			.updateTable("_emdash_collections")
			.set({ url_pattern: "/{slug}-{id}" })
			.where("slug", "=", "posts")
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("round-trips an unchanged legacy URL pattern", async () => {
		const response = await PUT(updateContext({ label: "Articles", urlPattern: "/{slug}-{id}" }));

		expect(response.status).toBe(200);
		expect(await registry.getCollection("posts")).toMatchObject({
			label: "Articles",
			urlPattern: "/{slug}-{id}",
		});
	});

	it("rejects a changed invalid URL pattern without mutating the collection", async () => {
		const response = await PUT(updateContext({ label: "Articles", urlPattern: "/{year}{slug}" }));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_URL_PATTERN" } });
		expect(await registry.getCollection("posts")).toMatchObject({
			label: "Posts",
			urlPattern: "/{slug}-{id}",
		});
	});

	function updateContext(body: Record<string, unknown>): RouteContext {
		return {
			params: { slug: "posts" },
			request: new Request("http://localhost/_emdash/api/schema/collections/posts", {
				method: "PUT",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify(body),
			}),
			locals: {
				emdash: { db, invalidateUrlPatternCache: vi.fn() },
				user: { id: "admin-1", role: Role.ADMIN },
			},
		} as RouteContext;
	}
});
