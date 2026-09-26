/**
 * A `where` array longer than the parameter budget is bound as one JSON
 * parameter. The JSON table function is dialect-specific (SQLite `json_each`,
 * PostgreSQL `jsonb_array_elements_text`), so this runs on both.
 */

import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../utils/test-db.js";

describeEachDialect("loader long IN list", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "series",
			label: "Series",
			type: "string",
		});
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("filters, orders and pages a 110-value list in the database", async () => {
		const wanted: string[] = [];
		for (let i = 0; i < 130; i++) {
			const result = await handleContentCreate(ctx.db, "post", {
				data: { title: `Post ${i}`, series: `s${i}` },
				status: "published",
				publishedAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
			});
			if (!result.success) throw new Error("Failed to create post");
			if (i < 110) wanted.push(`s${i}`);
		}

		const page = await runWithContext({ editMode: false, db: ctx.db }, () =>
			emdashLoader().loadCollection!({
				filter: {
					type: "post",
					where: { series: wanted },
					orderBy: { published_at: "desc" },
					limit: 5,
					offset: 3,
				},
			}),
		);

		expect(page.error).toBeUndefined();
		expect(page.entries.map((e) => e.data.series)).toEqual([
			"s106",
			"s105",
			"s104",
			"s103",
			"s102",
		]);
	});
});
