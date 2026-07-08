/**
 * Chunked WP plugin import (issue #475): a large site is imported as a
 * loop of bounded requests instead of one giant Worker invocation. These
 * tests cover the state that must survive chunk boundaries:
 *
 * - translation groups: a translation in chunk N links to its sibling
 *   imported in chunk N-1 via the seeded translationGroup map
 * - taxonomy lookup maps: later chunks reload the plan from the DB
 *   instead of re-running term creation
 * - comment threading: a reply in comment page N threads onto its parent
 *   from page N-1 via the seeded rootIds map
 */

import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { handleTaxonomyCreate } from "../../../src/api/handlers/taxonomies.js";
import {
	importContent,
	type WpPluginImportConfig,
} from "../../../src/astro/routes/api/import/wordpress-plugin/execute.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { importCommentsFromPlugin, type PluginComment } from "../../../src/import/comments.js";
import type { NormalizedItem } from "../../../src/import/types.js";
import { loadTaxonomyPlanFromDb } from "../../../src/import/wxr-taxonomies.js";
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

function makeConfig(): WpPluginImportConfig {
	return {
		postTypeMappings: { post: { collection: "post", enabled: true } },
		skipExisting: true,
	};
}

function makeEmdash(db: Kysely<Database>): EmDashHandlers {
	// ponytail: minimal stub — importContent only touches db + handleContentCreate
	return {
		db,
		handleContentCreate: (collection: string, body: { data: Record<string, unknown> }) =>
			handleContentCreate(db, collection, body),
	} as unknown as EmDashHandlers;
}

const manifest = { collections: { post: {} } } as unknown as EmDashManifest;

describe("chunked WP plugin import — cross-chunk state", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("links translations across chunks via the seeded translationGroup map", async () => {
		const emdash = makeEmdash(db);
		const translationGroups = new Map<string, string>();

		// Chunk 1: the default-locale item establishes the group mapping.
		const first = await importContent(
			[makeItem({ sourceId: 1, slug: "hello", locale: "en", translationGroup: "g1" })],
			makeConfig(),
			emdash,
			manifest,
			undefined,
			translationGroups,
		);
		expect(first.result.imported).toBe(1);
		expect(translationGroups.get("g1")).toBeDefined();

		// Chunk 2 (separate importContent call = separate invocation): the
		// translation must link into the same group.
		const second = await importContent(
			[makeItem({ sourceId: 2, slug: "hallo", locale: "de", translationGroup: "g1" })],
			makeConfig(),
			emdash,
			manifest,
			undefined,
			translationGroups,
		);
		expect(second.result.imported).toBe(1);

		const rows = await db
			// eslint-disable-next-line typescript/no-explicit-any -- dynamic ec_ table not in the static schema
			.selectFrom("ec_post" as any)
			.select(["slug", "translation_group"])
			.where("slug", "in", ["hello", "hallo"])
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows[0]!.translation_group).toBeTruthy();
		expect(rows[0]!.translation_group).toBe(rows[1]!.translation_group);
	});

	it("rebuilds the id maps from existing content on a resumed run", async () => {
		const emdash = makeEmdash(db);
		const item = makeItem({ sourceId: 7, slug: "resumed" });

		const first = await importContent([item], makeConfig(), emdash, manifest, undefined);
		expect(first.result.imported).toBe(1);
		const originalId = first.contentIdMap.get(7);
		expect(originalId).toBeDefined();

		// Re-run (e.g. after the tab was closed): skipExisting skips the
		// insert but must still yield the mapping comments/menus need.
		const second = await importContent([item], makeConfig(), emdash, manifest, undefined);
		expect(second.result.imported).toBe(0);
		expect(second.result.skipped).toBe(1);
		expect(second.contentIdMap.get(7)).toBe(originalId);
		expect(second.collectionByWpId.get(7)).toBe("post");
	});

	it("loadTaxonomyPlanFromDb rebuilds lookup maps without creating anything", async () => {
		await handleTaxonomyCreate(db, {
			name: "company",
			label: "Companies",
			hierarchical: false,
			collections: ["post"],
		});
		const repo = new TaxonomyRepository(db);
		const term = await repo.create({ name: "company", slug: "acme", label: "ACME" });

		const plan = await loadTaxonomyPlanFromDb(db);

		expect(plan.termIdByNameAndSlug.get("company")?.get("acme")).toBe(term.id);
		expect([...(plan.collectionsByTaxonomy.get("company") ?? [])]).toEqual(["post"]);
		// Nothing was created by the loader
		expect(plan.termsCreated).toEqual({});
		expect(plan.missingTaxonomies).toEqual([]);
	});

	it("threads a reply onto a parent imported in an earlier comment chunk", async () => {
		const emdash = makeEmdash(db);
		const { contentIdMap, collectionByWpId } = await importContent(
			[makeItem({ sourceId: 10, slug: "commented" })],
			makeConfig(),
			emdash,
			manifest,
			undefined,
		);

		const parent: PluginComment = {
			id: 100,
			post_id: 10,
			parent_id: null,
			author_name: "Alice",
			author_email: "alice@example.com",
			body: "First!",
			date_gmt: "2026-01-02T10:00:00Z",
			status: "approved",
		};
		const reply: PluginComment = {
			id: 200,
			post_id: 10,
			parent_id: 100,
			author_name: "Bob",
			author_email: "bob@example.com",
			body: "Replying to Alice",
			date_gmt: "2026-01-03T10:00:00Z",
			status: "approved",
		};

		// Page 1 and page 2 as separate invocations sharing the rootIds map.
		const rootIds = new Map<number, string>();
		const page1 = await importCommentsFromPlugin(
			[parent],
			db,
			contentIdMap,
			collectionByWpId,
			rootIds,
		);
		expect(page1.imported).toBe(1);

		const page2 = await importCommentsFromPlugin(
			[reply],
			db,
			contentIdMap,
			collectionByWpId,
			rootIds,
		);
		expect(page2.imported).toBe(1);

		const rows = await db
			.selectFrom("_emdash_comments")
			.select(["author_name", "parent_id", "id"])
			.orderBy("created_at", "asc")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows[1]!.parent_id).toBe(rows[0]!.id);
	});
});
