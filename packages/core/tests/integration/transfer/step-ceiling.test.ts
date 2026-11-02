/**
 * No import step runs more queries than its ceiling, wherever the ceiling
 * falls relative to unit boundaries: the writes that end a step and move
 * between stages are budgeted like units.
 */

import { afterEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import { verifyImportStep } from "../../../src/transfer/export/verify.js";
import { advanceImport } from "../../../src/transfer/import/index.js";
import { TransferStepBudget } from "../../../src/transfer/ops/budget.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import { withFaults } from "./import/harness.js";
import {
	analyze,
	executePlan,
	exportOrigin,
	phase,
	seedTarget,
	TARGET_BOB,
	uploadPackage,
} from "./pipeline.js";

const CEILINGS = Array.from({ length: 20 }, (_, index) => 300 + index);

describeEachDialect("import step query ceiling", (dialect) => {
	let source: DialectTestContext | undefined;
	const targets: DialectTestContext[] = [];

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		for (const target of targets.splice(0)) await teardownForDialect(target);
	});

	it("keeps every step at or under the ceiling", { timeout: 600_000 }, async () => {
		source = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const exported = await exportOrigin(phase(source.db), originStorage);

		const over: Array<{ ceiling: number; stage: string; queries: number }> = [];
		for (const ceiling of CEILINGS) {
			const target = await setupForDialect(dialect);
			targets.push(target);
			const targetStorage = createMemoryStorage();
			await seedTarget(target.db);
			const operationId = await uploadPackage(target.db, targetStorage, exported);
			await analyze(phase(target.db), targetStorage, operationId);
			await executePlan(target.db, targetStorage, operationId, {
				[site.ids.alice]: null,
				[site.ids.bob]: TARGET_BOB,
			});

			const { db, faults } = withFaults(target.db);
			for (let step = 0; ; step++) {
				expect(step).toBeLessThan(2000);
				const start = faults.executed;
				const result = await advanceImport({
					db,
					storage: targetStorage,
					operationId,
					verify: verifyImportStep,
					budget: new TransferStepBudget({
						queryCeiling: ceiling,
						metrics: {
							get dbCount() {
								return faults.executed - start;
							},
						},
					}),
				});
				const queries = faults.executed - start;
				if (queries > ceiling) {
					over.push({ ceiling, stage: result.operation.stage ?? "", queries });
				}
				if (result.nextRequestInMs === null) {
					expect(result.operation.errorDetail).toBeNull();
					expect(result.operation.state).toBe("complete");
					break;
				}
			}
		}
		expect(over).toEqual([]);
	});
});
