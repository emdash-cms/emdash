/**
 * Query-plan shape of a taxonomy-filtered collection listing (#1834).
 *
 * A taxonomy filter applied as a correlated `EXISTS` on a
 * `SELECT * FROM ec_<collection> ... ORDER BY published_at DESC LIMIT ?` lets a
 * stats-blind D1/SQLite planner (no ANALYZE, no `sqlite_stat1`) drive the scan
 * from `idx_ec_<collection>_deleted_published_id` to satisfy the `ORDER BY` for
 * free, then evaluate the `EXISTS` per row. When the term is *selective* the
 * `LIMIT` never fills early, so it walks the *whole* collection table — tens of
 * thousands of D1 rows read for a page returning one row.
 *
 * The loader now auto-decides from cached per-term counts
 * (`getTermCountsForCollection`): a *selective* term drives a **seek** from
 * `content_taxonomies` (seeking `taxonomy_id` via
 * `idx_content_taxonomies_term_lookup`, joining the collection by primary key),
 * while a *non-selective* term keeps the `EXISTS` **scan** (the `LIMIT` fills
 * fast). For multi-term AND, the smallest-count term drives and the rest become
 * index-nested-loop `EXISTS` probes. The counts are advisory — they change the
 * plan, never the rows — so these assert the plan shape; output is covered by
 * loader-taxonomy-filter.
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
let content: ContentRepository;
let tax: TaxonomyRepository;

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
	content = new ContentRepository(anyDb);
	tax = new TaxonomyRepository(anyDb);
});

afterEach(async () => {
	await db.destroy();
});

/** Create a published post `Post {i}` (dated so `published_at DESC` is stable). */
async function publish(i: number): Promise<string> {
	const post = await content.create({
		type: "post",
		slug: `post-${i}`,
		data: { title: `Post ${i}` },
		locale: "en",
	});
	// eslint-disable-next-line typescript/no-explicit-any -- dynamic ec_* table not in the schema type
	await (db as any)
		.updateTable("ec_post")
		.set({
			status: "published",
			published_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
		})
		.where("id", "=", post.id)
		.execute();
	return post.id;
}

function runList(where: Record<string, unknown>, limit: number) {
	const loader = emdashLoader();
	return runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({
			filter: { type: "post", where: where as never, orderBy: { published_at: "desc" }, limit },
		}),
	);
}

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
function listQuery(): CapturedQuery {
	const q = captured.find((c) => c.sql.includes("_emdash_terms"));
	expect(q, "expected the loader to emit a folded list query").toBeDefined();
	return q!;
}

it("seeks from content_taxonomies for a selective term", async () => {
	// One selective term on 1 of 5 published posts. driverCount(1) is well under
	// the seek budget (sqrt(fetchLimit * total)), so the loader seeks.
	const news = await tax.create({ name: "category", slug: "news", label: "News", locale: "en" });
	for (let i = 0; i < 5; i++) {
		const id = await publish(i);
		if (i === 2) await tax.attachToEntry("post", id, news.id);
	}

	const result = await runList({ category: "news" }, 10);
	expect(result.entries).toHaveLength(1);
	expect(result.entries[0]!.data.title).toBe("Post 2");

	const plan = explain(listQuery());
	// Good plan: seek the selective term via the composite pivot index, using
	// BOTH leading columns. The two-column seek (`INDEXED BY` + plain `collection`
	// equality) reads only this collection's slice of the term; a one-column
	// `(taxonomy_id=?)` seek with a residual collection filter would read the
	// term's rows in *every* collection (verified on D1: 704 vs 2 rows read for a
	// term shared across collections). Asserting the second column guards against
	// regressing to the residual-filter form.
	expect(plan, "must seek content_taxonomies by taxonomy_id AND collection").toContain(
		"idx_content_taxonomies_term_lookup (taxonomy_id=? AND collection=?)",
	);
	expect(plan, "must not drive the scan from the collection's published index").not.toContain(
		"idx_ec_post_deleted_published_id",
	);
});

it("keeps the EXISTS scan for a non-selective term", async () => {
	// Every published post carries the term (driverCount == total), so seeking
	// would materialize the whole collection. With a small page the scan budget
	// (sqrt(fetchLimit * total)) is below driverCount, so the loader scans.
	const news = await tax.create({ name: "category", slug: "news", label: "News", locale: "en" });
	for (let i = 0; i < 6; i++) {
		const id = await publish(i);
		await tax.attachToEntry("post", id, news.id);
	}

	const result = await runList({ category: "news" }, 2);
	expect(result.entries).toHaveLength(2);

	const plan = explain(listQuery());
	// The collection drives the scan in published order; the taxonomy filter is a
	// correlated EXISTS.
	expect(plan, "must drive from the collection's published index").toContain(
		"idx_ec_post_deleted_published_id",
	);
	expect(plan, "must not use the driven seek rewrite").not.toContain(
		"idx_content_taxonomies_term_lookup",
	);
});

it("drives the seek from the smallest-count term across a multi-term AND", async () => {
	// Broad `category:news` on all 6, selective `tag:featured` on 1. The loader
	// must drive the seek from `featured` (count 1), not `news` (count 6), and
	// probe `news` as an index-nested-loop EXISTS.
	const news = await tax.create({ name: "category", slug: "news", label: "News", locale: "en" });
	const featured = await tax.create({ name: "tag", slug: "featured", label: "Feat", locale: "en" });
	for (let i = 0; i < 6; i++) {
		const id = await publish(i);
		await tax.attachToEntry("post", id, news.id);
		if (i === 4) await tax.attachToEntry("post", id, featured.id);
	}

	const result = await runList({ category: "news", tag: "featured" }, 10);
	expect(result.entries).toHaveLength(1);
	expect(result.entries[0]!.data.title).toBe("Post 4");

	const q = listQuery();
	expect(explain(q), "must seek the driver term via the composite pivot index").toContain(
		"idx_content_taxonomies_term_lookup (taxonomy_id=? AND collection=?)",
	);
	// The driver's `_matched` CTE precedes the EXISTS probe in the SQL text, so
	// the selective term's slug binds before the broad term's — proving
	// smallest-first ordering rather than filter (insertion) order.
	const params = q.parameters as unknown[];
	expect(
		params.indexOf("featured") < params.indexOf("news"),
		"selective term must drive (bind first), broad term must probe",
	).toBe(true);
});
