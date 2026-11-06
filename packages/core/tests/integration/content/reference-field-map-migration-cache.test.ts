import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { getReferenceFieldMap } from "../../../src/references/field-map.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function memoryBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(store.get(key) ?? null),
		set: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			store.delete(key);
			return Promise.resolve();
		},
	};
}

async function flush(): Promise<void> {
	await waitForDeferredTasks();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describeEachDialect("reference field map migration cache", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });

		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await new RelationRepository(ctx.db).create({
			slug: "posts_pages",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Pages",
		});
		await registry.createField("posts", {
			slug: "pages",
			label: "Pages",
			type: "reference",
			validation: {
				relation: "posts_pages",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});
	});

	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownForDialect(ctx);
	});

	it("does not cache an empty map from a missing relations column", async () => {
		const relation = await ctx.db
			.selectFrom("_emdash_relations")
			.selectAll()
			.where("slug", "=", "posts_pages")
			.executeTakeFirstOrThrow();

		await ctx.db.schema.dropTable("_emdash_relations").execute();
		await ctx.db.schema
			.createTable("_emdash_relations")
			.addColumn("id", "text", (column) => column.primaryKey())
			.addColumn("name", "text", (column) => column.notNull())
			.addColumn("parent_collection", "text", (column) => column.notNull())
			.addColumn("child_collection", "text", (column) => column.notNull())
			.addColumn("parent_label", "text", (column) => column.notNull())
			.addColumn("child_label", "text", (column) => column.notNull())
			.addColumn("locale", "text", (column) => column.notNull())
			.addColumn("translation_group", "text", (column) => column.notNull())
			.addColumn("created_at", "text")
			.addColumn("updated_at", "text")
			.execute();

		const missingColumn = await runWithContext({ editMode: false, db: ctx.db }, () =>
			getReferenceFieldMap("posts"),
		);
		expect(missingColumn).toEqual(new Map());
		await flush();

		await ctx.db.schema.alterTable("_emdash_relations").addColumn("slug", "text").execute();
		await sql`
			INSERT INTO _emdash_relations
				(id, name, parent_collection, child_collection, parent_label, child_label,
				 locale, translation_group, created_at, updated_at, slug)
			VALUES (${relation.id}, ${"posts_pages"}, ${relation.parent_collection},
				${relation.child_collection}, ${relation.parent_label}, ${relation.child_label},
				${"en"}, ${relation.id}, ${relation.created_at}, ${relation.updated_at}, ${"posts_pages"})
		`.execute(ctx.db);

		const restored = await runWithContext({ editMode: false, db: ctx.db }, () =>
			getReferenceFieldMap("posts"),
		);
		expect(restored.get("pages")).toMatchObject({
			relation: "posts_pages",
			relationId: relation.id,
			targetCollection: "pages",
			side: "parent",
		});
	});
});
