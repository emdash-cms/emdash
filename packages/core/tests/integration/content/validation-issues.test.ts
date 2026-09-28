import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const VALID = { title: "Hello", starts_at: "2026-09-18T10:00:00Z", category: "news" };

function issuesOf(error: { details?: object }): unknown {
	return error.details && "issues" in error.details ? error.details.issues : undefined;
}

describeEachDialect("content validation issues", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("posts", {
			slug: "starts_at",
			label: "Starts",
			type: "datetime",
			required: true,
		});
		await registry.createField("posts", {
			slug: "category",
			label: "Category",
			type: "select",
			required: true,
			validation: { options: ["news", "guide"] },
		});
		await registry.createField("posts", {
			slug: "excerpt",
			label: "Summary",
			type: "string",
			validation: { maxLength: 5 },
		});
		await registry.createField("posts", {
			slug: "kicker",
			label: "Kicker",
			type: "string",
			validation: { minLength: 3, pattern: "^[a-z]+$" },
		});
		await registry.createField("posts", {
			slug: "reading_minutes",
			label: "Reading time",
			type: "number",
			validation: { min: 1, max: 60 },
		});
		await registry.createField("posts", {
			slug: "website",
			label: "Website",
			type: "url",
		});
		await registry.createField("posts", {
			slug: "related",
			label: "Related post",
			type: "reference",
			options: { collection: "posts" },
		});
		await registry.createField("posts", {
			slug: "body",
			label: "Body",
			type: "portableText",
		});
		await registry.createField("posts", {
			slug: "stops",
			label: "Stops",
			type: "repeater",
			validation: {
				maxItems: 1,
				subFields: [{ slug: "name", type: "string", label: "Name", required: true }],
			},
		});
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("lists each rejected field as an issue with its code and bounds", async () => {
		const result = await runtime.handleContentCreate("posts", {
			data: {
				excerpt: "too long",
				reading_minutes: 99,
				website: "not a url",
				related: "missing",
				body: [{ children: [] }],
				stops: [{ name: "" }, null],
				subtitle: "no such field",
			},
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(issuesOf(result.error)).toEqual([
			{ path: "subtitle", code: "unknown_field", message: "unknown field on collection 'posts'" },
			expect.objectContaining({ path: "title", code: "required" }),
			expect.objectContaining({ path: "starts_at", code: "required" }),
			expect.objectContaining({ path: "category", code: "required" }),
			expect.objectContaining({
				path: "excerpt",
				code: "too_big",
				origin: "string",
				maximum: 5,
			}),
			expect.objectContaining({
				path: "reading_minutes",
				code: "too_big",
				origin: "number",
				maximum: 60,
			}),
			expect.objectContaining({ path: "website", code: "invalid_format", format: "url" }),
			expect.objectContaining({ path: "body.0._type", code: "invalid_type" }),
			expect.objectContaining({ path: "stops.0.name", code: "required" }),
			expect.objectContaining({ path: "stops.1", code: "invalid_type" }),
			expect.objectContaining({ path: "stops", code: "too_big", origin: "array", maximum: 1 }),
			{
				path: "related",
				code: "reference_not_found",
				message: "target 'missing' not found in collection 'posts'",
			},
		]);
	});

	it("reports a wrong option and each failed string rule by its code", async () => {
		const result = await runtime.handleContentCreate("posts", {
			data: { ...VALID, category: "other", kicker: "AB" },
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(issuesOf(result.error)).toEqual([
			expect.objectContaining({ path: "category", code: "invalid_value" }),
			expect.objectContaining({ path: "kicker", code: "too_small", origin: "string", minimum: 3 }),
			expect.objectContaining({ path: "kicker", code: "invalid_format", format: "regex" }),
		]);
	});

	it("keeps naming every issue in the error message", async () => {
		const result = await runtime.handleContentCreate("posts", {
			data: { ...VALID, excerpt: "too long", related: "missing" },
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toBe(
			"excerpt: Too big: expected string to have <=5 characters; related: target 'missing' not found in collection 'posts'",
		);
	});

	it("reports a required field cleared on update as required", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: VALID,
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		for (const title of ["", null]) {
			const result = await runtime.handleContentUpdate("posts", created.data.item.id, {
				data: { title },
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(issuesOf(result.error)).toEqual([
				expect.objectContaining({ path: "title", code: "required" }),
			]);
		}
	});
});
