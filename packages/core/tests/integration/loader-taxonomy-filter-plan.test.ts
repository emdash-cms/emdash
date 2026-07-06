/**
 * Query-plan shape of a taxonomy-filtered collection listing (#1834).
 *
 * The old query applied the taxonomy filter as a correlated `EXISTS` on a
 * `SELECT * FROM ec_<collection> ... ORDER BY published_at DESC LIMIT ?`. On a
 * stats-blind D1/SQLite planner (no ANALYZE, no `sqlite_stat1`) the planner
 * drives the scan from `idx_ec_<collection>_deleted_published_id` to satisfy the
 * `ORDER BY` for free, then evaluates the `EXISTS` per row. When the term is
 * selective the `LIMIT` never fills early, so it walks the *whole* collection
 * table — tens of thousands of D1 rows read for a page returning one row.
 *
 * Opt-in via `taxonomyStrategy: "seek"`, the fix drives the query from
 * `content_taxonomies`, seeking the selective term by `taxonomy_id` (via
 * `idx_content_taxonomies_term_lookup`) and joining the collection table by
 * primary key. Selectivity is a per-term property the framework can't know for
 * free, so the caller opts in on selective (category/tag archive) routes; the
 * default keeps today's `EXISTS` scan, which is best for non-selective terms.
 *
 * This asserts the *plan*, not the output (output is covered by
 * loader-taxonomy-filter). Since the planner is stats-blind here, the plan is
 * schema-driven and matches D1's shape exactly.
 *
 * SQLite-only: `EXPLAIN QUERY PLAN` is a SQLite concern, and the driven rewrite
 * is SQLite-only (Postgres keeps `EXISTS`, since it has statistics).
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
				captured.push({ sql: event.query.sql, parameters: event.query.parameters });
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

	// A single selective term attached to one of several published entries.
	const news = await tax.create({ name: "category", slug: "news", label: "News", locale: "en" });
	for (let i = 0; i < 5; i++) {
		const post = await content.create({
			type: "post",
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			locale: "en",
		});
		await anyDb
			.updateTable("ec_post")
			.set({ status: "published", published_at: `2026-01-0${i + 1}T00:00:00Z` })
			.where("id", "=", post.id)
			.execute();
		if (i === 2) await tax.attachToEntry("post", post.id, news.id);
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

/** The filtered list query is the one exposing the `_emdash_terms` alias. */
function listQueryPlan(): string {
	const listQuery = captured.find((q) => q.sql.includes("_emdash_terms"));
	expect(listQuery, "expected the loader to emit a folded list query").toBeDefined();
	return explain(listQuery!);
}

it("with taxonomyStrategy 'seek', drives from content_taxonomies, not the collection's published index", async () => {
	const loader = emdashLoader();
	const result = await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({
			filter: {
				type: "post",
				where: { category: "news" } as never,
				orderBy: { published_at: "desc" },
				limit: 10,
				taxonomyStrategy: "seek",
			},
		}),
	);

	// Proves the SQL executes and stays correct on the driven path.
	expect(result.entries).toHaveLength(1);
	expect(result.entries[0]!.data.title).toBe("Post 2");

	const plan = listQueryPlan();
	// Good plan: seek the selective term via the composite pivot index.
	expect(plan, "must seek content_taxonomies by taxonomy_id").toContain(
		"idx_content_taxonomies_term_lookup",
	);
	// Bad plan: drive the scan from the collection's published-order index.
	expect(plan, "must not drive the scan from the collection's published index").not.toContain(
		"idx_ec_post_deleted_published_id",
	);
});

it("by default (no hint) keeps the EXISTS scan — opt-in, no behavior change", async () => {
	const loader = emdashLoader();
	const result = await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({
			filter: {
				type: "post",
				where: { category: "news" } as never,
				orderBy: { published_at: "desc" },
				limit: 10,
			},
		}),
	);

	// Same rows regardless of plan.
	expect(result.entries).toHaveLength(1);
	expect(result.entries[0]!.data.title).toBe("Post 2");

	const plan = listQueryPlan();
	// The default keeps today's shape: the collection drives the scan in
	// published order and the taxonomy filter is a correlated EXISTS.
	expect(plan, "default must drive from the collection's published index").toContain(
		"idx_ec_post_deleted_published_id",
	);
	expect(plan, "default must not use the driven seek rewrite").not.toContain(
		"idx_content_taxonomies_term_lookup",
	);
});
