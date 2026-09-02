import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate, handleContentList } from "../../../src/api/handlers/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// The server-side content-list `q` filter must match against a
// configured `titleField`, not just the conventional `title`/`name` fields.
// Otherwise searching a collection whose title comes from e.g. `full_name`
// can't find an entry by the title the admin actually renders.
describeEachDialect("content list search honours a custom titleField", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "employees",
			label: "Employees",
			labelSingular: "Employee",
		});
		await registry.createField("employees", {
			slug: "full_name",
			label: "Full name",
			type: "string",
		});
		await registry.updateCollection("employees", { titleField: "full_name" });

		// Seed enough rows that the needle sits past the first page, so a match
		// can only come from the server-side filter, not client-side paging.
		for (let i = 0; i < 60; i++) {
			const created = await handleContentCreate(ctx.db, "employees", {
				slug: `employee-${String(i).padStart(3, "0")}`,
				data: { full_name: `John Doe ${i}` },
			});
			if (!created.success) throw new Error("seed failed");
		}
		const needle = await handleContentCreate(ctx.db, "employees", {
			slug: "the-needle-employee",
			data: { full_name: "Jane Doe" },
		});
		if (!needle.success) throw new Error("needle seed failed");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function namesOf(result: {
		success: boolean;
		data?: { items: { data: Record<string, unknown> }[] };
	}) {
		if (!result.success || !result.data) throw new Error("list failed");
		return result.data.items.map((i) => i.data.full_name as string);
	}

	it("finds an entry by its titleField value, past the first page", async () => {
		const result = await handleContentList(ctx.db, "employees", { q: "Jane", limit: 20 });
		expect(namesOf(result)).toContain("Jane Doe");
	});

	it("matches the titleField case-insensitively", async () => {
		const result = await handleContentList(ctx.db, "employees", { q: "jane", limit: 20 });
		expect(namesOf(result)).toContain("Jane Doe");
	});
});
