import { afterEach, beforeEach, expect, it } from "vitest";

import { generateSnapshot } from "../../../src/api/handlers/snapshot.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../../utils/test-db.js";

// Regression: generateSnapshot discovered tables with `sqlite_master`, read
// columns with `PRAGMA table_info`, and filtered published rows with
// `strftime(...)` — all SQLite-only. On Postgres every one of them raised
// 42P01 / 42883, so backups (download, "Back up now", and the daily scheduled
// run) and the preview snapshot endpoint all failed. The Postgres variants of
// these tests fail against the pre-fix implementation.
describeEachDialect("generateSnapshot dialect parity", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("discovers content tables and their schema", async () => {
		const snapshot = await generateSnapshot(ctx.db);

		expect(snapshot.generatedAt).toBeTruthy();
		expect(snapshot.schema).toHaveProperty("ec_post");
		expect(snapshot.schema).toHaveProperty("ec_page");
		expect(snapshot.schema.ec_post.columns).toContain("id");
		expect(snapshot.schema.ec_post.columns).toContain("title");
	});

	it("reports column types the snapshot consumer understands", async () => {
		const snapshot = await generateSnapshot(ctx.db);
		const types = snapshot.schema.ec_post.types ?? {};

		expect(Object.keys(types).length).toBeGreaterThan(0);
		for (const type of Object.values(types)) {
			expect(["TEXT", "INTEGER", "REAL", "BLOB", "JSON"]).toContain(type);
		}
	});

	it("applies the published filter without SQLite-only date functions", async () => {
		// The default (no drafts, no trash) path is the one the preview
		// endpoint uses, and the only one that evaluates the status filter.
		const snapshot = await generateSnapshot(ctx.db);

		expect(snapshot.tables.ec_post).toEqual([]);
	});

	it("exports a full-fidelity backup snapshot", async () => {
		// includeTrashed is what the backup handlers pass.
		const snapshot = await generateSnapshot(ctx.db, {
			includeDrafts: true,
			includeTrashed: true,
		});

		expect(snapshot.schema).toHaveProperty("ec_post");
		expect(snapshot.tables._emdash_collections).toHaveLength(2);
	});
});
