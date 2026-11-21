import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { down, up } from "../../src/database/migrations/099_options_prefix_index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../src/database/repositories/options.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let db: Kysely<Database>;
let captured: CapturedQuery[];

beforeEach(async () => {
	captured = [];
	db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: env.DB }),
		log(event) {
			if (event.level === "query") {
				captured.push({ sql: event.query.sql, parameters: event.query.parameters });
			}
		},
	});
	await resetD1Schema(db);
	await runMigrations(db);

	const unrelated = Array.from({ length: 115 }, (_, index) => ({
		name: `plugin:p${index % 12}:data:option-${String(index).padStart(3, "0")}`,
		value: JSON.stringify({ unrelated: index }),
		revision: `unrelated-revision-${index}`,
	}));
	for (let offset = 0; offset < unrelated.length; offset += 25) {
		await db
			.insertInto("options")
			.values(unrelated.slice(offset, offset + 25))
			.execute();
	}
	await db
		.insertInto("options")
		.values([
			{ name: "plugin:p7:settings:a", value: JSON.stringify("a"), revision: "rev-a" },
			{ name: "plugin:p7:settings:b", value: JSON.stringify("b"), revision: "rev-b" },
			{ name: "plugin:p7:settings:c", value: JSON.stringify("c"), revision: "rev-c" },
		])
		.execute();
});

afterEach(async () => {
	await db.destroy();
});

describe.each([false, true])("options prefix reads (ANALYZE: %s)", (analyze) => {
	beforeEach(async () => {
		if (analyze) await env.DB.prepare("ANALYZE").run();
	});

	it.each(["getByPrefix", "getVersionedByPrefix"] as const)(
		"uses the migration index and reports fewer rows read after migration for %s",
		async (method) => {
			const repo = new OptionsRepository(db);
			const result =
				method === "getByPrefix"
					? await repo.getByPrefix<string>("plugin:p7:settings:", { limit: 2 })
					: await repo.getVersionedByPrefix<string>("plugin:p7:settings:", { limit: 2 });

			expect([...result.keys()]).toEqual(["plugin:p7:settings:a", "plugin:p7:settings:b"]);
			if (method === "getByPrefix") {
				expect([...result.values()]).toEqual(["a", "b"]);
			} else {
				expect([...result.values()]).toEqual([
					{ value: "a", revision: "rev-a" },
					{ value: "b", revision: "rev-b" },
				]);
			}

			const query = capturedQuery();
			const after = await execute(query);
			expect(after.meta.rows_read).toEqual(expect.any(Number));

			const plan = await explain(query);
			expect(plan).toContain("SEARCH options USING INDEX idx_options_name_nocase");
			expect(plan).not.toContain("SCAN options");

			await down(db);
			const before = await execute(query);
			expect(before.meta.rows_read).toEqual(expect.any(Number));
			expect(after.meta.rows_read!).toBeLessThan(before.meta.rows_read!);
			await up(db);
		},
	);
});

function capturedQuery(): CapturedQuery {
	const queries = captured.filter(
		(query) =>
			query.sql.includes('from "options"') &&
			query.sql.includes('order by "name"') &&
			query.sql.includes("LIKE"),
	);
	expect(queries).toHaveLength(1);
	return queries[0]!;
}

function bindable(parameter: unknown): unknown {
	if (typeof parameter === "boolean") return parameter ? 1 : 0;
	if (parameter instanceof Date) return parameter.toISOString();
	return parameter === undefined ? null : parameter;
}

async function execute(query: CapturedQuery) {
	return env.DB.prepare(query.sql)
		.bind(...query.parameters.map(bindable))
		.all<{ name: string; value: string; revision?: string }>();
}

async function explain(query: CapturedQuery): Promise<string> {
	const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.bind(...query.parameters.map(bindable))
		.all<{ detail: string }>();
	return result.results.map((row) => row.detail).join("\n");
}
