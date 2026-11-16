import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext, APIRoute } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as enable } from "../../../src/astro/routes/api/search/enable.js";
import { GET as search } from "../../../src/astro/routes/api/search/index.js";
import { POST as rebuild } from "../../../src/astro/routes/api/search/rebuild.js";
import { GET as stats } from "../../../src/astro/routes/api/search/stats.js";
import { GET as suggest } from "../../../src/astro/routes/api/search/suggest.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	PG_CONNECTION_STRING,
	type PgTestContext,
	setupTestPostgresDatabase,
	teardownTestPostgresDatabase,
} from "../../utils/test-db.js";

describe.skipIf(!PG_CONNECTION_STRING)("PostgreSQL search availability", () => {
	let ctx: PgTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupTestPostgresDatabase();
		db = ctx.db;
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", supports: ["search"] });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await new ContentRepository(db).create({
			type: "posts",
			slug: "hello",
			status: "published",
			data: { title: "Hello world" },
		});
	});

	afterEach(async () => {
		await teardownTestPostgresDatabase(ctx);
	});

	function context(path: string, body?: object, role: RoleLevel | null = Role.ADMIN): APIContext {
		const url = new URL(`http://localhost/_emdash/api/search${path}`);
		return {
			url,
			request: new Request(
				url,
				body
					? {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						}
					: undefined,
			),
			locals: { emdash: { db }, user: role ? { id: "admin", role } : null },
		} as unknown as APIContext;
	}

	const endpoints: [string, APIRoute, object?][] = [
		["?q=hello", search],
		["/suggest?q=hel", suggest],
		["/stats", stats],
		["/enable", enable, { collection: "posts", enabled: true }],
		["/enable", enable, { collection: "posts", enabled: false }],
		["/rebuild", rebuild, { collection: "posts" }],
	];

	it.each(endpoints)("reports unsupported search for %s", async (path, handler, body) => {
		const response = await handler(context(path, body));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "SEARCH_UNAVAILABLE", message: expect.stringContaining("PostgreSQL") },
		});
		const collection = await db
			.selectFrom("_emdash_collections")
			.select("search_config")
			.where("slug", "=", "posts")
			.executeTakeFirstOrThrow();
		expect(collection.search_config).toBeNull();
	});

	it.each([null, Role.SUBSCRIBER])("preserves management authorization for %s", async (role) => {
		for (const [path, handler, body] of endpoints.slice(2)) {
			const response = await handler(context(path, body, role));
			expect(response.status).toBe(role ? 403 : 401);
		}
	});

	it.each(endpoints.slice(0, 2))(
		"reports unsupported search to anonymous clients for %s",
		async (path, handler) => {
			const response = await handler(context(path, undefined, null));
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				error: { code: "SEARCH_UNAVAILABLE" },
			});
		},
	);
});
