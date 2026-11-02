import { sql } from "kysely";
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

describeEachDialect("blank values in array-valued fields", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
		await registry.createField("posts", { slug: "tags", label: "Tags", type: "multiSelect" });
		await registry.createField("posts", {
			slug: "links",
			label: "Links",
			type: "repeater",
			validation: { subFields: [{ slug: "label", type: "string", label: "Label" }] },
		});
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("saves blank strings as null on create", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "p1",
			data: { title: "p1", body: "", tags: "  ", links: "" },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		const row = await sql<Record<string, unknown>>`
			SELECT body, tags, links FROM ${sql.ref("ec_posts")} WHERE id = ${result.data.item.id}
		`.execute(ctx.db);
		expect(row.rows[0]).toEqual({ body: null, tags: null, links: null });
	});

	// Postgres JSON columns reject a blank string, so only SQLite can hold one.
	it.skipIf(dialect === "postgres")(
		"saves an entry read back with a stored blank body",
		async () => {
			const created = await runtime.handleContentCreate("posts", {
				slug: "p2",
				data: { title: "p2" },
			});
			if (!created.success) throw new Error("setup failed");
			const { id } = created.data.item;
			await sql`UPDATE ${sql.ref("ec_posts")} SET body = ${""} WHERE id = ${id}`.execute(ctx.db);

			const loaded = await runtime.handleContentGet("posts", id);
			if (!loaded.success) throw new Error("load failed");
			expect(loaded.data.item.data.body).toBe("");

			const updated = await runtime.handleContentUpdate("posts", id, {
				data: { ...loaded.data.item.data, title: "p2 edited" },
			});

			expect(updated.success).toBe(true);
			if (!updated.success) return;
			expect(updated.data.item.data.body).toBeNull();
		},
	);

	it("still rejects a blank body on a required field", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createField("pages", {
			slug: "body",
			label: "Body",
			type: "portableText",
			required: true,
		});

		const result = await runtime.handleContentCreate("pages", {
			slug: "p3",
			data: { body: "" },
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.details?.issues).toContainEqual(
			expect.objectContaining({ path: "body", code: "required" }),
		);
	});
});
