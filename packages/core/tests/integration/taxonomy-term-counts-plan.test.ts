/**
 * SQLite query-plan regression guard for the consolidated term-count query.
 * Output correctness is covered by unit/taxonomies/term-counts; this asserts
 * the planner drives from content_taxonomies, not from ec_*.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { fetchVisibleTermCounts } from "../../src/taxonomies/term-counts.js";

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

	// No ANALYZE: D1 never maintains sqlite_stat1.
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema vs Database type
	const anyDb = db as any;
	const content = new ContentRepository(anyDb);
	const tax = new TaxonomyRepository(anyDb);

	// Enough rows to make the two access paths visually distinct.
	const terms = [];
	for (let i = 0; i < 5; i++) {
		terms.push(
			await tax.create({ name: "category", slug: `term-${i}`, label: `Term ${i}`, locale: "en" }),
		);
	}
	for (let i = 0; i < 20; i++) {
		const post = await content.create({
			type: "post",
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: "published",
			locale: "en",
		});
		await tax.attachToEntry("post", post.id, terms[i % terms.length]!.id);
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

async function countQueryPlan(): Promise<string> {
	captured = [];
	await fetchVisibleTermCounts(db, "category", ["post"], "en");
	const query = captured.find((q) => q.sql.includes("content_taxonomies"));
	expect(query, "expected a term-count query against the pivot").toBeDefined();
	return explain(query!);
}

it("seeks the terms on a content_taxonomies index rather than probing the pivot per entry", async () => {
	const plan = await countQueryPlan();

	// The pivot must be entered on a taxonomy_id-leading index.
	expect(plan).toMatch(/SEARCH ct USING (COVERING )?INDEX idx_content_taxonomies/);
	expect(plan).not.toContain("sqlite_autoindex_content_taxonomies_1");
	expect(plan).not.toContain("SCAN ct");
});

it("seeks content rows by translation group", async () => {
	const plan = await countQueryPlan();

	expect(plan).toMatch(
		/SEARCH e USING (COVERING )?INDEX idx_ec_post_del_tg_locale \(deleted_at=\? AND translation_group=\? AND locale=\?\)/,
	);
	expect(plan).not.toContain("SCAN e");
});
