import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { importMenusFromPlugin } from "../../../src/import/menus.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("importMenusFromPlugin", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it.each([
		["team-member", "team_member"],
		["event", "events"],
		["post", "articles"],
	])(
		"links menu items for %s entries to the %s collection they were imported into",
		async (postType, collection) => {
			await new SchemaRegistry(db).createCollection({
				slug: collection,
				label: collection,
				labelSingular: collection,
			});
			await db
				.insertInto(`ec_${collection}` as never)
				.values({
					id: "entry-1",
					slug: "jane",
					status: "published",
					locale: "en",
					translation_group: "entry-1",
				} as never)
				.execute();

			await importMenusFromPlugin(
				[
					{
						id: 1,
						name: "primary",
						label: "Primary",
						items: [
							{
								id: 10,
								parent_id: null,
								sort_order: 0,
								type: "post_type",
								object: postType,
								object_id: 42,
								url: "https://wp.example/jane/",
								title: "Jane",
								target: null,
								classes: null,
							},
						],
					},
				],
				db,
				new Map([[42, "entry-1"]]),
				new Map([[42, collection]]),
			);

			const menu = await getMenuWithDb("primary", db);
			expect(menu?.items).toEqual([
				expect.objectContaining({ label: "Jane", url: `/${collection}/jane` }),
			]);
		},
	);
});
