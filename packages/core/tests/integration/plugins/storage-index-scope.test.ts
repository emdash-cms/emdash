import type { Kysely } from "kysely";
import { afterEach, beforeEach } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { registerPluginStorageIndexScopeCases } from "../../utils/plugin-storage-index-scope-cases.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("plugin storage unique index scope", (dialect) => {
	let context: DialectTestContext | undefined;
	beforeEach(async () => {
		context = await setupForDialect(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(context);
		context = undefined;
	});

	registerPluginStorageIndexScopeCases(() => context!.db as Kysely<Database>, {
		sqlite: dialect === "sqlite",
	});
});
