import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/handlers/content.js";
import { handleReferenceChildrenSet } from "../../src/api/handlers/relations.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { RelationRepository } from "../../src/database/repositories/relation.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: env.DB }),
	});
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

it("replaces more than sixteen reference children in order on D1", async () => {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "batch_pages", label: "Pages" });
	await registry.createField("batch_pages", { slug: "title", label: "Title", type: "string" });
	await registry.createCollection({ slug: "batch_posts", label: "Posts" });
	await registry.createField("batch_posts", { slug: "title", label: "Title", type: "string" });

	const repo = new RelationRepository(db);
	const relation = await repo.create({
		name: "batch_related_pages",
		parentCollection: "batch_posts",
		childCollection: "batch_pages",
		parentLabel: "Post",
		childLabel: "Related page",
	});
	await registry.createField("batch_posts", {
		slug: "related_pages",
		label: "Related pages",
		type: "reference",
		validation: {
			relation: relation.translationGroup,
			targetCollection: "batch_pages",
			multiple: true,
		},
	});

	const parent = await handleContentCreate(db, "batch_posts", { data: { title: "Parent" } });
	const oldChild = await handleContentCreate(db, "batch_pages", { data: { title: "Old" } });
	if (!parent.success || !oldChild.success) throw new Error("Reference fixture setup failed");

	const children = [];
	for (let index = 0; index < 17; index++) {
		const child = await handleContentCreate(db, "batch_pages", {
			data: { title: `Child ${index}` },
		});
		if (!child.success) throw new Error("Child fixture setup failed");
		children.push(child.data.item);
	}

	const seeded = await handleReferenceChildrenSet(
		db,
		"batch_posts",
		parent.data.item.id,
		relation.translationGroup,
		[oldChild.data.item.id],
	);
	expect(seeded.success).toBe(true);

	const replaced = await handleReferenceChildrenSet(
		db,
		"batch_posts",
		parent.data.item.id,
		relation.translationGroup,
		children.map((child) => child.id),
	);
	expect(replaced.success).toBe(true);

	const stored = await repo.getChildren(
		relation.translationGroup,
		parent.data.item.translationGroup,
	);
	expect(stored.map((edge) => edge.childGroup)).toEqual(
		children.map((child) => child.translationGroup),
	);
	expect(stored.map((edge) => edge.sortOrder)).toEqual(children.map((_, index) => index));
	expect(stored.some((edge) => edge.childGroup === oldChild.data.item.translationGroup)).toBe(
		false,
	);
});
