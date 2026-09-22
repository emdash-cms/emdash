import { afterEach, beforeEach, expect, it } from "vitest";

import { mapErrorStatus } from "../../../src/api/errors.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("unsupported field type write guard", (dialect) => {
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
		});
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("keeps reads available while rejecting creates and updates for an unknown top-level type", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "existing",
			data: { title: "Original" },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		await ctx.db
			.updateTable("_emdash_fields")
			.set({ type: "future_blocks" })
			.where("slug", "=", "title")
			.execute();

		const read = await runtime.handleContentGet("posts", created.data.item.id);
		expect(read.success).toBe(true);
		if (read.success) expect(read.data.item.data.title).toBe("Original");

		const update = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { title: "Overwritten" },
		});
		expect(update).toMatchObject({
			success: false,
			error: { code: "UNSUPPORTED_FIELD_TYPE" },
		});
		if (!update.success) expect(mapErrorStatus(update.error.code)).toBe(409);

		const create = await runtime.handleContentCreate("posts", {
			slug: "new",
			data: { title: "New" },
		});
		expect(create).toMatchObject({
			success: false,
			error: { code: "UNSUPPORTED_FIELD_TYPE" },
		});

		const unchanged = await runtime.handleContentGet("posts", created.data.item.id);
		expect(unchanged.success).toBe(true);
		if (unchanged.success) expect(unchanged.data.item.data.title).toBe("Original");
	});

	it("rejects writes when a repeater contains an unknown nested type", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("posts", {
			slug: "sections",
			label: "Sections",
			type: "repeater",
			validation: {
				subFields: [{ slug: "heading", label: "Heading", type: "string" }],
			},
		});
		await ctx.db
			.updateTable("_emdash_fields")
			.set({
				validation: JSON.stringify({
					subFields: [{ slug: "heading", label: "Heading", type: "future_nested" }],
				}),
			})
			.where("slug", "=", "sections")
			.execute();

		const result = await runtime.handleContentCreate("posts", {
			slug: "new",
			data: { title: "New", sections: [] },
		});

		expect(result).toMatchObject({
			success: false,
			error: { code: "UNSUPPORTED_FIELD_TYPE" },
		});
	});
});
