import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/index.js";
import { emdashLoader } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("loader schema errors", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "website_url",
			label: "Website",
			type: "string",
		});
		const result = await handleContentCreate(ctx.db, "post", {
			data: { title: "Post", website_url: "example" },
			status: "published",
		});
		expect(result.success).toBe(true);
		await ctx.db.schema.alterTable("_emdash_bylines").dropColumn("website_url").execute();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
	});

	it.each(["none", "where", "orderBy"] as const)(
		"reports an aliased system-column error with %s caller fields",
		async (mode) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
				emdashLoader().loadCollection!({
					filter: {
						type: "post",
						...(mode === "where" ? { where: { website_url: "example" } } : {}),
						...(mode === "orderBy" ? { orderBy: { website_url: "asc" as const } } : {}),
					},
				}),
			);

			expect(result.error?.message).toContain("b.website_url");
			expect(result.entries).toBeUndefined();
			expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("where filter"));
		},
	);
});
