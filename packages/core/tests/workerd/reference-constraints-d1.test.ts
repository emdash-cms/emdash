import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate, handleContentGet } from "../../src/api/handlers/content.js";
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

it("enforces reference constraints while preserving translation-group inheritance on D1", async () => {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "constraint_pages", label: "Pages" });
	await registry.createField("constraint_pages", { slug: "title", label: "Title", type: "string" });
	await registry.createCollection({ slug: "constraint_posts", label: "Posts" });
	await registry.createField("constraint_posts", { slug: "title", label: "Title", type: "string" });

	const relation = await new RelationRepository(db).create({
		name: "constraint_featured_page",
		parentCollection: "constraint_posts",
		childCollection: "constraint_pages",
		parentLabel: "Posts",
		childLabel: "Featured page",
	});
	await registry.createField("constraint_posts", {
		slug: "featured_page",
		label: "Featured page",
		type: "reference",
		required: true,
		validation: {
			relation: relation.translationGroup,
			targetCollection: "constraint_pages",
			multiple: false,
		},
	});

	const first = await handleContentCreate(db, "constraint_pages", { data: { title: "First" } });
	const second = await handleContentCreate(db, "constraint_pages", { data: { title: "Second" } });
	if (!first.success || !second.success) throw new Error("Child setup failed");

	const omitted = await handleContentCreate(db, "constraint_posts", { data: { title: "Omitted" } });
	expect(omitted.success).toBe(false);
	if (!omitted.success) expect(omitted.error.code).toBe("VALIDATION_ERROR");

	const source = await handleContentCreate(db, "constraint_posts", {
		data: { title: "Source" },
		references: { [relation.translationGroup]: [first.data.item.id] },
	});
	expect(source.success).toBe(true);
	if (!source.success) return;

	const tooMany = await handleReferenceChildrenSet(
		db,
		"constraint_posts",
		source.data.item.id,
		relation.translationGroup,
		[first.data.item.id, second.data.item.id],
	);
	expect(tooMany.success).toBe(false);
	if (!tooMany.success) expect(tooMany.error.code).toBe("VALIDATION_ERROR");

	const translation = await handleContentCreate(db, "constraint_posts", {
		data: { title: "Translation" },
		locale: "fr",
		translationOf: source.data.item.id,
	});
	expect(translation.success).toBe(true);
	if (!translation.success) return;

	const hydrated = await handleContentGet(db, "constraint_posts", translation.data.item.id, "fr", {
		includeDrafts: true,
	});
	expect(hydrated.success).toBe(true);
	if (!hydrated.success) return;
	const child = hydrated.data.item.references?.[relation.translationGroup]?.children[0];
	expect(child?.id).toBe(first.data.item.id);
	expect(child?.translationGroup).toBe(first.data.item.translationGroup);
});
