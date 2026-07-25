import { afterEach, beforeEach, expect, it } from "vitest";

import { listTableColumns } from "../../../src/database/dialect-helpers.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../../utils/test-db.js";

// `listTableColumns` replaces a bare `PRAGMA table_info(...)`, which does not
// exist on Postgres. The types it reports are SQLite storage classes on both
// dialects, because snapshot consumers recreate tables in SQLite from them.
describeEachDialect("listTableColumns", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("lists a content table's columns in declaration order", async () => {
		const columns = await listTableColumns(ctx.db, "ec_page");
		const names = columns.map((c) => c.name);

		expect(names[0]).toBe("id");
		expect(names).toEqual(expect.arrayContaining(["slug", "status", "version", "title"]));
	});

	it("reports SQLite storage classes on both dialects", async () => {
		const columns = await listTableColumns(ctx.db, "ec_page");

		// Postgres data_type strings (`character varying`, `timestamp with time
		// zone`, ...) must be mapped, not passed through: snapshot consumers
		// allowlist exactly these and silently fall back to TEXT otherwise.
		for (const column of columns) {
			expect(["TEXT", "INTEGER", "REAL", "BLOB", "JSON"]).toContain(column.type);
		}
	});

	it("maps an integer column to INTEGER on both dialects", async () => {
		const columns = await listTableColumns(ctx.db, "ec_page");
		const version = columns.find((c) => c.name === "version");

		expect(version?.type).toBe("INTEGER");
	});

	it("returns an empty list for a table that does not exist", async () => {
		expect(await listTableColumns(ctx.db, "ec_nonexistent")).toEqual([]);
	});
});
