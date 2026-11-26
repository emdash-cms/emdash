import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

// Parsed like a request body: `JSON.parse` makes `__proto__` an own key, so the
// row has no `source` for the url scheme check to look at.
function hiddenSourceRow(): Record<string, unknown> {
	return JSON.parse('{"label":"Weight","__proto__":{"source":"javascript:alert(1)"}}');
}

describe("Loader __proto__ keys in stored JSON", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		const registry = new SchemaRegistry(db);
		await registry.createField("post", {
			slug: "specifications",
			label: "Specifications",
			type: "repeater",
			validation: {
				subFields: [
					{ slug: "label", label: "Label", type: "string", required: true },
					{ slug: "source", label: "Source", type: "url" },
				],
			},
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function expectNoInheritedSource(rows: unknown) {
		const [row] = rows as Record<string, unknown>[];
		expect(row?.label).toBe("Weight");
		expect(row?.source).toBeUndefined();
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
	}

	it("does not turn a stored __proto__ key into the row's prototype in loadCollection", async () => {
		const createResult = await handleContentCreate(db, "post", {
			data: { title: "Scales", specifications: [hiddenSourceRow()] },
			status: "published",
		});
		if (!createResult.success) throw new Error("Failed to create post");

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post" } }),
		);

		expectNoInheritedSource(result.entries![0]!.data.specifications);
	});

	it("does not turn a stored __proto__ key into the row's prototype in loadEntry", async () => {
		const createResult = await handleContentCreate(db, "post", {
			data: { title: "Scales", specifications: [hiddenSourceRow()] },
			status: "published",
		});
		if (!createResult.success) throw new Error("Failed to create post");

		const loader = emdashLoader();
		const entry = await runWithContext({ editMode: false, db }, () =>
			loader.loadEntry!({ filter: { type: "post", id: createResult.data!.item.id } }),
		);

		expectNoInheritedSource(entry!.data.specifications);
	});

	it("does not turn a stored __proto__ key into the row's prototype in revision-backed loadEntry", async () => {
		const createResult = await handleContentCreate(db, "post", {
			data: { title: "Published", specifications: [{ label: "Weight" }] },
			status: "published",
		});
		if (!createResult.success) throw new Error("Failed to create post");

		const revisionRepo = new RevisionRepository(db);
		const revision = await revisionRepo.create({
			collection: "post",
			entryId: createResult.data!.item.id,
			data: { title: "Draft", specifications: [hiddenSourceRow()] },
		});

		const loader = emdashLoader();
		const entry = await runWithContext({ editMode: false, db }, () =>
			loader.loadEntry!({
				filter: {
					type: "post",
					id: createResult.data!.item.id,
					revisionId: revision.id,
				},
			}),
		);

		expectNoInheritedSource(entry!.data.specifications);
	});
});
