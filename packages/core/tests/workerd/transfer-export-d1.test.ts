import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import {
	validateStagedPackageStep,
	type ValidationStepResult,
} from "../../src/transfer/analyze/validate.js";
import {
	advanceExport,
	createExport,
	openExportPackage,
	type AdvanceExportResult,
} from "../../src/transfer/export/exporter.js";
import { verifyImportStep, type VerifyImportStepResult } from "../../src/transfer/export/verify.js";
import { TransferStepBudget } from "../../src/transfer/ops/budget.js";
import { fixtureId } from "../utils/transfer/golden-package.js";
import { createMemoryStorage } from "../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../utils/transfer/origin-site.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

describe("site export on D1", () => {
	let db: Kysely<Database>;

	beforeAll(() => {
		db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	});

	beforeEach(async () => {
		await resetD1Schema(db);
		await runMigrations(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("exports in small steps, passes validation, and verifies against itself", async () => {
		const storage = createMemoryStorage();
		const site = await buildOriginSite(db, storage);
		// Rows the exporter leaves out would count as unexpected target rows below.
		await db.deleteFrom("media").where("id", "=", site.ids.pendingMedia).execute();
		await db.deleteFrom("content_taxonomies").where("taxonomy_id", "=", fixtureId(1999)).execute();

		const { operation } = await createExport({ db, createdBy: "exporter" });
		let validation: ValidationStepResult | null = null;
		let result: AdvanceExportResult;
		let steps = 0;
		do {
			result = await advanceExport({
				db,
				storage,
				operationId: operation.id,
				defaultLocale: "en",
				emdashVersion: "0.0.0-test",
				budget: new TransferStepBudget({ bytes: 1 }),
				validatePackage: async (input) => {
					validation = await validateStagedPackageStep(input);
					return validation;
				},
			});
			steps++;
		} while (result.outcome === "advanced" && steps < 1000);
		expect(result.operation.errorDetail).toBeNull();
		expect(result.outcome).toBe("complete");
		expect(steps).toBeGreaterThan(20);
		expect(validation).toMatchObject({ done: true, blockers: [] });

		const reader = openExportPackage({ db, storage, operation: result.operation });
		const manifest = await reader.manifest();
		expect(manifest.records.entry?.count).toBe(6);
		const text = new TextDecoder().decode(
			await reader.stage.readBytes("records/entry/000000.ndjson", 4 * 1024 * 1024),
		);
		for (const item of site.media) expect(text).not.toContain(item.storageKey);

		let cursor: unknown = null;
		let verified: VerifyImportStepResult;
		do {
			verified = await verifyImportStep({
				db,
				storage,
				operationId: operation.id,
				reader,
				plan: {
					formatVersion: "1",
					packageDigest: await reader.digest(),
					origin: {
						siteId: manifest.originSiteId,
						packageId: manifest.packageId,
						createdAt: manifest.createdAt,
						createdByEmDashVersion: manifest.createdByEmDashVersion,
					},
					target: { siteId: manifest.originSiteId, dialect: "sqlite", emdashVersion: "0.0.0-test" },
					counts: {},
					bytes: { records: 0, media: 0 },
					principals: [],
					settings: { title: {}, tagline: {} },
					decisions: {
						principalMappings: { [site.ids.alice]: site.ids.alice, [site.ids.bob]: site.ids.bob },
						siteTitle: "package",
						siteTagline: "package",
					},
					transformations: [],
					warnings: [],
					blockers: [],
					estimatedSteps: 0,
				},
				cursor,
				budget: new TransferStepBudget({ bytes: 1 }),
			});
			if (!verified.done) cursor = verified.cursor;
		} while (!verified.done);
		expect(verified.mismatches).toEqual([]);
		expect(verified.counts.entry).toBe(6);
	});
});
