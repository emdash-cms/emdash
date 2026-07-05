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

		const { result } = await importContent(generate(items), config, emdash, manifest, undefined);

		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(2);

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
});
