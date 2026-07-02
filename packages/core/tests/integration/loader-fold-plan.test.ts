/**
 * Query-plan shape of the folded taxonomy-term hydration subquery (#1722).
 *
 * `foldedHydrationSelects` folds per-entry term hydration into the content query
 * as a correlated JSON-array subquery. On D1 / stats-blind SQLite (no ANALYZE,
 * no `sqlite_stat1`) the planner is free to pick the join order, and a plain
 * `JOIN` lets it drive the subquery from `taxonomies` by locale — enumerating
 * *every term in the locale* and probing the pivot once per emitted row. On a
 * site with thousands of terms that's tens of thousands of rows read per list
 * page, paid on every cache miss.
 *
 * The fix pins the join order with `CROSS JOIN` on the SQLite path so the
 * subquery always drives from the `content_taxonomies` pivot by
 * `(collection, entry_id)` and probes `taxonomies` by `translation_group` — a
 * handful of reads per entry, independent of taxonomy size and of statistics.
 *
 * This asserts the *plan*, not the output (output is covered by loader-fold).
 * Since the planner is stats-blind here, the plan is schema-driven and does not
 * depend on row counts — this DB matches D1's shape exactly.
 *
 * SQLite-only: `EXPLAIN QUERY PLAN` and `CROSS JOIN … ON` are SQLite concerns;
 * Postgres keeps statistics and is unaffected.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
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
	// A handful of terms in the active locale; two attached to the entry. The plan
	// is stats-blind so the count is immaterial — the point is the join *order*.
	for (let i = 0; i < 8; i++) {
		const term = await tax.create({
			name: "tag",
			slug: `tag-${i}`,
			label: `Tag ${i}`,
			locale: "en",
		});
		if (i < 2) await tax.attachToEntry("post", post.id, term.id);
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

it("drives folded term hydration from the content_taxonomies pivot, not taxonomies-by-locale", async () => {
	const loader = emdashLoader();
	// Running the real loader query also proves the SQL executes on SQLite.
	await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection({ filter: { type: "post" } }),
	);

	// The folded list query is the one exposing the `_emdash_terms` alias.
	const foldedQuery = captured.find((q) => q.sql.includes("_emdash_terms"));
	expect(foldedQuery, "expected the loader to emit a folded list query").toBeDefined();

	const plan = explain(foldedQuery!);

	// Bad plan: the subquery drives from `taxonomies` by locale, scanning every
	// term in the locale (`SEARCH t USING INDEX idx_taxonomies_locale`).
	expect(plan).not.toContain("idx_taxonomies_locale");
	// Good plan: probe `taxonomies` by translation_group, one row per attached
	// term — only reachable when the pivot drives the join.
	expect(plan).toContain("idx_taxonomies_translation_group");
});
