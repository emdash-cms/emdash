import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * #1133: search results should show the same title as the content list. When a
 * collection sets `titleField`, the result title comes from that field's
 * column, not the physical `title` column.
 */
describe("search: titleField drives the result title (#1133)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		const fts = new FTSManager(db);

		await registry.createCollection({
			slug: "employees",
			label: "Employees",
			supports: ["search"],
		});
		await registry.createField("employees", {
			slug: "name",
			label: "Name",
			type: "string",
			searchable: true,
		});
		await registry.createField("employees", {
			slug: "title",
			label: "Job Title",
			type: "string",
			searchable: true,
		});
		await registry.updateCollection("employees", { titleField: "name" });
		await fts.enableSearch("employees");

		const repo = new ContentRepository(db);
		await repo.create({
			type: "employees",
			slug: "amy",
			status: "published",
			data: { name: "Amy Morse", title: "Commercial Lines Agent" },
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns the titleField value as the result title, not the title column", async () => {
		const res = await searchWithDb(db, "Amy");
		const hit = res.items.find((i) => i.collection === "employees");
		expect(hit?.title).toBe("Amy Morse");
		expect(hit?.title).not.toBe("Commercial Lines Agent");
	});
});
