/**
 * Regression test for #747: WordPress importer must invalidate the manifest
 * cache after creating new collections/fields. Without this the execute
 * endpoint reads a stale DB-persisted manifest and reports
 * `Collection "<slug>" does not exist` for every item destined for a freshly
 * created collection.
 */

import { describe, expect, it, vi } from "vitest";

import { POST } from "../../../src/astro/routes/api/import/wordpress/prepare.js";
import { setupTestDatabase } from "../../utils/test-db.js";

function buildRequest(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/import/wordpress/prepare", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		body: JSON.stringify(body),
	});
}

function buildContext(emdash: any, user = { id: "test-user", role: 50 }) {
	return {
		request: buildRequest({
			postTypes: [
				{
					name: "tablepress_table",
					collection: "tablepress_table",
					fields: [{ slug: "title", label: "Title", type: "string", required: true }],
				},
			],
		}),
		locals: { emdash, user },
	};
}

describe("POST /api/import/wordpress/prepare", () => {
	it("invalidates the manifest cache after creating a new collection (regression for #747)", async () => {
		const db = await setupTestDatabase();
		const invalidateManifest = vi.fn();

		const emdash = {
			db,
			handleContentCreate: vi.fn(),
			invalidateManifest,
		};

		const ctx = buildContext(emdash);
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion)
		const response = await POST(ctx as any);

		expect(response.status).toBe(200);
		expect(invalidateManifest).toHaveBeenCalledTimes(1);
	});

	it("does not invalidate the manifest when prepareImport makes no schema changes", async () => {
		const db = await setupTestDatabase();
		// Pre-create the collection so prepare finds nothing new to do.
		const { SchemaRegistry } = await import("../../../src/schema/registry.js");
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "tablepress_table",
			label: "Tablepress Tables",
			labelSingular: "Tablepress Table",
		});
		await registry.createField("tablepress_table", {
			slug: "title",
			label: "Title",
			type: "string",
		});

		const invalidateManifest = vi.fn();
		const emdash = {
			db,
			handleContentCreate: vi.fn(),
			invalidateManifest,
		};

		const ctx = buildContext(emdash);
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion)
		const response = await POST(ctx as any);

		expect(response.status).toBe(200);
		expect(invalidateManifest).not.toHaveBeenCalled();
	});
});
