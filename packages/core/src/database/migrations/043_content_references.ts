import type { Kysely } from "kysely";

import { getI18nConfig } from "../../i18n/config.js";
import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Content references.
 *
 * `_emdash_relations` defines relationship types (row-per-locale, mirroring
 * `_emdash_taxonomy_defs`): which collection is the parent, which is the child
 * (the side that may multiply), and localized labels for each role.
 *
 * `_emdash_content_references` holds directed `parent → child` edges between
 * content entries. Both endpoints and the relation are referenced by
 * `translation_group`, so edges are locale-agnostic. As with
 * `content_taxonomies`, group-linking precludes SQL foreign keys; referential
 * cleanup is an application-layer concern.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const defaultLocale = getI18nConfig()?.defaultLocale ?? "en";

	await db.schema
		.createTable("_emdash_relations")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("parent_collection", "text", (c) => c.notNull())
		.addColumn("child_collection", "text", (c) => c.notNull())
		.addColumn("parent_label", "text", (c) => c.notNull())
		.addColumn("child_label", "text", (c) => c.notNull())
		.addColumn("locale", "text", (c) => c.notNull().defaultTo(defaultLocale))
		.addColumn("translation_group", "text")
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("_emdash_relations_name_locale_unique", ["name", "locale"])
		.execute();

	await db.schema
		.createIndex("idx_relations_locale")
		.on("_emdash_relations")
		.column("locale")
		.execute();
	await db.schema
		.createIndex("idx_relations_translation_group")
		.on("_emdash_relations")
		.column("translation_group")
		.execute();
	await db.schema
		.createIndex("idx_relations_parent_collection")
		.on("_emdash_relations")
		.column("parent_collection")
		.execute();
	await db.schema
		.createIndex("idx_relations_child_collection")
		.on("_emdash_relations")
		.column("child_collection")
		.execute();

	await db.schema
		.createTable("_emdash_content_references")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("relation_group", "text", (c) => c.notNull())
		.addColumn("parent_group", "text", (c) => c.notNull())
		.addColumn("child_group", "text", (c) => c.notNull())
		.addColumn("sort_order", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("content_references_unique", [
			"relation_group",
			"parent_group",
			"child_group",
		])
		.execute();

	await db.schema
		.createIndex("idx_content_references_parent")
		.on("_emdash_content_references")
		.columns(["parent_group", "relation_group", "sort_order"])
		.execute();
	await db.schema
		.createIndex("idx_content_references_child")
		.on("_emdash_content_references")
		.columns(["child_group", "relation_group"])
		.execute();
	await db.schema
		.createIndex("idx_content_references_relation")
		.on("_emdash_content_references")
		.column("relation_group")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_content_references").execute();
	await db.schema.dropTable("_emdash_relations").execute();
}
