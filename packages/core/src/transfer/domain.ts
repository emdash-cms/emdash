/**
 * Is the target's portable domain empty enough to import into?
 *
 * Setup always applies a seed (the project's seed file or the built-in
 * default), so a brand-new site is never row-empty. The domain counts as
 * empty when it holds no content and no user-made schema: no term
 * assignments, relations, content references, bylines or byline fields,
 * media or media folders, revisions, SEO rows, comments or reactions,
 * redirects, or user sections, and only seeded collections and block types,
 * no collection with a row in its content table (trash included). Everything
 * else a seed leaves is scaffold:
 * - the seeded collections;
 * - the seeded block types (`source = 'seed'`) and their versions;
 * - taxonomy definitions attached only to those collections or to
 *   collections that do not exist, and their unassigned terms;
 * - menus and their items, widget areas and their widgets;
 * - sections with `source = 'theme'` (seeded theme sections).
 *
 * The importer's `clear_scaffold` stage deletes exactly the reported
 * `seededScaffold` items, in order: terms before their definitions, menu
 * items before menus, widgets before widget areas, and block types after the
 * collections whose fields name them.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";

export type ScaffoldItem =
	| { type: "collection"; id: string; slug: string }
	| { type: "term"; id: string; name: string; slug: string; locale: string }
	| { type: "taxonomy_def"; id: string; name: string; locale: string }
	| { type: "menu_item"; id: string; menuId: string; label: string }
	| { type: "menu"; id: string; name: string; locale: string }
	| { type: "widget"; id: string; areaId: string; widgetType: string }
	| { type: "widget_area"; id: string; name: string }
	| { type: "section"; id: string; slug: string }
	| { type: "block_type"; id: string; slug: string };

export type DomainBlocker =
	| { code: "table_not_empty"; table: string }
	| { code: "collection_not_seeded"; id: string; slug: string }
	| { code: "block_type_not_seeded"; id: string; slug: string }
	| { code: "collection_has_entries"; id: string; slug: string }
	| { code: "taxonomy_def_not_scaffold"; id: string; name: string };

export interface PortableDomainInspection {
	empty: boolean;
	seededScaffold: ScaffoldItem[];
	blockers: DomainBlocker[];
}

/** Tables that must hold no rows at all (sections are checked separately). */
const MUST_BE_EMPTY = [
	"content_taxonomies",
	"_emdash_relations",
	"_emdash_content_references",
	"_emdash_bylines",
	"_emdash_byline_fields",
	"_emdash_byline_field_values",
	"_emdash_byline_field_group_values",
	"_emdash_content_bylines",
	"media",
	"media_folders",
	"revisions",
	"_emdash_seo",
	"_emdash_comments",
	"_emdash_comment_reactions",
	"_emdash_redirects",
] as const;

function isSeededSource(source: string | null): boolean {
	return source === "seed" || (source?.startsWith("template:") ?? false);
}

function parseCollections(value: string | null): string[] | null {
	if (value === null) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return null;
		return parsed.every((item): item is string => typeof item === "string") ? parsed : null;
	} catch {
		return null;
	}
}

export async function inspectPortableDomain(
	db: Kysely<Database>,
): Promise<PortableDomainInspection> {
	const blockers: DomainBlocker[] = [];
	const seededScaffold: ScaffoldItem[] = [];

	const probes = MUST_BE_EMPTY.map(
		(table, index) => sql`(SELECT 1 FROM ${sql.ref(table)} LIMIT 1) AS ${sql.ref(`t${index}`)}`,
	);
	probes.push(
		sql`(SELECT 1 FROM _emdash_sections WHERE source <> 'theme' LIMIT 1) AS ${sql.ref("user_sections")}`,
	);
	const occupied = await sql<Record<string, unknown>>`SELECT ${sql.join(probes)}`.execute(db);
	const flags = occupied.rows[0] ?? {};
	MUST_BE_EMPTY.forEach((table, index) => {
		if (flags[`t${index}`] != null) blockers.push({ code: "table_not_empty", table });
	});
	if (flags.user_sections != null)
		blockers.push({ code: "table_not_empty", table: "_emdash_sections" });

	const collections = await db
		.selectFrom("_emdash_collections")
		.select(["id", "slug", "source"])
		.orderBy("slug")
		.execute();
	const seeded = collections.filter((collection) => isSeededSource(collection.source));
	for (const collection of collections) {
		if (!isSeededSource(collection.source)) {
			blockers.push({ code: "collection_not_seeded", id: collection.id, slug: collection.slug });
		}
	}

	if (seeded.length > 0) {
		const contentProbes = seeded.map((collection, index) => {
			validateIdentifier(collection.slug, "collection slug");
			return sql`(SELECT 1 FROM ${sql.ref(`ec_${collection.slug}`)} LIMIT 1) AS ${sql.ref(`c${index}`)}`;
		});
		const content = await sql<Record<string, unknown>>`SELECT ${sql.join(contentProbes)}`.execute(
			db,
		);
		const contentFlags = content.rows[0] ?? {};
		seeded.forEach((collection, index) => {
			if (contentFlags[`c${index}`] != null) {
				blockers.push({ code: "collection_has_entries", id: collection.id, slug: collection.slug });
			} else {
				seededScaffold.push({ type: "collection", id: collection.id, slug: collection.slug });
			}
		});
	}

	const scaffoldSlugs = new Set(
		seededScaffold.flatMap((item) => (item.type === "collection" ? [item.slug] : [])),
	);
	const existingSlugs = new Set(collections.map((collection) => collection.slug));
	const taxonomyDefs = await db
		.selectFrom("_emdash_taxonomy_defs")
		.select(["id", "name", "locale", "collections"])
		.orderBy("id")
		.execute();
	const scaffoldDefs: ScaffoldItem[] = [];
	for (const def of taxonomyDefs) {
		const attached = parseCollections(def.collections);
		if (attached?.every((slug) => scaffoldSlugs.has(slug) || !existingSlugs.has(slug))) {
			scaffoldDefs.push({ type: "taxonomy_def", id: def.id, name: def.name, locale: def.locale });
		} else {
			blockers.push({ code: "taxonomy_def_not_scaffold", id: def.id, name: def.name });
		}
	}

	const blockTypes = await db
		.selectFrom("_emdash_block_types")
		.select(["id", "slug", "source"])
		.orderBy("slug")
		.execute();
	for (const blockType of blockTypes) {
		if (blockType.source !== "seed") {
			blockers.push({ code: "block_type_not_seeded", id: blockType.id, slug: blockType.slug });
		}
	}

	// Terms, menu items, and widgets are only scaffold on a site without content;
	// on any other site the blockers already say it is not empty.
	if (blockers.length > 0) return { empty: false, seededScaffold, blockers };

	const terms = await db
		.selectFrom("taxonomies")
		.select(["id", "name", "slug", "locale"])
		.orderBy("id")
		.execute();
	for (const term of terms) {
		seededScaffold.push({
			type: "term",
			id: term.id,
			name: term.name,
			slug: term.slug,
			locale: term.locale,
		});
	}
	seededScaffold.push(...scaffoldDefs);

	const menuItems = await db
		.selectFrom("_emdash_menu_items")
		.select(["id", "menu_id", "label"])
		.orderBy("id")
		.execute();
	for (const item of menuItems) {
		seededScaffold.push({
			type: "menu_item",
			id: item.id,
			menuId: item.menu_id,
			label: item.label,
		});
	}

	const menus = await db
		.selectFrom("_emdash_menus")
		.select(["id", "name", "locale"])
		.orderBy("id")
		.execute();
	for (const menu of menus) {
		seededScaffold.push({ type: "menu", id: menu.id, name: menu.name, locale: menu.locale });
	}

	const widgets = await db
		.selectFrom("_emdash_widgets")
		.select(["id", "area_id", "type"])
		.orderBy("id")
		.execute();
	for (const widget of widgets) {
		seededScaffold.push({
			type: "widget",
			id: widget.id,
			areaId: widget.area_id,
			widgetType: widget.type,
		});
	}

	const areas = await db
		.selectFrom("_emdash_widget_areas")
		.select(["id", "name"])
		.orderBy("id")
		.execute();
	for (const area of areas)
		seededScaffold.push({ type: "widget_area", id: area.id, name: area.name });

	const sections = await db
		.selectFrom("_emdash_sections")
		.select(["id", "slug"])
		.where("source", "=", "theme")
		.orderBy("id")
		.execute();
	for (const section of sections) {
		seededScaffold.push({ type: "section", id: section.id, slug: section.slug });
	}

	for (const blockType of blockTypes) {
		seededScaffold.push({ type: "block_type", id: blockType.id, slug: blockType.slug });
	}

	return { empty: true, seededScaffold, blockers };
}
