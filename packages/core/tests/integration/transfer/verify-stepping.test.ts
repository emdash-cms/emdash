/**
 * Verification during an import stops a step when the verifier yields, so a
 * step whose byte budget is spent does not burn the rest of its query budget
 * re-entering the verifier.
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

const QUERY_CEILING = 900;

describeEachDialect("import verification stepping", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	it("ends a verify step once its byte budget is spent", { timeout: 300_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const targetStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		await seedTarget(target.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		const exported = await exportOrigin(phase(source.db), originStorage);
		const operationId = await uploadPackage(target.db, targetStorage, exported);
		await analyze(phase(target.db), targetStorage, operationId);
		await executePlan(target.db, targetStorage, operationId, {
			[site.ids.alice]: null,
			[site.ids.bob]: TARGET_BOB,
		});

		const { db, faults } = withFaults(target.db);
		const verifySteps: number[] = [];
		for (let step = 0; step < 2000; step++) {
			const start = faults.executed;
			const budget = new TransferStepBudget({
				queryCeiling: QUERY_CEILING,
				bytes: 1,
				metrics: {
					get dbCount() {
						return faults.executed - start;
					},
				},
			});
			const result = await advanceImport({
				db,
				storage: targetStorage,
				operationId,
				verify: verifyImportStep,
				budget,
			});
			if (result.operation.stage === "verify") verifySteps.push(faults.executed - start);
			if (result.nextRequestInMs === null) {
				expect(result.operation.errorDetail).toBeNull();
				expect(result.operation.state).toBe("complete");
				break;
			}
		}
		expect(verifySteps.length).toBeGreaterThan(5);
		// One verifier unit per step costs a few dozen queries at most.
		expect(Math.max(...verifySteps)).toBeLessThan(QUERY_CEILING / 4);
	});
});
