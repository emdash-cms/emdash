import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration093 from "../../../src/database/migrations/093_menu_item_orphans.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("menu item orphans migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("092_plugin_kv_options");
		if (error) throw error;
		await ctx.db
			.insertInto("_emdash_menus")
			.values([
				{ id: "primary", name: "primary", label: "Primary" },
				{ id: "footer", name: "footer", label: "Footer" },
			])
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function item(id: string, menuId: string, parentId: string | null) {
		return { id, menu_id: menuId, parent_id: parentId, type: "custom", label: id };
	}

	async function parents() {
		const rows = await ctx.db
			.selectFrom("_emdash_menu_items")
			.select(["id", "parent_id"])
			.orderBy("id")
			.execute();
		return Object.fromEntries(rows.map((row) => [row.id, row.parent_id]));
	}

	it("moves items whose parent is in another menu to the top level", async () => {
		await ctx.db
			.insertInto("_emdash_menu_items")
			.values([
				item("root", "primary", null),
				item("child", "primary", "root"),
				item("footer-child", "footer", "root"),
			])
			.execute();

		await migration093.up(ctx.db);
		await migration093.up(ctx.db);

		expect(await parents()).toEqual({ child: "root", "footer-child": null, root: null });
	});

	// PostgreSQL's parent foreign key rules out a missing parent.
	it.skipIf(dialect === "postgres")(
		"moves items whose parent was deleted to the top level",
		async () => {
			await ctx.db
				.insertInto("_emdash_menu_items")
				.values([item("orphan", "primary", "deleted"), item("orphan-child", "primary", "orphan")])
				.execute();

			await migration093.up(ctx.db);
			await migration093.up(ctx.db);

			expect(await parents()).toEqual({ orphan: null, "orphan-child": "orphan" });
		},
	);
});
