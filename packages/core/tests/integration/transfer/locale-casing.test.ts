/**
 * A package locale that the target configures with different casing
 * (`pt-br` vs `pt-BR`) is imported under the target's casing, so the site
 * resolves its content.
 */

import { sql } from "kysely";
import { afterEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import { emdashLoader } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { analysisTargetContext } from "../../../src/transfer/analyze/target.js";
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

const LOCALE_TABLES = [
	"ec_posts",
	"taxonomies",
	"_emdash_taxonomy_defs",
	"_emdash_bylines",
	"_emdash_menus",
	"_emdash_menu_items",
] as const;

describeEachDialect("importing a locale the target spells differently", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	it("writes the target's casing", { timeout: 300_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const targetStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		for (const table of LOCALE_TABLES) {
			await sql`UPDATE ${sql.ref(table)} SET locale = 'pt-br' WHERE locale = 'fr'`.execute(
				source.db,
			);
		}
		await seedTarget(target.db);
		const i18n = { defaultLocale: "en", locales: ["en", "pt-BR"] };
		setI18nConfig(i18n);

		const exported = await exportOrigin(phase(source.db), originStorage);
		expect((await exported.manifest()).locales.used).toEqual(["en", "pt-br"]);
		const operationId = await uploadPackage(target.db, targetStorage, exported);
		const analysis = await analyze(
			phase(target.db),
			targetStorage,
			operationId,
			analysisTargetContext({ i18n, emdashVersion: "0.0.0-test" }),
		);
		expect(analysis.plan?.blockers).toEqual([]);
		await executePlan(target.db, targetStorage, operationId, {
			[site.ids.alice]: null,
			[site.ids.bob]: TARGET_BOB,
		});
		const result = await runImport(phase(target.db), targetStorage, operationId);
		expect(result.operation.errorDetail).toBeNull();
		expect(result.operation.state).toBe("complete");

		for (const table of LOCALE_TABLES) {
			const rows = await sql<{ locale: string }>`
				SELECT DISTINCT locale FROM ${sql.ref(table)} ORDER BY locale
			`.execute(target.db);
			expect(
				rows.rows.map((row) => row.locale),
				table,
			).not.toContain("pt-br");
		}
		const loaded = await runWithContext({ editMode: false, db: target.db }, () =>
			emdashLoader().loadCollection!({ filter: { type: "posts", locale: "pt-BR" } }),
		);
		expect("entries" in loaded ? loaded.entries?.map((entry) => entry.data.id) : []).toEqual([
			site.ids.bonjour,
		]);
	});

	it("blocks locales that differ only in case", { timeout: 300_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const targetStorage = createMemoryStorage();
		await buildOriginSite(source.db, originStorage);
		await sql`UPDATE ec_posts SET locale = 'FR' WHERE locale = 'fr'`.execute(source.db);
		await seedTarget(target.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		const exported = await exportOrigin(phase(source.db), originStorage);
		const operationId = await uploadPackage(target.db, targetStorage, exported);
		const analysis = await analyze(phase(target.db), targetStorage, operationId);
		expect(analysis.plan?.blockers).toContainEqual(
			expect.objectContaining({ code: "locale_not_configured", detail: { locale: "FR" } }),
		);
	});
});
