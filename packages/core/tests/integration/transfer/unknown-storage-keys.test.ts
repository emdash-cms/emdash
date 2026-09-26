/**
 * Content can hold a media file URL whose storage key is not in the origin's
 * media table. The export keeps the URL as it is and declares it, and the
 * import plan lists that declaration among its transformations.
 */

import { sql } from "kysely";
import { afterEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import {
	analyze,
	executePlan,
	exportOrigin,
	phase,
	runImport,
	seedTarget,
	TARGET_BOB,
	uploadPackage,
} from "./pipeline.js";

const UNKNOWN_URL = "/_emdash/api/media/file/gone-01.jpg";

describeEachDialect("exporting content that refers to unknown storage keys", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	it("declares the references and imports them unchanged", { timeout: 300_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const targetStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		const title = `See ${UNKNOWN_URL} and ${UNKNOWN_URL}`;
		await sql`UPDATE ec_posts SET title = ${title} WHERE id = ${site.ids.hello}`.execute(source.db);
		await seedTarget(target.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		const exported = await exportOrigin(phase(source.db), originStorage);
		const manifest = await exported.manifest();
		expect(manifest.transformations).toContainEqual({
			code: "unknown_storage_key",
			kind: "entry",
			count: 1,
		});

		const operationId = await uploadPackage(target.db, targetStorage, exported);
		const analysis = await analyze(phase(target.db), targetStorage, operationId);
		const plan = analysis.plan!;
		expect(plan.transformations).toEqual(expect.arrayContaining(manifest.transformations));
		expect(plan.warnings.map((warning) => warning.code)).not.toContain("unknown_storage_key");

		await executePlan(target.db, targetStorage, operationId, {
			[site.ids.alice]: null,
			[site.ids.bob]: TARGET_BOB,
		});
		const result = await runImport(phase(target.db), targetStorage, operationId);
		expect(result.operation.errorDetail).toBeNull();
		expect(result.operation.state).toBe("complete");
		const row = await sql<{ title: string }>`
			SELECT title FROM ec_posts WHERE id = ${site.ids.hello}
		`.execute(target.db);
		expect(row.rows[0]?.title).toBe(title);
	});
});
