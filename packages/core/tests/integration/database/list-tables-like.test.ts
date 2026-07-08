import { afterEach, beforeEach, expect, it } from "vitest";

import { listTablesLike } from "../../../src/database/dialect-helpers.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../../utils/test-db.js";

// Regression: `listTablesLike` (and the migration column-existence checks)
// must scope to the connection's active schema, not a hardcoded `public`.
// On a Postgres deployment using a non-public schema — including the
// per-test schemas this harness creates — hardcoding `public` returns tables
// from the wrong schema, or none at all. The Postgres variant of this test
// fails against the old `WHERE table_schema = 'public'` query.
describeEachDialect("listTablesLike schema scoping", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("finds content tables in the active schema", async () => {
		const tables = await listTablesLike(ctx.db, "ec_%");
		expect(tables.toSorted()).toEqual(["ec_page", "ec_post"]);
	});

	it("returns an empty list when nothing matches the pattern", async () => {
		const tables = await listTablesLike(ctx.db, "nonexistent_%");
		expect(tables).toEqual([]);
	});
});
