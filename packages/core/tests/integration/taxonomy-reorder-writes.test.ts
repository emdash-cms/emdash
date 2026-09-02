/**
 * How a reorder reaches the database.
 *
 * D1 has no transactions, so `withTransaction` runs its callback bare there and
 * a statement per term would leave a failed reorder half-applied — some groups
 * moved, positions duplicated. The repository writes each chunk as one `CASE`
 * update instead, which is atomic per statement and bounds the subrequests a
 * large renumbering costs.
 *
 * SQLite-only: this is about the SQL emitted, which doesn't vary by dialect.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleTermReorder } from "../../src/api/handlers/taxonomies.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";

/** Mirrors GROUPS_PER_UPDATE in the repository. */
const GROUPS_PER_UPDATE = 32;

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: TaxonomyRepository;
let captured: string[];

beforeEach(async () => {
	captured = [];
	sqlite = new Database(":memory:");
	db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") captured.push(event.query.sql);
		},
	});
	await runMigrations(db);
	repo = new TaxonomyRepository(db);
});

afterEach(async () => {
	await db.destroy();
});

async function createCategories(count: number): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		// Zero-padded so the label order the migration would mint matches creation
		// order, and a reversal is unambiguous.
		const label = `Term ${String(i).padStart(3, "0")}`;
		const term = await repo.create({ name: "category", slug: `term-${i}`, label });
		ids.push(term.translationGroup ?? term.id);
	}
	return ids;
}

function updates(): string[] {
	return captured.filter((sql) => /^\s*UPDATE taxonomies/i.test(sql));
}

async function storedOrder(): Promise<string[]> {
	const rows = await repo.findByName("category");
	return rows.map((row) => row.label);
}

it("writes a whole sibling group in one statement", async () => {
	const ids = await createCategories(4);

	captured = [];
	const result = await handleTermReorder(db, "category", { ids: ids.toReversed() });

	expect(result.success).toBe(true);
	expect(updates()).toHaveLength(1);
});

it("chunks a renumbering that exceeds the parameter budget", async () => {
	const ids = await createCategories(GROUPS_PER_UPDATE * 2 + 5);

	captured = [];
	const result = await handleTermReorder(db, "category", { ids: ids.toReversed() });

	expect(result.success).toBe(true);
	const statements = updates();
	// One per chunk — not one per term, which is what the loop this replaced cost.
	expect(statements).toHaveLength(Math.ceil(ids.length / GROUPS_PER_UPDATE));
	expect(statements.length).toBeLessThan(ids.length);
});

it("orders correctly across a chunk boundary", async () => {
	const count = GROUPS_PER_UPDATE * 2 + 5;
	const ids = await createCategories(count);
	const before = await storedOrder();

	const result = await handleTermReorder(db, "category", { ids: ids.toReversed() });

	expect(result.success).toBe(true);
	expect(await storedOrder()).toEqual(before.toReversed());
});

it("keeps every position distinct after a chunked reorder", async () => {
	const ids = await createCategories(GROUPS_PER_UPDATE * 2 + 5);

	await handleTermReorder(db, "category", { ids: ids.toReversed() });

	const rows = await repo.findByName("category");
	expect(new Set(rows.map((row) => row.sortOrder)).size).toBe(rows.length);
});

it("stays within D1's bound-parameter ceiling per statement", async () => {
	const ids = await createCategories(GROUPS_PER_UPDATE * 2 + 5);

	captured = [];
	await handleTermReorder(db, "category", { ids: ids.toReversed() });

	for (const sql of updates()) {
		expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
	}
});
