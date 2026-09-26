import { afterEach, beforeEach, expect, it } from "vitest";

import { indexExists } from "../../../src/database/dialect-helpers.js";
import * as migration088 from "../../../src/database/migrations/088_device_codes_expires_index.js";
import {
	createForDialect,
	describeEachDialect,
	runMigrationsForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("device codes expires_at index migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		await runMigrationsForDialect(ctx);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("indexes device codes by expiry", async () => {
		expect(await indexExists(ctx.db, "idx_device_codes_expires")).toBe(true);
	});

	it("can be replayed after completion", async () => {
		await expect(migration088.up(ctx.db)).resolves.toBeUndefined();

		expect(await indexExists(ctx.db, "idx_device_codes_expires")).toBe(true);
	});

	it("drops the index on rollback and tolerates a repeated rollback", async () => {
		await migration088.down(ctx.db);
		await expect(migration088.down(ctx.db)).resolves.toBeUndefined();

		expect(await indexExists(ctx.db, "idx_device_codes_expires")).toBe(false);
	});
});
