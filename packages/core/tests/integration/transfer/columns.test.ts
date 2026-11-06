import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { listTablesLike } from "../../../src/database/dialect-helpers.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { TransferError } from "../../../src/transfer/errors.js";
import {
	assertColumnCoverage,
	classifyTable,
	getColumnSpecs,
	listUnclassifiedColumns,
	PORTABLE_TABLES,
} from "../../../src/transfer/format/columns.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";

describeEachDialect("transfer column classification", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("classifies every table and every portable column after all migrations", async () => {
		await buildOriginSite(ctx.db, createMemoryStorage());
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "products", label: "Products", supports: ["search"] });
		await registry.createField("products", {
			slug: "name",
			label: "Name",
			type: "string",
			searchable: true,
		});
		if (dialect === "sqlite") {
			const { FTSManager } = await import("../../../src/search/fts-manager.js");
			await new FTSManager(ctx.db).enableSearch("products");
		}

		const tables = await listTablesLike(ctx.db, "%");
		const unclassified = tables.filter((table) => classifyTable(table) === "unclassified");
		expect(unclassified).toEqual([]);

		for (const spec of PORTABLE_TABLES) {
			expect(tables, spec.table).toContain(spec.table);
			await assertColumnCoverage(ctx.db, spec.table);
		}
		const contentTables = tables.filter((table) => classifyTable(table) === "content");
		expect(contentTables.toSorted()).toEqual(["ec_pages", "ec_posts", "ec_products"]);
		for (const table of contentTables) await assertColumnCoverage(ctx.db, table);
	});

	it("classifies ec_* field columns from the collection's registered fields", async () => {
		await buildOriginSite(ctx.db, createMemoryStorage());
		const specs = await getColumnSpecs(ctx.db, "ec_posts");
		expect(specs.rating).toEqual({ class: "field", property: "rating", codec: "real" });
		expect(specs.content).toEqual({ class: "field", property: "content", codec: "nativeJson" });
		expect(specs.title).toEqual({ class: "field", property: "title", codec: "text" });
		expect(specs.author_id).toEqual({
			class: "principal",
			property: "authorPrincipal",
			codec: "text",
		});
	});

	it("fails coverage when a migration adds a column nobody classified", async () => {
		await sql`ALTER TABLE _emdash_menus ADD COLUMN surprise text`.execute(ctx.db);
		expect(await listUnclassifiedColumns(ctx.db, "_emdash_menus")).toEqual(["surprise"]);
		await expect(assertColumnCoverage(ctx.db, "_emdash_menus")).rejects.toMatchObject({
			code: "TRANSFER_SCHEMA_UNCLASSIFIED",
		});
	});

	it("fails coverage for a content column that is not a registered field", async () => {
		await buildOriginSite(ctx.db, createMemoryStorage());
		await sql`ALTER TABLE ec_posts ADD COLUMN orphan_column text`.execute(ctx.db);
		await expect(assertColumnCoverage(ctx.db, "ec_posts")).rejects.toBeInstanceOf(TransferError);
	});

	it("refuses to classify a table that is not portable", async () => {
		await expect(getColumnSpecs(ctx.db, "users")).rejects.toMatchObject({
			code: "TRANSFER_SCHEMA_UNCLASSIFIED",
		});
		expect(classifyTable("some_new_table")).toBe("unclassified");
		expect(classifyTable("_emdash_transfer_operations")).toBe("nonPortable");
	});
});
