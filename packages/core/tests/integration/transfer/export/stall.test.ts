import { afterEach, beforeEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../../src/i18n/config.js";
import { advanceExport, createExport } from "../../../../src/transfer/export/exporter.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../../utils/transfer/origin-site.js";

describeEachDialect("stuck export circuit breaker", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		await buildOriginSite(ctx.db, storage);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	it("fails an export that makes no cursor progress for too many steps", async () => {
		const { operation } = await createExport({ db: ctx.db, createdBy: "exporter" });
		const budget = new TransferStepBudget({ queryCeiling: 0, metrics: { dbCount: 1 } });

		let last = operation;
		for (let attempt = 0; attempt < 10; attempt++) {
			const result = await advanceExport({
				db: ctx.db,
				storage,
				operationId: operation.id,
				budget,
				defaultLocale: "en",
				emdashVersion: "0.0.0-test",
			});
			last = result.operation;
			if (result.outcome !== "advanced") break;
		}

		expect(last.state).toBe("failed");
		expect(last.errorCode).toBe("TRANSFER_EXPORT_STALLED");
		expect(last.leaseToken).toBeNull();
	});
});
