/**
 * Query-plan shape of the admin content list's byline filter.
 *
 * The filter is a correlated `(NOT) EXISTS` from the content table precisely so
 * the outer query keeps the composite index its `ORDER BY` needs and `LIMIT`
 * short-circuits. Driving from the junction side instead (`FROM
 * _emdash_content_bylines JOIN ec_*`) sorts in a temp b-tree, which on a large
 * collection means reading the whole filtered set to return one page.
 *
 * These assertions pin that: every probe is an indexed seek and no shape sorts.
 *
 * SQLite-only: `EXPLAIN QUERY PLAN` is a SQLite concern and, being stats-blind
 * here, the plan is schema-driven — matching D1 exactly.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { ContentBylineFilter } from "../../../src/database/repositories/types.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: ContentRepository;
let captured: CapturedQuery[];

beforeEach(async () => {
	captured = [];
	sqlite = new Database(":memory:");
	db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") {
				captured.push({ sql: event.query.sql, parameters: event.query.parameters });
			}
		},
	});

	// No ANALYZE: matches D1, which never maintains sqlite_stat1.
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
	repo = new ContentRepository(db);
});

afterEach(async () => {
	await db.destroy();
});

/** better-sqlite3 only binds primitives; coerce the JS values Kysely captured. */
function bindable(p: unknown): unknown {
	if (typeof p === "boolean") return p ? 1 : 0;
	if (p instanceof Date) return p.toISOString();
	if (p === undefined) return null;
	return p;
}

/**
 * Plan of the page query the repository actually emitted — matched on its
 * `limit`, which the parallel unbounded `count` doesn't carry.
 */
async function planOfPageQuery(bylineFilter: ContentBylineFilter): Promise<string> {
	captured = [];
	await repo.findMany("posts", { where: { locale: "en", bylineFilter }, limit: 20 });

	const query = captured.findLast((q) => q.sql.includes("limit") && q.sql.includes("_bylines"));
	expect(query, "expected a byline-filtered page query to have been emitted").toBeDefined();
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query!.sql}`)
		.all(...query!.parameters.map(bindable)) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

const GROUP = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

it("seeks the junction and the byline row for a selected byline", async () => {
	const plan = await planOfPageQuery({ mode: "any", bylineIds: [GROUP], locale: "en" });

	// Junction seek on (collection_slug, content_id, byline_id) — the unique
	// from migration 031 — then the byline group at the list's locale.
	expect(plan).toContain("sqlite_autoindex__emdash_content_bylines_2");
	expect(plan).toContain("idx_bylines_group_locale_unique");
	expect(plan).not.toContain("SCAN cb");
	expect(plan).not.toContain("SCAN b");
	expect(plan).not.toContain("TEMP B-TREE");
});

it("seeks the junction for the no-byline filter", async () => {
	const plan = await planOfPageQuery({ mode: "none", locale: "en" });

	expect(plan).toContain("idx_content_bylines_content");
	expect(plan).toContain("idx_bylines_group_locale_unique");
	expect(plan).not.toContain("SCAN cb");
	expect(plan).not.toContain("SCAN b");
	expect(plan).not.toContain("TEMP B-TREE");
});

it("seeks the author's byline when inference is opted into", async () => {
	const plan = await planOfPageQuery({
		mode: "any",
		bylineIds: [GROUP],
		includeInferred: true,
		locale: "en",
	});

	// With groups to narrow to, the inferred branch seeks the author's byline
	// through the (translation_group, locale) unique and checks `user_id` off
	// the row, rather than scanning the byline table.
	expect(plan).toContain("idx_bylines_group_locale_unique");
	expect(plan).not.toContain("SCAN cb");
	expect(plan).not.toContain("SCAN b");
	expect(plan).not.toContain("TEMP B-TREE");
});

it("seeks every probe for the no-byline filter with inference opted into", async () => {
	const plan = await planOfPageQuery({ mode: "none", includeInferred: true, locale: "en" });

	expect(plan).toContain("idx_bylines_user_id_locale_unique");
	expect(plan).not.toContain("SCAN cb");
	expect(plan).not.toContain("SCAN b");
	expect(plan).not.toContain("TEMP B-TREE");
});

it("keeps the outer sort index in every filter shape", async () => {
	const shapes: ContentBylineFilter[] = [
		{ mode: "any", bylineIds: [GROUP], locale: "en" },
		{ mode: "none", locale: "en" },
		{ mode: "any", bylineIds: [GROUP], includeInferred: true, locale: "en" },
		{ mode: "none", includeInferred: true, locale: "en" },
	];

	for (const shape of shapes) {
		const plan = await planOfPageQuery(shape);
		expect(plan, JSON.stringify(shape)).not.toContain("SCAN ec_posts");
		expect(plan, JSON.stringify(shape)).not.toContain("USE TEMP B-TREE FOR ORDER BY");
	}
});
