/**
 * Query-plan shape of cursor pages over a nullable sort column.
 *
 * Every page of a `published_at` listing, including the pages that continue
 * from an entry without a publish date, must keep reading the
 * `(deleted_at, published_at DESC, id DESC)` index in order instead of sorting
 * the collection. Descending pages past the dated entries seek the undated
 * ones directly.
 *
 * SQLite-only and stats-blind (no ANALYZE), matching D1.
 */

import { Kysely, SqliteDialect } from "kysely";
import { beforeEach, afterEach, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { emdashLoader, resetTaxonomyNamesCache, type SortDirection } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database;
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

	await runMigrations(db);
	await db
		.updateTable("_emdash_taxonomy_def_groups")
		.set({ collections: JSON.stringify(["post"]) })
		.where("name", "=", "category")
		.execute();
	resetTaxonomyNamesCache();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	const content = new ContentRepository(db);
	const taxonomies = new TaxonomyRepository(db);
	const news = await taxonomies.create({
		name: "category",
		slug: "news",
		label: "News",
		locale: "en",
	});
	for (let i = 0; i < 40; i++) {
		const post = await content.create({
			type: "post",
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: "published",
			publishedAt:
				i % 4 === 0 ? undefined : new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString(),
			locale: "en",
		});
		await taxonomies.attachToEntry("post", post.id, news.id);
	}
});

afterEach(async () => {
	await db.destroy();
});

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map((p) => (p === undefined ? null : p))) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

/** The plan for reading `ec_post`: the `picked` CTE on the pivot path, else the list query. */
function contentReadPlan(): string {
	const pivot = captured.find((q) => q.sql.includes("picked"));
	if (pivot) {
		const plan = explain(pivot);
		return plan.slice(plan.indexOf("CO-ROUTINE picked"), plan.indexOf("\nSCAN picked"));
	}
	const list = captured.find((q) => q.sql.includes('FROM "ec_post"') && q.sql.includes("LIMIT"));
	expect(list, "expected the loader to emit a list query").toBeDefined();
	const plan = explain(list!);
	return plan.slice(0, plan.indexOf("\nCORRELATED SCALAR SUBQUERY"));
}

it.each([
	["asc", undefined],
	["desc", undefined],
	["asc", { category: "news" }],
	["desc", { category: "news" }],
] as const)("reads every %s published_at page %j in index order", async (direction, where) => {
	const loader = emdashLoader();
	let cursor: string | undefined;
	let afterUndated = false;
	let pages = 0;
	do {
		captured = [];
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				collection: "_emdash",
				filter: {
					type: "post",
					limit: 5,
					cursor,
					where: where as never,
					orderBy: { published_at: direction as SortDirection },
				},
			}),
		);
		if ("error" in result) throw result.error;

		const plan = contentReadPlan();
		expect(plan).toContain("USING INDEX idx_ec_post_deleted_published_id");
		expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		if (afterUndated && direction === "desc") {
			expect(plan).toContain("published_at=? AND id<?");
		}

		afterUndated = result.entries.at(-1)?.data.publishedAt === null;
		cursor = (result as { nextCursor?: string }).nextCursor;
		pages++;
	} while (cursor);

	expect(pages).toBe(8);
});
