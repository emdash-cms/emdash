/**
 * Query-plan shape of the pivot-driven taxonomy listing (#1834).
 *
 * On stats-blind SQLite/D1 (no ANALYZE, no `sqlite_stat1`) the old EXISTS shape
 * drove the scan from the collection's order index and probed a taxonomy EXISTS
 * per row — a full `ec_*` walk for a selective term. The restructure seeks the
 * term on the group-keyed pivot, then seeks matching content translations by
 * `translation_group`. Sorting is bounded to the tagged candidates.
 *
 * This asserts the plan, not the output (output is covered by
 * loader-taxonomy-pivot). SQLite-only: `EXPLAIN QUERY PLAN` is a SQLite concern
 * and, being stats-blind here, the plan is schema-driven — matching D1 exactly.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { emdashLoader, resetTaxonomyNamesCache } from "../../src/loader.js";
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
		.updateTable("_emdash_taxonomy_defs")
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
	// A selective term: one tagged entry among many. The plan is stats-blind so
	// the ratio is immaterial — the point is that the seek short-circuits.
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

/** The pivot-drive query is the one with the `picked` CTE. */
function pivotQueryPlan(): string {
	const query = captured.find((q) => q.sql.includes("picked"));
	expect(query, "expected the loader to emit a pivot-drive query").toBeDefined();
	return explain(query!);
}

async function runLoad(extra: Record<string, unknown>): Promise<void> {
	captured = [];
	const loader = emdashLoader();
	await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({
			filter: { type: "post", where: { category: "news" } as never, limit: 5, ...extra },
		}),
	);
}

it("seeks group assignments for a published_at sort", async () => {
	await runLoad({ orderBy: { published_at: "desc" } });
	const plan = pivotQueryPlan();
	expect(plan).toContain("idx_content_taxonomies_group_lookup");
	expect(plan).not.toContain("SCAN r");
});

it("seeks group assignments for the default created_at sort", async () => {
	await runLoad({});
	const plan = pivotQueryPlan();
	expect(plan).toContain("idx_content_taxonomies_group_lookup");
	expect(plan).not.toContain("SCAN r");
});

it("seeks group assignments and the requested content locale", async () => {
	await runLoad({ orderBy: { published_at: "desc" }, locale: "en" });
	const plan = pivotQueryPlan();
	expect(plan).toContain("idx_content_taxonomies_group_lookup");
	expect(plan).toContain("idx_ec_post_del_tg_locale");
	expect(plan).not.toContain("SCAN r");
});

it("updated_at sort seeks the term via the pivot and does not full-scan the content table", async () => {
	await runLoad({ orderBy: { updated_at: "desc" } });
	const plan = pivotQueryPlan();
	expect(plan).toContain("idx_content_taxonomies_group_lookup");
	expect(plan).not.toContain("SCAN ct");
	expect(plan).not.toContain("SCAN r");
});
