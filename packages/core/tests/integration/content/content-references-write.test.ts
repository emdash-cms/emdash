import { expect, it } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { describeEachDialect, setupForDialect, teardownForDialect } from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

describeEachDialect("content write strips storage-less data keys", (dialect) => {
	let ctx: DialectTestContext;

	it("does not error and does not persist a reference key placed in data", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			await registry.createField("posts", {
				slug: "related",
				label: "Related",
				type: "reference",
				validation: { relation: "grp_x", targetCollection: "posts", multiple: true },
			});

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "A", related: ["should-be-ignored"] },
			});

			expect(res.success).toBe(true);
			if (res.success) {
				// The reference key must not have been written as a column value.
				expect(res.data.item.data).not.toHaveProperty("related");
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});
});
