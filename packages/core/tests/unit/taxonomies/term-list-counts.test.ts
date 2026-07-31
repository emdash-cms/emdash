/**
 * The admin terms-list endpoint aggregates visible counts only when asked.
 *
 * The content editor's taxonomy sidebar lists terms to pick from and never
 * renders a count, but it shares an endpoint with the Taxonomies settings page,
 * which does. Every editor open therefore paid one `content_taxonomies × ec_*`
 * aggregate per applicable taxonomy. Assertions are on the SQL actually
 * executed — the response shape alone can't tell whether the work was done.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleTermList } from "../../../src/api/handlers/taxonomies.js";
import { GET as getTerms } from "../../../src/astro/routes/api/taxonomies/[name]/terms/index.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

/** SQL of every query executed against the test database. */
let queries: string[] = [];

/** `per_collection` is the visible-count aggregate's subquery alias. */
function countAggregateQueries(): string[] {
	return queries.filter((q) => q.includes("per_collection"));
}

const adminUser = {
	id: "u-admin",
	email: "a@example.com",
	name: "Admin",
	role: Role.ADMIN as RoleLevel,
};

function buildGetContext(db: Kysely<DatabaseSchema>, name: string, search = ""): APIContext {
	const url = new URL(`http://localhost/_emdash/api/taxonomies/${name}/terms${search}`);
	return {
		params: { name },
		url,
		request: new Request(url, { headers: { "X-EmDash-Request": "1" } }),
		locals: { emdash: { db }, user: adminUser },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

interface TermsResponse {
	data?: { terms?: Array<{ slug: string; count?: number }> };
}

describe("term list counts are only aggregated on demand", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		queries = [];
		db = new Kysely<DatabaseSchema>({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
			log(event) {
				if (event.level === "query") queries.push(event.query.sql);
			},
		});
		await runMigrations(db);

		// Migrations seed the `category` def declaring a `posts` collection; point
		// it at the collection this test creates so the aggregate has a real table.
		await new SchemaRegistry(db).createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["post"]) })
			.where("name", "=", "category")
			.execute();

		const taxRepo = new TaxonomyRepository(db);
		const contentRepo = new ContentRepository(db);
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Technology" });
		for (const slug of ["published-one", "published-two"]) {
			const entry = await contentRepo.create({ type: "post", slug, status: "published", data: {} });
			await taxRepo.attachToEntry("post", entry.id, term.id);
		}
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("counts by default, so existing callers are unaffected", async () => {
		queries = [];
		const result = await handleTermList(db, "category");

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.terms[0]!.count).toBe(2);
		expect(countAggregateQueries()).toHaveLength(1);
	});

	it("omits the aggregate and the count field when the caller opts out", async () => {
		queries = [];
		const result = await handleTermList(db, "category", { includeCounts: false });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.terms[0]!.slug).toBe("tech");
		expect(result.data.terms[0]).not.toHaveProperty("count");
		expect(countAggregateQueries()).toEqual([]);
	});

	it("honours ?includeCounts=false on the route", async () => {
		queries = [];
		const response = await getTerms(buildGetContext(db, "category", "?includeCounts=false"));
		const body = (await response.json()) as TermsResponse;

		expect(response.status).toBe(200);
		expect(body.data?.terms?.[0]?.slug).toBe("tech");
		expect(body.data?.terms?.[0]).not.toHaveProperty("count");
		expect(countAggregateQueries()).toEqual([]);
	});

	it("still counts on the route when the param is absent", async () => {
		queries = [];
		const response = await getTerms(buildGetContext(db, "category"));
		const body = (await response.json()) as TermsResponse;

		expect(body.data?.terms?.[0]?.count).toBe(2);
		expect(countAggregateQueries()).toHaveLength(1);
	});
});
