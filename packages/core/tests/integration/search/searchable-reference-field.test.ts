import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleContentList } from "../../../src/api/handlers/content.js";
import { handleSchemaFieldCreate } from "../../../src/api/handlers/schema.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

async function addFieldToSearchCollection(db: Kysely<Database>): Promise<void> {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "page", label: "Pages" });
	await registry.createCollection({ slug: "post", label: "Posts", supports: ["search"] });
	await registry.createField("post", {
		slug: "title",
		label: "Title",
		type: "string",
		searchable: true,
	});
	await new FTSManager(db).enableSearch("post");

	const field = await handleSchemaFieldCreate(db, "post", {
		slug: "related",
		label: "Related",
		type: "reference",
		searchable: true,
		validation: { targetCollection: "page" },
	});
	expect(field.success).toBe(true);
}

const SEED: SeedFile = {
	version: "1",
	collections: [
		{ slug: "page", label: "Pages", fields: [{ slug: "title", label: "Title", type: "string" }] },
		{
			slug: "post",
			label: "Posts",
			supports: ["search"],
			fields: [
				{ slug: "title", label: "Title", type: "string", searchable: true },
				{
					slug: "related",
					label: "Related",
					type: "reference",
					searchable: true,
					validation: { targetCollection: "page" },
				},
			],
		},
	],
};

// A reference field stores its values in a relation table, not an `ec_*` column.
describe("search: a reference field marked searchable", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it.each([
		["is added to a search-enabled collection", addFieldToSearchCollection],
		[
			"comes from a seed that enables search",
			(seedDb: Kysely<Database>) => applySeed(seedDb, SEED),
		],
	])("keeps the collection writable and searchable when the field %s", async (_, setUp) => {
		await setUp(db);

		await new ContentRepository(db).create({
			type: "post",
			slug: "p1",
			status: "published",
			data: { title: "Widget guide" },
		});

		const res = await searchWithDb(db, "widget");
		expect(res.items.map((item) => item.slug)).toEqual(["p1"]);

		const list = await handleContentList(db, "post", { q: "widget" });
		expect(list.success && list.data.items.map((item) => item.slug)).toEqual(["p1"]);
	});
});
