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

const requiredValues = {
	name: "First row",
	details: "Required details",
};

const invalidRepeaterValues: Array<{ name: string; rows: unknown[] }> = [
	{ name: "below minItems", rows: [] },
	{
		name: "above maxItems",
		rows: [requiredValues, requiredValues, requiredValues],
	},
	{
		name: "missing a required nested key",
		rows: [{ name: "Missing details" }],
	},
	{
		name: "containing a blank required nested string",
		rows: [{ name: "", details: "Present" }],
	},
	{
		name: "containing blank required nested text",
		rows: [{ name: "Present", details: "" }],
	},
	{
		name: "containing the wrong nested type",
		rows: [{ ...requiredValues, count: "two" }],
	},
];

const validRows = [
	{
		...requiredValues,
		website: "https://example.com",
		amount: 1.5,
		count: 2,
		active: true,
		startsAt: "2026-08-13T12:00:00Z",
		category: "news",
		futureField: { preserved: true },
	},
	{
		name: "Optional values",
		details: "May be omitted or null",
		website: null,
		count: null,
	},
];

describeEachDialect("repeater runtime validation", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", {
			slug: "rows",
			label: "Rows",
			type: "repeater",
			required: true,
			validation: {
				minItems: 1,
				maxItems: 2,
				subFields: [
					{ slug: "name", type: "string", label: "Name", required: true },
					{ slug: "details", type: "text", label: "Details", required: true },
					{ slug: "website", type: "url", label: "Website" },
					{ slug: "amount", type: "number", label: "Amount" },
					{ slug: "count", type: "integer", label: "Count" },
					{ slug: "active", type: "boolean", label: "Active" },
					{ slug: "startsAt", type: "datetime", label: "Starts at" },
					{
						slug: "category",
						type: "select",
						label: "Category",
						options: ["news", "guide"],
					},
				],
			},
		});
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it.each(invalidRepeaterValues)("rejects create values $name", async ({ rows }) => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "invalid-create",
			data: { rows },
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it.each(invalidRepeaterValues)("rejects update values $name", async ({ rows }) => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "update-target",
			data: { rows: [requiredValues] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const result = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { rows },
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("accepts valid create values, nullish optional fields, and unknown row keys", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "valid-create",
			data: { rows: validRows },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.data.rows).toEqual(validRows);
	});

	it("accepts valid update values, omitted optional fields, and unknown row keys", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "valid-update",
			data: { rows: [requiredValues] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const result = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { rows: validRows },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.data.rows).toEqual(validRows);
	});
});
