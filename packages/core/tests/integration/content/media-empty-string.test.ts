import { afterEach, beforeEach, expect } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("blank media field values on save", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", { slug: "attachment", label: "Attachment", type: "file" });
		await registry.createField("posts", {
			slug: "gallery",
			label: "Gallery",
			type: "repeater",
			validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
		});
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("saves blank image, file and repeater image values as null", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p1",
			data: { title: "p1", hero: "", attachment: "   ", gallery: [{ image: "" }] },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const data = result.data.item.data as Record<string, unknown>;
		expect(data.hero ?? null).toBeNull();
		expect(data.attachment ?? null).toBeNull();
		expect((data.gallery as Array<Record<string, unknown>>)[0].image).toBeNull();
	});

	it("updates an entry whose media field is blank", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "p2",
			data: { title: "p2" },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { title: "p2 edited", hero: "" },
		});
		expect(updated.success).toBe(true);
		if (!updated.success) return;
		const data = updated.data.item.data as Record<string, unknown>;
		expect(data.hero ?? null).toBeNull();
	});
});
