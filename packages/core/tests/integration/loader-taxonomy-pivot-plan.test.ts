/**
 * Query-plan shape of the pivot-driven taxonomy listing (#1834).
 *
 * On stats-blind SQLite/D1 (no ANALYZE, no `sqlite_stat1`) the old EXISTS shape
 * drove the scan from the collection's order index and probed a taxonomy EXISTS
 * per row — a full `ec_*` walk for a selective term. A small term is sought on
 * the group-keyed pivot instead, then matching content translations by
 * `translation_group`, with sorting bounded to the tagged candidates. Only a
 * large term under an indexed sort walks the order index, where a page fills
 * after a few rows.
 *
 * This asserts the plan, not the output (output is covered by
 * loader-taxonomy-pivot). SQLite-only: `EXPLAIN QUERY PLAN` is a SQLite concern
 * and, being stats-blind here, the plan is schema-driven — matching D1 exactly.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { emdashLoader, LARGE_TERM_ASSIGNMENTS, resetTaxonomyNamesCache } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
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

	// Deliberately no ANALYZE: matches D1, which never maintains sqlite_stat1.
	await runMigrations(db);
	await db
		.updateTable("_emdash_taxonomy_def_groups")
		.set({ collections: JSON.stringify(["post"]) })
		.where("name", "in", ["category", "tag"])
		.execute();
	resetTaxonomyNamesCache();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema vs Database type
	const anyDb = db as any;
	const content = new ContentRepository(anyDb);
	const tax = new TaxonomyRepository(anyDb);
	const term = await tax.create({ name: "category", slug: "news", label: "News", locale: "en" });
	// A small term: one tagged entry among many.
	for (let i = 0; i < 30; i++) {
		const post = await content.create({
			type: "post",
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: "published",
			locale: "en",
		});
		if (i === 0) await tax.attachToEntry("post", post.id, term.id);
	}
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

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

/** The pivot-driven query is the one with the `picked` CTE. */
function pivotQueryPlan(): string {
	const query = captured.find((q) => q.sql.includes("picked"));
	expect(query, "expected the loader to emit a pivot-driven query").toBeDefined();
	return explain(query!);
}

/** The term lookup is the query that resolves the filter's slugs to translation groups. */
function termLookupPlan(): string {
	const query = captured.find((q) => q.sql.startsWith('select distinct "translation_group"'));
	expect(query, "expected the loader to emit a term lookup").toBeDefined();
	return explain(query!);
}

/**
 * Returns just the `picked` CTE plan (between `CO-ROUTINE picked` and `SCAN picked`),
 * or the whole plan when SQLite flattened the CTE into the outer query.
 */
function pickedCtePlan(plan: string): string {
	const start = plan.indexOf("CO-ROUTINE picked\n");
	if (start === -1) return plan;
	const end = plan.indexOf("\nSCAN picked", start);
	if (end === -1) return plan.slice(start);
	return plan.slice(start, end);
}

async function runLoad(
	where: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): Promise<void> {
	captured = [];
	const loader = emdashLoader();
	await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({
			filter: { type: "post", where: where as never, limit: 5, ...extra },
		}),
	);
}

/** `picked` seeks the term's assignments on the pivot and sorts their content rows. */
function expectPivotSeek(plan: string): void {
	const picked = pickedCtePlan(plan);
	expect(picked).toContain("SEARCH ct USING COVERING INDEX idx_content_taxonomies_group_lookup");
	expect(picked).not.toMatch(/SEARCH r USING INDEX idx_ec_post_deleted_(published|created)_id/);
	expect(plan).not.toContain("SCAN r");
}

/** `picked` walks the content order index and stops at `LIMIT`, with no sort. */
function expectContentWalk(plan: string, orderIndex: string): void {
	const picked = pickedCtePlan(plan);
	expect(picked).toContain(`SEARCH r USING INDEX ${orderIndex} (deleted_at=?)`);
	expect(picked).not.toContain("USE TEMP B-TREE FOR ORDER BY");
	expect(plan).not.toContain("SCAN ct");
}

it("seeks a small term on the pivot for a published_at sort", async () => {
	await runLoad({ category: "news" }, { orderBy: { published_at: "desc" } });
	expectPivotSeek(pivotQueryPlan());
});

it("seeks a small term on the pivot for the default created_at sort", async () => {
	await runLoad({ category: "news" });
	expectPivotSeek(pivotQueryPlan());
});

it("seeks a small term and the requested content locale", async () => {
	await runLoad({ category: "news" }, { orderBy: { published_at: "desc" }, locale: "en" });
	const plan = pivotQueryPlan();
	expectPivotSeek(plan);
	expect(pickedCtePlan(plan)).toContain("idx_ec_post_del_tg_locale");
});

it("seeks a small term on the pivot for an updated_at sort", async () => {
	await runLoad({ category: "news" }, { orderBy: { updated_at: "desc" } });
	expectPivotSeek(pivotQueryPlan());
});

describe("a large term", () => {
	beforeEach(async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema vs Database type
		const tax = new TaxonomyRepository(db as any);
		const big = await tax.create({ name: "category", slug: "big", label: "Big", locale: "en" });
		const bigGroup = big.translationGroup ?? big.id;
		await sql`
			WITH RECURSIVE seq(i) AS (
				SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${LARGE_TERM_ASSIGNMENTS}
			)
			INSERT INTO ec_post (id, slug, status, locale, translation_group, created_at, updated_at, published_at, title)
			SELECT printf('big%04d', i), printf('big-%04d', i), 'published', 'en', printf('big%04d', i),
				datetime('2024-01-01', printf('+%d minutes', i)),
				datetime('2024-01-01', printf('+%d minutes', i)),
				datetime('2024-01-01', printf('+%d minutes', i)),
				printf('Big %d', i)
			FROM seq
		`.execute(db);
		await sql`
			INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
			SELECT 'post', translation_group, ${bigGroup} FROM ec_post WHERE id LIKE 'big%'
		`.execute(db);
		const featured = await tax.create({
			name: "tag",
			slug: "featured",
			label: "Featured",
			locale: "en",
		});
		await tax.attachToEntry("post", "big0001", featured.id);
	});

	it("walks the published_at index", async () => {
		await runLoad({ category: "big" }, { orderBy: { published_at: "desc" } });
		expectContentWalk(pivotQueryPlan(), "idx_ec_post_deleted_published_id");
	});

	it("walks the created_at index for the default sort", async () => {
		await runLoad({ category: "big" });
		expectContentWalk(pivotQueryPlan(), "idx_ec_post_deleted_created_id");
	});

	it("reads no pivot rows in the term lookup for a second slug", async () => {
		await runLoad({ category: ["big", "news"] });
		expect(termLookupPlan()).not.toContain("content_taxonomies");
	});

	it("is sought on the pivot when one slug names terms in two locales", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema vs Database type
		const tax = new TaxonomyRepository(db as any);
		const other = await tax.create({ name: "category", slug: "big", label: "Groß", locale: "de" });
		await tax.attachToEntry("post", "big0002", other.id);
		await runLoad({ category: "big" });
		expectPivotSeek(pivotQueryPlan());
	});

	it.each([
		["an updated_at sort", { category: "big" }, { orderBy: { updated_at: "desc" } }],
		["a second slug", { category: ["big", "news"] }, {}],
		["a second taxonomy", { tag: "featured", category: "big" }, {}],
		["no limit", { category: "big" }, { limit: undefined }],
	])("is sought on the pivot with %s", async (_shape, where, extra) => {
		await runLoad(where, extra);
		expectPivotSeek(pivotQueryPlan());
	});
});
