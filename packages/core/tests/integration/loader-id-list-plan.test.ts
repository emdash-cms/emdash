/**
 * Query-plan shape of a listing pinned to an explicit id list.
 *
 * After ANALYZE, `sqlite_stat1` records the average rows per distinct value of
 * an index's leading column. `deleted_at` is NULL for every live row and a
 * distinct timestamp for every trashed one, so a collection with a well-used
 * trash gets a tiny estimate for `deleted_at IS NULL`, and the planner walks a
 * `deleted_at` index over the whole live table instead of seeking the ids on the
 * primary key. The loader keeps the other filters out of index selection when
 * the ids are pinned.
 *
 * This asserts the plan, not the output, and the output is unchanged. SQLite-only.
 */

import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { emdashLoader, resetTaxonomyNamesCache } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

const LIVE = 200;
const TRASHED = 200;

let sqlite: Database;
let db: Kysely<DatabaseSchema>;
let captured: CapturedQuery[];
let liveIds: string[];

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
	resetTaxonomyNamesCache();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema vs Database type
	const content = new ContentRepository(db as any);
	const ids: string[] = [];
	for (let i = 0; i < LIVE + TRASHED; i++) {
		const post = await content.create({
			type: "post",
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: "published",
			locale: "en",
		});
		ids.push(post.id);
	}
	// Each trashed row gets its own timestamp, as it does when editors trash entries one at a time.
	for (let i = 0; i < TRASHED; i++) {
		await sql`UPDATE ec_post SET deleted_at = ${new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()} WHERE id = ${ids[LIVE + i]}`.execute(
			db,
		);
	}
	liveIds = ids.slice(0, LIVE);
	await sql`ANALYZE`.execute(db);
});

afterEach(async () => {
	await db.destroy();
});

function bindable(p: unknown): unknown {
	if (typeof p === "boolean") return p ? 1 : 0;
	if (p instanceof Date) return p.toISOString();
	if (p === undefined) return null;
	return p;
}

function listQueryPlan(): string {
	const query = captured.find(
		(q) => /from "ec_post"/i.test(q.sql) && q.sql.includes("deleted_at IS NULL"),
	);
	expect(query, "expected the loader to emit the list query").toBeDefined();
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query!.sql}`)
		.all(...query!.parameters.map(bindable)) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

async function load(where: Record<string, unknown>, limit: number) {
	captured = [];
	const loader = emdashLoader();
	return runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({
			filter: { type: "post", where: where as never, limit, orderBy: { id: "desc" } as never },
		}),
	);
}

describe("loader list pinned to an id list", () => {
	it("seeks the ids on the primary key even when the trash skews the statistics", async () => {
		const picked = liveIds.filter((_, i) => i % 10 === 0);
		const result = await load({ id: picked }, picked.length);

		const plan = listQueryPlan();
		expect(plan).toMatch(/SEARCH ec_post USING INDEX sqlite_autoindex_ec_post_1 \(id=\?\)/);
		expect(plan).not.toMatch(/deleted_at=\?/);

		const returned = (result as { entries: { data: { id: string } }[] }).entries.map(
			(e) => e.data.id,
		);
		expect(returned).toEqual([...picked].toSorted().toReversed());
	});

	it("leaves a query without an id list to the planner", async () => {
		await load({}, 10);
		const query = captured.find(
			(q) => /from "ec_post"/i.test(q.sql) && q.sql.includes("deleted_at IS NULL"),
		);
		expect(query?.sql).not.toContain("+deleted_at");
	});
});
