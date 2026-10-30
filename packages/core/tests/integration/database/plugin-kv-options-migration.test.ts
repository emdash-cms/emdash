import { afterEach, beforeEach } from "vitest";

import { createMigrator } from "../../../src/database/migrations/runner.js";
import { pluginKvMigrationCases } from "../../utils/plugin-kv-migration-cases.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("plugin KV options migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("091_redirect_artifacts");
		if (error) throw error;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	pluginKvMigrationCases(() => ctx.db);
});
