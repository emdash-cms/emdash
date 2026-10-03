import { afterEach, beforeEach, it } from "vitest";

import { verifyRevisionAutosaveUpgrade } from "../../utils/revision-autosave-migration-cases.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("revision autosave upgrade", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("preserves old checkpoints and autosave behavior after migration retries", async () => {
		await verifyRevisionAutosaveUpgrade(ctx.db);
	});
});
