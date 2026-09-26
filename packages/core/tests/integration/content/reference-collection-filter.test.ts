/**
 * Filtering or sorting a collection by a reference field.
 *
 * A field bound to a relation has no column to compare, so the query it builds
 * cannot run. What matters is that the caller is told which field is at fault
 * rather than handed a collection that reads as empty — a template asking for
 * "this author's posts" would otherwise render "no posts" forever.
 */

import { afterEach, beforeEach, expect, it } from "vitest";

import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { emdashLoader } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createLegacyReferenceField } from "../../utils/legacy-reference-field.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("collection filters on a reference field", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "authors", label: "Authors", labelSingular: "Author" });
		await registry.createField("authors", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "featured", label: "Featured", type: "boolean" });

		await new RelationRepository(ctx.db).create({
			slug: "post_author",
			parentCollection: "posts",
			childCollection: "authors",
			parentLabel: "Author",
			childLabel: "Posts",
		});
		await registry.createField("posts", {
			slug: "author",
			label: "Author",
			type: "reference",
			validation: {
				relation: "post_author",
				relationSide: "parent",
				targetCollection: "authors",
			},
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function load(filter: Record<string, unknown>) {
		const loader = emdashLoader();
		return runWithContext({ editMode: false, db: ctx.db }, () =>
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- loader filter shape
			loader.loadCollection({ filter } as never),
		);
	}

	it("refuses a where filter on a bound reference field, naming it", async () => {
		const result = await load({ type: "posts", where: { author: "author-id" } });

		expect(result.error?.message).toContain("author");
		expect(result.entries).toBeUndefined();
	});

	it("refuses an orderBy on a bound reference field", async () => {
		const result = await load({ type: "posts", orderBy: { author: "asc" } });

		expect(result.error?.message).toContain("author");
	});

	it("refuses a where filter on a field bound after its column was created", async () => {
		// Migration 084 binds a pre-relations field and leaves its column in
		// place. The query still runs, so nothing would report the mismatch —
		// it would just answer from values the field stopped writing.
		await createLegacyReferenceField(ctx.db, "posts", "editor", { targetCollection: "authors" });
		await new RelationRepository(ctx.db).create({
			slug: "post_editor",
			parentCollection: "posts",
			childCollection: "authors",
			parentLabel: "Editor",
			childLabel: "Edited posts",
		});
		await ctx.db
			.updateTable("_emdash_fields")
			.set({
				validation: JSON.stringify({
					relation: "post_editor",
					relationSide: "parent",
					targetCollection: "authors",
				}),
			})
			.where("slug", "=", "editor")
			.execute();

		const result = await load({ type: "posts", where: { editor: "author-id" } });

		expect(result.error?.message).toContain("editor");
	});

	it("still filters and sorts by a field that owns a column", async () => {
		const result = await load({
			type: "posts",
			where: { featured: true },
			orderBy: { title: "asc" },
		});

		expect(result.error).toBeUndefined();
		expect(result.entries).toEqual([]);
	});
});
