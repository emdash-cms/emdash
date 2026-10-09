/**
 * Regression: pending core migrations must not silently empty public
 * listings that filter or sort by a custom field.
 *
 * When `_emdash_relations` exists but has not yet received its `slug` column
 * (migration 086 is pending), the reference-field map lookup in field-map.ts
 * used to throw "no such column: r.slug". The loader catch misread that as a
 * bad caller filter and returned an empty collection with a misleading
 * `[emdash] where filter:` warning.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/index.js";
import { listTableColumns } from "../../../src/database/dialect-helpers.js";
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

		// Simulate migration 086 being pending: the new code is running, but
		// `_emdash_relations` has not received its `slug` column yet. The data
		// was created under the newer schema, but the column lookup that
		// powers reference-field detection still fails the same way.
		await ctx.db.schema
			.alterTable("_emdash_relations")
			.dropColumn("slug")
			.execute()
			.catch(() => {
				// Ignore failures from missing constraints; DROP COLUMN may need
				// to also remove the unique index on some dialects.
			});
		// If dropColumn succeeded but left a dangling unique constraint,
		// recreate the table with the pre-086 shape so tests stay portable.
		const columns = await listTableColumns(ctx.db, "_emdash_relations");
		if (columns.some((c) => c.name === "slug")) {
			const tempName = "_emdash_relations_pre086";
			await ctx.db.schema.dropTable(tempName).ifExists().execute();
			await ctx.db.schema
				.createTable(tempName)
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
			await ctx.db.schema.dropTable("_emdash_relations").execute();
			await ctx.db.schema.alterTable(tempName).renameTo("_emdash_relations").execute();
		}
	});

	afterEach(async () => {
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
