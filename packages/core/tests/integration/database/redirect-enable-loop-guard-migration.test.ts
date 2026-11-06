import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration090 from "../../../src/database/migrations/090_redirect_enable_loop_guard.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("redirect enable loop guard migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("089_auto_seed_completion");
		if (error) throw error;
		await sql`
			INSERT INTO _emdash_redirects (id, source, destination, enabled)
			VALUES ('ab', '/a', '/b', 1), ('bc', '/b', '/c', 1), ('ca', '/c', '/a', 0),
				('xd', '/x', '/d', 0)
		`.execute(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("rejects enabling a redirect that closes a loop, and can restart", async () => {
		await migration090.up(ctx.db);
		await migration090.up(ctx.db);

		await expect(
			sql`UPDATE _emdash_redirects SET enabled = 1 WHERE id = 'ca'`.execute(ctx.db),
		).rejects.toThrow("redirect loop");

		const rows = await sql<{ id: string; enabled: number }>`
			SELECT id, enabled FROM _emdash_redirects WHERE id = 'ca'
		`.execute(ctx.db);
		expect(rows.rows).toEqual([{ id: "ca", enabled: 0 }]);
	});

	it("allows enabling a redirect that does not close a loop", async () => {
		await migration090.up(ctx.db);

		await expect(
			sql`UPDATE _emdash_redirects SET enabled = 1 WHERE id = 'xd'`.execute(ctx.db),
		).resolves.toBeDefined();
	});

	it("allows disabling and re-enabling a redirect that is not in a loop", async () => {
		await migration090.up(ctx.db);

		await sql`UPDATE _emdash_redirects SET enabled = 0 WHERE id = 'ab'`.execute(ctx.db);
		await expect(
			sql`UPDATE _emdash_redirects SET enabled = 1 WHERE id = 'ab'`.execute(ctx.db),
		).resolves.toBeDefined();
	});
});
