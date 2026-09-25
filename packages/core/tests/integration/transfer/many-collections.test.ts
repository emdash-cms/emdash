/**
 * A site with many collections exports within D1's bind-parameter limit, and
 * imports and verifies within the per-step query ceiling: verification reads
 * each entry from its own collection's table, not from every table.
 */

import { ulid } from "ulidx";
import { afterEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
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

const COLLECTIONS = 62;
const ENTRIES = 1000;
const QUERY_CEILING = 900;
const D1_BIND_LIMIT = 100;

describeEachDialect("site transfer with many collections", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	it("keeps every import step under the query ceiling", { timeout: 600_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const targetStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		const registry = new SchemaRegistry(source.db);
		const slugs = Array.from({ length: COLLECTIONS }, (_, index) => `c${index}`);
		for (const slug of slugs) {
			await registry.createCollection({ slug, label: slug });
			await registry.createField(slug, { slug: "title", label: "Title", type: "string" });
		}
		const rows = Array.from({ length: ENTRIES }, (_, index) => {
			const id = ulid();
			return {
				slug: slugs[index % COLLECTIONS]!,
				row: { id, slug: `e${index}`, status: "draft", locale: "en", translation_group: id },
			};
		});
		for (const slug of slugs) {
			const values = rows.filter((row) => row.slug === slug).map((row) => row.row);
			await source.db
				.insertInto(`ec_${slug}` as "_emdash_collections")
				.values(values as never)
				.execute();
		}
		await seedTarget(target.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		const exporting = withFaults(source.db);
		const exported = await exportOrigin(
			{ db: exporting.db, budget: () => undefined, steps: 0 },
			originStorage,
		);
		expect(exporting.faults.maxParameters).toBeLessThanOrEqual(D1_BIND_LIMIT);
		const operationId = await uploadPackage(target.db, targetStorage, exported);
		await analyze(phase(target.db), targetStorage, operationId);
		await executePlan(target.db, targetStorage, operationId, {
			[site.ids.alice]: null,
			[site.ids.bob]: TARGET_BOB,
		});

		const { db, faults } = withFaults(target.db);
		const perStep: Array<[string, number]> = [];
		for (let step = 0; step < 2000; step++) {
			const start = faults.executed;
			const budget = new TransferStepBudget({
				queryCeiling: QUERY_CEILING,
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
			perStep.push([result.operation.stage ?? "", faults.executed - start]);
			if (result.nextRequestInMs === null) {
				expect(result.operation.errorDetail).toBeNull();
				expect(result.operation.state).toBe("complete");
				break;
			}
		}
		expect(perStep.filter(([, queries]) => queries > QUERY_CEILING)).toEqual([]);
	});
});
