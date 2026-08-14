import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const sqlite = new BetterSqlite3(":memory:");
const captured: Array<{ sql: string; parameters: readonly unknown[] }> = [];
const db = new Kysely<Database>({
	dialect: new SqliteDialect({ database: sqlite }),
	log(event) {
		if (event.level === "query") {
			captured.push({ sql: event.query.sql, parameters: event.query.parameters });
		}
	},
});
const repo = new ContentRepository(db);
let indexName: string;
let localeIndexName: string;

beforeAll(async () => {
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	const field = await registry.createField("post", {
		slug: "priority",
		label: "Priority",
		type: "number",
		indexed: true,
	});
	indexName = `idx_cf_${field.id.toLowerCase()}`;
	localeIndexName = `${indexName}_loc`;

	const insert = sqlite.prepare(
		'INSERT INTO "ec_post" ("id", "locale", "priority") VALUES (?, ?, ?)',
	);
	sqlite.transaction(() => {
		for (let i = 0; i < 1_100; i++) {
			insert.run(`post-en-${i.toString().padStart(4, "0")}`, "en", i % 20);
		}
		for (let i = 0; i < 20; i++) {
			insert.run(`post-nl-${i.toString().padStart(4, "0")}`, "nl", i % 5);
		}
	})();
	sqlite.exec("ANALYZE");
});

afterAll(async () => {
	await db.destroy();
});

function getListPlan() {
	const listQuery = captured.find(
		(query) =>
			query.sql.includes('from "ec_post"') &&
			query.sql.includes("order by") &&
			query.sql.includes("limit"),
	);
	expect(listQuery, "expected to capture the content list query").toBeDefined();
	return sqlite
		.prepare(`EXPLAIN QUERY PLAN ${listQuery!.sql}`)
		.all(...listQuery!.parameters) as Array<{ detail: string }>;
}

function expectIndexSearch(plan: Array<{ detail: string }>, expectedIndexName: string) {
	const details = plan.map((row) => row.detail).join("\n");
	expect(details).toContain(`USING INDEX ${expectedIndexName}`);
	expect(details).not.toContain("TEMP B-TREE");
}

it("uses the custom-field index for ordered cursor pages", async () => {
	captured.length = 0;
	const firstPage = await repo.findMany("post", {
		limit: 3,
		orderBy: { field: "priority", direction: "asc" },
	});
	const firstPlan = getListPlan();

	captured.length = 0;
	const secondPage = await repo.findMany("post", {
		limit: 3,
		cursor: firstPage.nextCursor,
		orderBy: { field: "priority", direction: "asc" },
	});
	const secondPlan = getListPlan();

	expect(firstPage.items.map((item) => item.data.priority)).toEqual([0, 0, 0]);
	expect(secondPage.items.map((item) => item.data.priority)).toEqual([0, 0, 0]);
	expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(6);
	expect(firstPage.total).toBe(1_120);
	expect(secondPage.total).toBe(1_120);
	expectIndexSearch(firstPlan, indexName);
	expectIndexSearch(secondPlan, indexName);
});

it("seeks locale-scoped cursor pages without scanning other locales", async () => {
	captured.length = 0;
	const firstPage = await repo.findMany("post", {
		limit: 3,
		orderBy: { field: "priority", direction: "asc" },
		where: { locale: "nl" },
	});
	const firstPlan = getListPlan();

	captured.length = 0;
	const secondPage = await repo.findMany("post", {
		limit: 3,
		cursor: firstPage.nextCursor,
		orderBy: { field: "priority", direction: "asc" },
		where: { locale: "nl" },
	});
	const secondPlan = getListPlan();

	expect(firstPage.items.map((item) => item.data.priority)).toEqual([0, 0, 0]);
	expect(secondPage.items.map((item) => item.data.priority)).toEqual([0, 1, 1]);
	expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(6);
	expect(firstPage.items.every((item) => item.locale === "nl")).toBe(true);
	expect(secondPage.items.every((item) => item.locale === "nl")).toBe(true);
	expect(firstPage.total).toBe(20);
	expect(secondPage.total).toBe(20);
	for (const plan of [firstPlan, secondPlan]) {
		expectIndexSearch(plan, localeIndexName);
		expect(plan.map((row) => row.detail).join("\n")).toContain("locale=?");
	}
});
