import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../../../src/astro/routes/api/schema/collections/index.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type RouteContext = Parameters<typeof POST>[0];

describe("schema collection create route", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("defaults auto slug redirects to enabled when omitted", async () => {
		const response = await POST(createContext({ slug: "posts", label: "Posts" }));

		expect(response.status).toBe(201);
		expect((await registry.getCollection("posts")).autoSlugRedirects).toBe(true);
	});

	it("accepts false and persists it", async () => {
		const response = await POST(
			createContext({ slug: "pages", label: "Pages", autoSlugRedirects: false }),
		);

		expect(response.status).toBe(201);
		expect((await registry.getCollection("pages")).autoSlugRedirects).toBe(false);
	});

	it("rejects a non-boolean auto slug redirect option", async () => {
		const response = await POST(
			createContext({ slug: "invalid", label: "Invalid", autoSlugRedirects: "false" }),
		);

		expect(response.status).toBe(400);
		expect(await registry.getCollection("invalid")).toBeNull();
	});

	function createContext(body: Record<string, unknown>): RouteContext {
		return {
			request: new Request("http://localhost/_emdash/api/schema/collections", {
				method: "POST",
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
