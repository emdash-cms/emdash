import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration078 from "../../../src/database/migrations/078_menu_item_translation_groups.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	runMigrationsForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("menu item translation-group migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("077_plugin_storage_revisions");
		if (error) throw error;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("backfills null groups without changing existing groups", async () => {
		await ctx.db
			.insertInto("_emdash_menus")
			.values({ id: "main", name: "main", label: "Main", translation_group: "main" })
			.execute();
		await ctx.db
			.insertInto("_emdash_menu_items")
			.values([
				{
					id: "legacy-null",
					menu_id: "main",
					parent_id: null,
					sort_order: 0,
					type: "custom",
					reference_collection: null,
					reference_id: null,
					custom_url: "/",
					label: "Home",
					title_attr: null,
					target: null,
					css_classes: null,
					translation_group: null,
				},
				{
					id: "translated-item",
					menu_id: "main",
					parent_id: null,
					sort_order: 1,
					type: "custom",
					reference_collection: null,
					reference_id: null,
					custom_url: "/about",
					label: "About",
					title_attr: null,
					target: null,
					css_classes: null,
					translation_group: "shared-about",
				},
			])
			.execute();

		const { applied } = await runMigrationsForDialect(ctx);
		expect(applied[0]).toBe("078_menu_item_translation_groups");

		await migration078.up(ctx.db);
		const rows = await ctx.db
			.selectFrom("_emdash_menu_items")
			.select(["id", "translation_group"])
			.orderBy("sort_order")
			.execute();
		expect(rows).toEqual([
			{ id: "legacy-null", translation_group: "legacy-null" },
			{ id: "translated-item", translation_group: "shared-about" },
		]);
	});
});
