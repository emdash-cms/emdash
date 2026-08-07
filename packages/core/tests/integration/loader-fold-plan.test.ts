/**
 * Query-plan shape of the folded per-entry hydration subqueries (#1722).
 *
 * `foldedHydrationSelects` folds per-entry term *and* byline hydration into the
 * content query as correlated JSON-array subqueries. On D1 / stats-blind SQLite
 * (no ANALYZE, no `sqlite_stat1`) the planner is free to pick the join order,
 * and a plain `JOIN` lets it drive a subquery from the term/byline table by
 * locale — enumerating *every row in the locale* and probing the pivot once per
 * emitted row. On a site with thousands of terms that's tens of thousands of
 * rows read per list page, paid on every cache miss.
 *
 * The fix pins the join order with `CROSS JOIN` on the SQLite path so each
 * subquery always drives from its pivot (`content_taxonomies` /
 * `_emdash_content_bylines`) by `(collection, entry_id)` and probes the
 * term/byline table by `translation_group` — a handful of reads per entry,
 * independent of taxonomy/byline size and of statistics.
 *
 * This asserts the *plan*, not the output (output is covered by loader-fold).
 * Since the planner is stats-blind here, the plan is schema-driven and does not
 * depend on row counts — this DB matches D1's shape exactly. Both `foldJoin`
 * consumers (`loadCollection` and `loadEntry`) and both subqueries (taxonomy and
 * byline) are guarded, since the fix hardened the join order for all of them.
 *
 * SQLite-only: `EXPLAIN QUERY PLAN` and `CROSS JOIN … ON` are SQLite concerns;
 * Postgres keeps statistics and is unaffected.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
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
				captured.push({
					sql: event.query.sql,
					parameters: event.query.parameters,
				});
			}
		},
	});

	// Deliberately no ANALYZE: matches D1, which never maintains sqlite_stat1.
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
	const anyDb = db as any;
	const content = new ContentRepository(anyDb);
	const tax = new TaxonomyRepository(anyDb);
	const byline = new BylineRepository(anyDb);
	const post = await content.create({
		type: "post",
		slug: "tagged",
		data: { title: "Tagged" },
		locale: "en",
	});
	await anyDb
		.updateTable("ec_post")
		.set({ status: "published" })
		.where("id", "=", post.id)
		.execute();
	// A handful of terms and bylines in the active locale; two of each attached to
	// the entry. The plan is stats-blind so the count is immaterial — the point is
	// the join *order*. Attaching real rows also proves the SQL executes.
	const attachedBylines: string[] = [];
	for (let i = 0; i < 8; i++) {
		const term = await tax.create({
			name: "tag",
			slug: `tag-${i}`,
			label: `Tag ${i}`,
			locale: "en",
		});
		if (i < 2) await tax.attachToEntry("post", post.id, term.id);
		const author = await byline.create({
			displayName: `Author ${i}`,
			slug: `author-${i}`,
			locale: "en",
		});
		if (i < 2) attachedBylines.push(author.id);
	}
	await byline.setContentBylines(
		"post",
		post.id,
		attachedBylines.map((bylineId) => ({ bylineId, roleLabel: "Author" })),
	);
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

/**
 * Assert both folded subqueries drive from their pivot rather than scanning the
 * term/byline table by locale. Bad plan: the subquery drives from
 * `taxonomies`/`_emdash_bylines` by locale, scanning every row in the locale.
 * Good plan: probe the term/byline table by translation_group, one row per
 * attached entry — only reachable when the pivot drives the join.
 */
function assertPivotDrivenFold(plan: string): void {
	// Taxonomy subquery.
	expect(plan, "taxonomy subquery must not scan taxonomies by locale").not.toContain(
		"idx_taxonomies_locale",
	);
	expect(plan, "taxonomy subquery must probe taxonomies by translation_group").toContain(
		"idx_taxonomies_translation_group",
	);
	// Byline subquery. Its `(translation_group, locale)` composite unique index
	// already yields the pivot-driven plan today, so `CROSS JOIN` is a no-op here
	// — this guards against a future byline-index change silently regressing it.
	expect(plan, "byline subquery must not scan bylines by locale").not.toContain(
		"idx__emdash_bylines_locale",
	);
	expect(plan, "byline subquery must probe bylines by translation_group").toContain(
		"idx_bylines_group_locale_unique",
	);
}

/** The folded query is the one exposing the `_emdash_terms` alias. */
function foldedQueryPlan(): string {
	const foldedQuery = captured.find((q) => q.sql.includes("_emdash_terms"));
	expect(foldedQuery, "expected the loader to emit a folded query").toBeDefined();
	return explain(foldedQuery!);
}

it("drives folded hydration from the pivot on loadCollection, not term/byline-by-locale", async () => {
	const loader = emdashLoader();
	// Running the real loader query also proves the SQL executes on SQLite.
	await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection({ filter: { type: "post" } }),
	);
	assertPivotDrivenFold(foldedQueryPlan());
});

it("drives folded hydration from the pivot on loadEntry, not term/byline-by-locale", async () => {
	const loader = emdashLoader();
	captured = [];
	await runWithContext({ editMode: false, db }, () =>
		loader.loadEntry({ filter: { type: "post", id: "tagged", locale: "en" } }),
	);
	assertPivotDrivenFold(foldedQueryPlan());
});
