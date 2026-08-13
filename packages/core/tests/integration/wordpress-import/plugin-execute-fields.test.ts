/**
 * Regression test: import fields (seo_title, seo_description, ...) must be
 * auto-created even when the first imported item of a collection doesn't
 * carry them. The field-ensure pass used to run once per collection, gated
 * on the first item's data — a later post with a Yoast SEO override then
 * failed with `seo_title: unknown field on collection`.
 */

import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import {
	coerceToFieldType,
	ensureCustomTaxonomyDefs,
	importContent,
	type WpPluginImportConfig,
} from "../../../src/astro/routes/api/import/wordpress-plugin/execute.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import type { Database } from "../../../src/database/types.js";
import type { NormalizedItem } from "../../../src/import/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

function makeItem(overrides: Partial<NormalizedItem>): NormalizedItem {
	return {
		sourceId: 1,
		postType: "post",
		status: "publish",
		slug: "item",
		title: "Item",
		content: [],
		date: new Date("2026-01-01T00:00:00Z"),
		...overrides,
	};
}

async function* generate(items: NormalizedItem[]): AsyncGenerator<NormalizedItem> {
	for (const item of items) yield item;
}

describe("WordPress plugin import — field auto-creation", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("creates seo fields needed only by a later item", async () => {
		const config: WpPluginImportConfig = {
			postTypeMappings: { post: { collection: "post", enabled: true } },
			skipExisting: false,
		};
		// ponytail: minimal stub — importContent only touches db + handleContentCreate
		const emdash = {
			db,
			handleContentCreate: (collection: string, body: { data: Record<string, unknown> }) =>
				handleContentCreate(db, collection, body),
		} as unknown as EmDashHandlers;
		const manifest = { collections: { post: {} } } as unknown as EmDashManifest;

		const items = [
			makeItem({ sourceId: 1, slug: "plain", title: "Plain post" }),
			makeItem({
				sourceId: 2,
				slug: "with-seo",
				title: "Post with SEO",
				meta: { _yoast: { title: "Custom SEO Title", description: "Custom description" } },
			}),
		];

		const { result, contentIdMap, collectionByWpId } = await importContent(
			generate(items),
			config,
			emdash,
			manifest,
			undefined,
		);

		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(2);

		// The WP-ID maps must be populated for created items -- menus,
		// comments, and taxonomy attachment all resolve through them.
		// Regression: the route read `data.id` but the create handler
		// returns `{ item, _rev }`, so the maps stayed empty (309 comments
		// skipped on a live migration).
		expect([...contentIdMap.keys()]).toEqual([1, 2]);
		expect(collectionByWpId.get(1)).toBe("post");
		for (const id of contentIdMap.values()) {
			expect(id).toMatch(/^[0-9A-Z]{26}$/); // ULID
		}

		const row = await db
			// eslint-disable-next-line typescript/no-explicit-any -- dynamic ec_ table not in the static schema
			.selectFrom("ec_post" as any)
			.select(["slug", "seo_title", "seo_description"])
			.where("slug", "=", "with-seo")
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			seo_title: "Custom SEO Title",
			seo_description: "Custom description",
		});
	});

	it("skips SEO fields entirely when the importSeo toggle is off", async () => {
		const config: WpPluginImportConfig = {
			postTypeMappings: { post: { collection: "post", enabled: true } },
			skipExisting: false,
			importSeo: false,
		};
		const emdash = {
			db,
			handleContentCreate: (collection: string, body: { data: Record<string, unknown> }) =>
				handleContentCreate(db, collection, body),
		} as unknown as EmDashHandlers;
		const manifest = { collections: { post: {} } } as unknown as EmDashManifest;

		const items = [
			makeItem({
				sourceId: 1,
				slug: "with-seo",
				title: "Post with SEO",
				meta: { _yoast: { title: "Custom SEO Title", description: "Custom description" } },
			}),
		];

		const { result } = await importContent(generate(items), config, emdash, manifest, undefined);
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);

		// Neither the field nor the value may be created
		const field = await db
			.selectFrom("_emdash_fields")
			.select("slug")
			.where("slug", "=", "seo_title")
			.executeTakeFirst();
		expect(field).toBeUndefined();
	});
});

describe("WordPress plugin import — custom taxonomy def auto-creation", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	const term = { id: 1, name: "Term", slug: "term", description: "", parent: null, count: 1 };
	const config: WpPluginImportConfig = {
		postTypeMappings: {
			post: { collection: "post", enabled: true },
			company: { collection: "post", enabled: true },
			skipped_cpt: { collection: "old", enabled: false },
		},
		skipExisting: false,
	};

	it("creates defs for custom CPT taxonomies, scoped to mapped collections", async () => {
		const created = await ensureCustomTaxonomyDefs(
			db,
			[
				{
					name: "company",
					label: "Companies",
					label_singular: "Company",
					hierarchical: true,
					post_types: ["company", "skipped_cpt"],
					terms: [term],
				},
				// builtins and empty taxonomies must be skipped
				{ name: "category", label: "Categories", hierarchical: true, terms: [term] },
				{ name: "post_format", label: "Formats", hierarchical: false, terms: [term] },
				{ name: "empty_tax", label: "Empty", hierarchical: false, terms: [] },
				// names outside /^[a-z][a-z0-9_]*$/ stay in missingTaxonomies
				{ name: "bad-name", label: "Bad", hierarchical: false, terms: [term] },
			],
			config,
		);

		expect(created).toEqual(["company"]);

		const row = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("name", "=", "company")
			.executeTakeFirstOrThrow();
		expect(row.label).toBe("Companies");
		expect(row.label_singular).toBe("Company");
		expect(row.hierarchical).toBe(1);
		// disabled mapping (skipped_cpt -> old) must not leak into collections
		expect(JSON.parse(row.collections ?? "[]")).toEqual(["post"]);
	});

	it("is idempotent and tolerates old plugins without post_types", async () => {
		const taxonomies = [
			{ name: "plattform", label: "Plattformen", hierarchical: false, terms: [term] },
		];
		expect(await ensureCustomTaxonomyDefs(db, taxonomies, config)).toEqual(["plattform"]);
		expect(await ensureCustomTaxonomyDefs(db, taxonomies, config)).toEqual([]);

		const row = await db
			.selectFrom("_emdash_taxonomy_defs")
			.selectAll()
			.where("name", "=", "plattform")
			.executeTakeFirstOrThrow();
		// no post_types -> no collection filter ("any collection")
		expect(JSON.parse(row.collections ?? "[]")).toEqual([]);
	});
});

describe("coerceToFieldType", () => {
	it("coerces stringly-typed WP meta to the field type, drops incoercible values", () => {
		// Real-world failures from a live migration: a field inferred as
		// integer from one sample, but other posts hold strings/booleans.
		expect(coerceToFieldType("5", "integer")).toBe(5);
		expect(coerceToFieldType("abc", "integer")).toBeUndefined();
		expect(coerceToFieldType(false, "string")).toBeUndefined();
		expect(coerceToFieldType(42, "string")).toBe("42");
		expect(coerceToFieldType("2.5", "number")).toBe(2.5);
		expect(coerceToFieldType("yes", "boolean")).toBe(true);
		expect(coerceToFieldType("0", "boolean")).toBe(false);
		expect(coerceToFieldType("maybe", "boolean")).toBeUndefined();
		expect(coerceToFieldType("2026-01-02", "datetime")).toBe("2026-01-02T00:00:00.000Z");
		expect(coerceToFieldType("not a date", "datetime")).toBeUndefined();
		expect(coerceToFieldType({ a: 1 }, "json")).toEqual({ a: 1 });
		expect(coerceToFieldType("123", "image")).toBeUndefined();
	});
});
