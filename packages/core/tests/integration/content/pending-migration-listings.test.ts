import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/index.js";
import { emdashLoader } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	createForDialect,
	describeEachDialect,
	runMigrationsForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("pending core migration listings", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		await runMigrationsForDialect(ctx);

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("post", {
			slug: "series",
			label: "Series",
			type: "string",
		});

		await handleContentCreate(ctx.db, "post", {
			data: { title: "Post A", series: "alpha" },
			status: "published",
		});

		// Recreate the pre-086 shape without slug or its unique constraint.
		await ctx.db.schema.dropTable("_emdash_relations").execute();
		await ctx.db.schema
			.createTable("_emdash_relations")
			.addColumn("id", "text", (c) => c.primaryKey())
			.addColumn("name", "text", (c) => c.notNull())
			.addColumn("parent_collection", "text", (c) => c.notNull())
			.addColumn("child_collection", "text", (c) => c.notNull())
			.addColumn("parent_label", "text", (c) => c.notNull())
			.addColumn("child_label", "text", (c) => c.notNull())
			.addColumn("locale", "text", (c) => c.notNull())
			.addColumn("translation_group", "text", (c) => c.notNull())
			.addColumn("created_at", "text")
			.addColumn("updated_at", "text")
			.execute();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
	});

	it("does not silently return empty listings for a custom-field sort", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection!({
				filter: { type: "post", orderBy: { series: "desc" } },
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("Post A");
		expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("where filter"));
		warnSpy.mockRestore();
	});

	it("does not silently return empty listings for a custom-field filter", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { series: "alpha" } },
			}),
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]!.data.title).toBe("Post A");
		expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("where filter"));
		warnSpy.mockRestore();
	});
});
