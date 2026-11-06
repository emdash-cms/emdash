import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";

function makeCategories(n: number): Array<{
	nicename: string;
	name: string;
	description?: string;
}> {
	return Array.from({ length: n }, (_, i) => ({
		nicename: `cat-${i}`,
		name: `Category ${i}`,
		description: `Description ${i}`,
	}));
}

describe("preImportWxrTaxonomies batching", () => {
	let db: Kysely<Database>;
	let queryCount = 0;

	beforeEach(async () => {
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
			log(event) {
				if (event.level === "query") queryCount++;
			},
		});
		await runMigrations(db);
		queryCount = 0;
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("keeps the total query count bounded for a large new vocabulary", async () => {
		const categories = makeCategories(120);

		const plan = await preImportWxrTaxonomies(db, [], categories, [], [], "en");

		expect(plan.termsCreated.category).toBe(120);
		expect(queryCount).toBeLessThan(700);
	});

	it("reuses a large existing vocabulary with bounded queries", async () => {
		const categories = makeCategories(120);

		const first = await preImportWxrTaxonomies(db, [], categories, [], [], "en");
		expect(first.termsCreated.category).toBe(120);

		queryCount = 0;
		const second = await preImportWxrTaxonomies(db, [], categories, [], [], "en");

		expect(second.termsReused.category).toBe(120);
		expect(second.termsCreated.category).toBeUndefined();
		expect(queryCount).toBeLessThan(10);
	});
});
