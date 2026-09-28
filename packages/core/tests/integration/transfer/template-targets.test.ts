/**
 * A site set up from any official template, without its sample content, can
 * receive an import: everything the template's seed created is scaffold,
 * and after the import none of it is left.
 */

import { readFile } from "node:fs/promises";

import type { Kysely } from "kysely";
import { afterEach, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { inspectPortableDomain } from "../../../src/transfer/domain.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import { exportOrigin, importPackage, phase, seedTarget, TARGET_BOB } from "./pipeline.js";

const TEMPLATES = ["blog", "starter", "marketing", "portfolio"] as const;

async function templateSeed(name: string): Promise<SeedFile> {
	const url = new URL(`../../../../../templates/${name}/seed/seed.json`, import.meta.url);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the repository's own template seeds
	return JSON.parse(await readFile(url, "utf8")) as SeedFile;
}

async function presentation(db: Kysely<Database>) {
	const ids = async (
		table:
			| "_emdash_menus"
			| "_emdash_menu_items"
			| "_emdash_widget_areas"
			| "_emdash_widgets"
			| "_emdash_sections"
			| "taxonomies"
			| "_emdash_taxonomy_defs",
	) => (await db.selectFrom(table).select("id").orderBy("id").execute()).map((row) => row.id);
	return {
		collections: (
			await db.selectFrom("_emdash_collections").select("slug").orderBy("slug").execute()
		).map((row) => row.slug),
		menus: await ids("_emdash_menus"),
		menuItems: await ids("_emdash_menu_items"),
		widgetAreas: await ids("_emdash_widget_areas"),
		widgets: await ids("_emdash_widgets"),
		sections: await ids("_emdash_sections"),
		terms: await ids("taxonomies"),
		taxonomyDefs: await ids("_emdash_taxonomy_defs"),
	};
}

describeEachDialect("importing into a template site", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	for (const name of TEMPLATES) {
		it(`replaces the ${name} template's scaffold`, { timeout: 300_000 }, async () => {
			source = await setupForDialect(dialect);
			target = await setupForDialect(dialect);
			const originStorage = createMemoryStorage();
			const targetStorage = createMemoryStorage();
			const site = await buildOriginSite(source.db, originStorage);
			await seedTarget(target.db, await templateSeed(name));
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

			const domain = await inspectPortableDomain(target.db);
			expect(domain.blockers).toEqual([]);
			expect(domain.empty).toBe(true);
			const scaffoldTypes = new Set(domain.seededScaffold.map((item) => item.type));
			expect(scaffoldTypes).toContain("menu_item");

			const result = await importPackage(
				target.db,
				targetStorage,
				await exportOrigin(phase(source.db), originStorage),
				{ principalMappings: { [site.ids.alice]: null, [site.ids.bob]: TARGET_BOB } },
			);
			expect(result.operation.errorDetail).toBeNull();
			expect(result.operation.state).toBe("complete");
			expect(await presentation(target.db)).toEqual(await presentation(source.db));
		});
	}
});
