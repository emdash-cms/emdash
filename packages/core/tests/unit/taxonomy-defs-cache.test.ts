import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { beforeEach, describe, it, expect, afterEach } from "vitest";

import { handleTaxonomyCreate } from "../../src/api/handlers/taxonomies.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import {
	getTaxonomyDefs,
	__setTaxonomyDefsCacheForTests,
	resetTaxonomyDefsCacheForTests,
} from "../../src/taxonomies/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

describe("taxonomy definitions isolate cache", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		resetTaxonomyDefsCacheForTests();
	});

	async function createTaxonomy(name: string, label: string) {
		const result = await handleTaxonomyCreate(db, {
			name,
			label,
			collections: ["post"],
		});
		if (!result.success) throw new Error(String(result.error?.message));
		return result.data!.taxonomy;
	}

	it("bypasses the isolate cache during a route-cache fill", async () => {
		const name = `tax_${randomUUID().replace(/-/g, "")}`;
		const fresh = await createTaxonomy(name, "Fresh Taxonomy");
		__setTaxonomyDefsCacheForTests([
			{
				id: "stale",
				name: "stale",
				label: "Stale",
				hierarchical: false,
				collections: [],
				locale: fresh.locale,
				translationGroup: null,
			},
		]);

		const defs = await runWithContext({ editMode: false, db, routeCacheFill: true }, () =>
			getTaxonomyDefs(),
		);

		const found = defs.find((d) => d.name === name);
		expect(found).toBeDefined();
		expect(found!.label).toBe("Fresh Taxonomy");
	});

	it("uses the isolate cache outside of route-cache fills", async () => {
		const name = `tax_${randomUUID().replace(/-/g, "")}`;
		await createTaxonomy(name, "Fresh Taxonomy");
		__setTaxonomyDefsCacheForTests([
			{
				id: "stale",
				name: "stale",
				label: "Stale",
				hierarchical: false,
				collections: [],
				locale: "en",
				translationGroup: null,
			},
		]);

		const defs = await runWithContext({ editMode: false, db }, () => getTaxonomyDefs());

		expect(defs).toHaveLength(1);
		expect(defs[0]!.name).toBe("stale");
	});
});
