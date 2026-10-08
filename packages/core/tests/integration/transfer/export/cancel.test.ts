import { afterEach, beforeEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../../src/i18n/config.js";
import { advanceExport, createExport } from "../../../../src/transfer/export/exporter.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import { TransferOperationRepository } from "../../../../src/transfer/ops/operations.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../../utils/transfer/origin-site.js";

describeEachDialect("export cancel", (dialect) => {
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

	it("honours a cancel request during export_media", async () => {
		const { operation } = await createExport({ db: ctx.db, createdBy: "exporter" });
		const repo = new TransferOperationRepository(ctx.db);
		await repo.requestExportCancel(operation.id);

		const result = await advanceExport({
			db: ctx.db,
			storage,
			operationId: operation.id,
			budget: new TransferStepBudget({ queryCeiling: 1000, metrics: { dbCount: 0 } }),
			defaultLocale: "en",
			emdashVersion: "0.0.0-test",
		});

		expect(result.operation.state).toBe("cancelled");
		expect(result.operation.errorCode).toBe("TRANSFER_CANCELLED");
		expect(result.operation.leaseToken).toBeNull();
	});

	it("includes cancelled exports when listing uncollected staging", async () => {
		const { operation } = await createExport({ db: ctx.db, createdBy: "exporter" });
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({
				state: "cancelled",
				error_code: "TRANSFER_CANCELLED",
				error_detail: "{}",
				completed_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			})
			.where("id", "=", operation.id)
			.execute();

		const repo = new TransferOperationRepository(ctx.db);
		const uncollected = await repo.listUncollected(10);
		expect(uncollected.map((op) => op.id)).toContain(operation.id);
	});
});
