/**
 * Regression test for #747: WordPress importer must clear the URL pattern
 * cache after creating new collections so that public routing immediately
 * resolves the new patterns. The original symptom of #747 (the execute
 * step reading a stale DB-persisted manifest) is no longer possible —
 * the manifest is built fresh per admin request and never cached — but
 * the URL pattern cache is still per-isolate, and prepare->execute
 * happens in two separate requests that may or may not share an isolate.
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
	it("invalidates the URL pattern cache after creating a new collection (regression for #747)", async () => {
		const db = await setupTestDatabase();
		const invalidateUrlPatternCache = vi.fn();

		const emdash = {
			db,
			handleContentCreate: vi.fn(),
			invalidateUrlPatternCache,
		};

		const ctx = buildContext(emdash);
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion)
		const response = await POST(ctx as any);

		expect(response.status).toBe(200);
		expect(invalidateUrlPatternCache).toHaveBeenCalledTimes(1);
	});

	it("does not invalidate the URL pattern cache when prepareImport makes no schema changes", async () => {
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

		const invalidateUrlPatternCache = vi.fn();
		const emdash = {
			db,
			handleContentCreate: vi.fn(),
			invalidateUrlPatternCache,
		};

		const ctx = buildContext(emdash);
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion)
		const response = await POST(ctx as any);

		expect(response.status).toBe(200);
		expect(invalidateUrlPatternCache).not.toHaveBeenCalled();
	});
});
