import type { Kysely } from "kysely";
import { afterEach, expect, it } from "vitest";

import {
	handleTaxonomyCreate,
	handleTaxonomyUpdate,
} from "../../../src/api/handlers/taxonomies.js";
import { findTaxonomyStructure } from "../../../src/database/repositories/taxonomy-def.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { defaultSeed } from "../../../src/seed/default.js";
import type { SeedFile } from "../../../src/seed/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import { exportOrigin, importPackage, phase, seedTarget, TARGET_BOB } from "./pipeline.js";

describeEachDialect("taxonomy structure after a site import", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	/**
	 * Import the origin site, whose `category` is flat and attached to posts and
	 * pages, into a target seeded with `targetSeed`. `rewriteSource` changes the
	 * origin's definition rows the way an older exporting site could have left them.
	 */
	async function importOriginInto(
		options: {
			targetSeed?: SeedFile;
			rewriteSource?: (db: Kysely<Database>) => Promise<void>;
		} = {},
	) {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		const updated = await handleTaxonomyUpdate(source.db, "category", {
			hierarchical: false,
			collections: ["posts", "pages"],
		});
		expect(updated.success).toBe(true);
		await options.rewriteSource?.(source.db);
		await seedTarget(target.db, options.targetSeed);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		const result = await importPackage(
			target.db,
			createMemoryStorage(),
			await exportOrigin(phase(source.db), originStorage),
			{ principalMappings: { [site.ids.alice]: null, [site.ids.bob]: TARGET_BOB } },
		);
		expect(result.operation.errorDetail).toBeNull();
		expect(result.operation.state).toBe("complete");
		return target;
	}

	it("reads the structure the package declares for a taxonomy the target's scaffold also had", async () => {
		const { db } = await importOriginInto();

		expect(await findTaxonomyStructure(db, "category")).toMatchObject({
			hierarchical: false,
			collections: ["posts", "pages"],
		});
	});

	it("creates a taxonomy that only the target's scaffold had with the structure the request sends", async () => {
		const { db } = await importOriginInto({
			targetSeed: {
				...defaultSeed,
				taxonomies: [
					...(defaultSeed.taxonomies ?? []),
					{ name: "genre", label: "Genres", hierarchical: true, collections: ["posts"] },
				],
			},
		});

		const created = await handleTaxonomyCreate(db, {
			name: "genre",
			label: "Genres",
			hierarchical: false,
			collections: ["posts"],
		});

		expect(created.success).toBe(true);
		expect(await findTaxonomyStructure(db, "genre")).toMatchObject({
			hierarchical: false,
			collections: ["posts"],
		});
	});

	it("merges a taxonomy whose locales disagree in the package", async () => {
		const { db } = await importOriginInto({
			rewriteSource: async (sourceDb) => {
				await sourceDb
					.updateTable("_emdash_taxonomy_defs")
					.set({ hierarchical: 1, collections: JSON.stringify(["posts"]) })
					.where("name", "=", "category")
					.where("locale", "=", "en")
					.execute();
				await sourceDb
					.updateTable("_emdash_taxonomy_defs")
					.set({ hierarchical: 0, collections: JSON.stringify(["pages"]) })
					.where("name", "=", "category")
					.where("locale", "=", "fr")
					.execute();
			},
		});

		const structure = await findTaxonomyStructure(db, "category");
		expect(structure?.hierarchical).toBe(true);
		expect(structure?.collections.toSorted()).toEqual(["pages", "posts"]);
	});

	it("gives a taxonomy its own structure when the package links it to another taxonomy's group", async () => {
		const { db } = await importOriginInto({
			rewriteSource: async (sourceDb) => {
				await sourceDb
					.updateTable("_emdash_taxonomy_defs")
					.set({ translation_group: "taxdef_tag" })
					.where("name", "=", "category")
					.execute();
			},
		});

		expect(await findTaxonomyStructure(db, "category")).toMatchObject({
			hierarchical: false,
			collections: ["posts", "pages"],
		});
		expect(await findTaxonomyStructure(db, "tag")).toMatchObject({
			hierarchical: false,
			collections: ["posts"],
		});
	});
});
