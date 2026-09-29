import { afterEach, beforeEach } from "vitest";

import {
	createLegacyPluginStorageTables,
	pluginStorageRevisionMigrationCases,
} from "../../utils/plugin-storage-revision-cases.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("plugin storage revision migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		await createLegacyPluginStorageTables(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	pluginStorageRevisionMigrationCases(() => ctx.db, dialect === "sqlite");
});
