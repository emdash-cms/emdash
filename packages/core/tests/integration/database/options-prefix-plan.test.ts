/**
 * Query-plan coverage for plugin settings prefix reads.
 *
 * SQLite runs without ANALYZE/sqlite_stat1 here, matching D1's stats-blind
 * planner. LIKE must search the case-insensitive index even when the table
 * contains many unrelated plugin options.
 */

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { up, down } from "../../../src/database/migrations/099_options_prefix_index.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database;
let db: Kysely<DatabaseSchema>;
let repo: OptionsRepository;
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

	const unrelated = Array.from({ length: 115 }, (_, index) => ({
		name: `plugin:p${index % 12}:data:option-${String(index).padStart(3, "0")}`,
		value: JSON.stringify({ unrelated: index }),
		revision: `unrelated-revision-${index}`,
	}));
	await db
		.insertInto("options")
		.values([
			...unrelated,
			{ name: "plugin:p7:settings:alpha", value: JSON.stringify("alpha"), revision: "rev-alpha" },
			{
				name: "plugin:p7:settings:charlie",
				value: JSON.stringify("charlie"),
				revision: "rev-charlie",
			},
			{ name: "plugin:p7:settings:bravo", value: JSON.stringify("bravo"), revision: "rev-bravo" },
		])
		.execute();
	repo = new OptionsRepository(db);
	captured = [];
});

afterEach(async () => {
	await db.destroy();
});

it.each(["getByPrefix", "getVersionedByPrefix"] as const)(
	"uses an indexed search for %s and preserves sorted, limited results",
	async (method) => {
		const result =
			method === "getByPrefix"
				? await repo.getByPrefix<string>("plugin:p7:settings:", { limit: 2 })
				: await repo.getVersionedByPrefix<string>("plugin:p7:settings:", { limit: 2 });

		expect([...result.keys()]).toEqual(["plugin:p7:settings:alpha", "plugin:p7:settings:bravo"]);
		if (method === "getByPrefix") {
			expect([...result.values()]).toEqual(["alpha", "bravo"]);
		} else {
			expect([...result.values()]).toEqual([
				{ value: "alpha", revision: "rev-alpha" },
				{ value: "bravo", revision: "rev-bravo" },
			]);
		}

		const query = optionPrefixQuery();
		const plan = explain(query);
		expect(plan).toMatch(
			/SEARCH options USING (?:COVERING )?INDEX idx_options_name_nocase \(name[><]=?\? AND name[><]=?\?\)/,
		);
		expect(plan).not.toContain("SCAN options");
	},
);

it("upgrades existing options and can retry after creating the index", async () => {
	await down(db);
	const before = await db.selectFrom("options").selectAll().orderBy("name").execute();
	await up(db);
	await up(db);
	const after = await db.selectFrom("options").selectAll().orderBy("name").execute();
	expect(after).toEqual(before);
	captured = [];
	await repo.getByPrefix("plugin:p7:settings:");
	expect(explain(optionPrefixQuery())).toContain(
		"SEARCH options USING INDEX idx_options_name_nocase",
	);
});

function optionPrefixQuery(): CapturedQuery {
	const queries = captured.filter(
		(query) => query.sql.includes('from "options"') && query.sql.includes('order by "name"'),
	);
	expect(queries).toHaveLength(1);
	return queries[0]!;
}

/** Normalize application values captured from Kysely for direct driver binding. */
function bindable(parameter: unknown): unknown {
	if (typeof parameter === "boolean") return parameter ? 1 : 0;
	if (parameter instanceof Date) return parameter.toISOString();
	if (parameter === undefined) return null;
	return parameter;
}

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((row) => row.detail).join("\n");
}
