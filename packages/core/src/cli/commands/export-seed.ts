/**
 * emdash export-seed
 *
 * Export current database schema (and optionally content) as a seed file
 */

import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import { createDatabase } from "../../database/connection.js";
import { getExactMigrationStatus } from "../../database/migrations/runner.js";
import { BylineRepository } from "../../database/repositories/byline.js";
import { ContentRepository } from "../../database/repositories/content.js";
import { MediaRepository } from "../../database/repositories/media.js";
import { OptionsRepository } from "../../database/repositories/options.js";
import {
	parseTaxonomyCollections,
	selectTaxonomyDefs,
} from "../../database/repositories/taxonomy-def.js";
import { TaxonomyRepository } from "../../database/repositories/taxonomy.js";
import type { ContentItem } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import { getI18nConfig, isI18nEnabled } from "../../i18n/config.js";
import { BlockTypeRegistry } from "../../schema/block-type-registry.js";
import { SchemaRegistry } from "../../schema/registry.js";
import type { FieldType } from "../../schema/types.js";
import type {
	SeedFile,
	SeedCollection,
	SeedField,
	SeedRelation,
	SeedTaxonomy,
	SeedTaxonomyTerm,
	SeedMenu,
	SeedMenuItem,
	SeedRedirect,
	SeedSection,
	SeedWidgetArea,
	SeedWidget,
	SeedContentEntry,
	SeedByline,
	SeedBylineCredit,
	SeedBlockType,
} from "../../seed/types.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { slugify } from "../../utils/slugify.js";

const SETTINGS_PREFIX = "site:";

const TRAILING_SLASHES = /\/+$/;

export const exportSeedCommand = defineCommand({
	meta: {
		name: "export-seed",
		description: "Export database schema and content as a seed file",
	},
	args: {
		database: {
			type: "string",
			alias: "d",
			description: "Database path",
			default: "./data.db",
		},
		cwd: {
			type: "string",
			description: "Working directory",
			default: process.cwd(),
		},
		"with-content": {
			type: "string",
			description: "Include content (all or comma-separated collection names)",
			required: false,
		},
		pretty: {
			type: "boolean",
			description: "Pretty print JSON output",
			default: true,
		},
		"media-base-url": {
			type: "string",
			description: "Public URL of the site, used to write absolute media URLs",
			required: false,
		},
	},
	async run({ args }) {
		const cwd = resolve(args.cwd);

		// Connect to database
		const dbPath = resolve(cwd, args.database);
		// The seed document is this command's stdout payload, so anything else
		// written there corrupts `emdash export-seed > seed.json`. Diagnostics
		// go to stderr, where a redirect leaves them visible.
		process.stderr.write(`Database: ${dbPath}\n`);

		const db = createDatabase({ url: `file:${dbPath}`, readOnly: true });

		try {
			const { pending, unknownApplied } = await getExactMigrationStatus(db);
			if (unknownApplied.length > 0) {
				throw new Error(
					"The database was migrated by a newer EmDash version. Upgrade EmDash before exporting it.",
				);
			}
			if (pending.length > 0) {
				throw new Error(
					`The database has ${pending.length} pending migration${pending.length === 1 ? "" : "s"}. Run \`emdash migrate\` before exporting it.`,
				);
			}
		} catch (error) {
			consola.error("Export requires a current database schema:", error);
			await db.destroy();
			process.exit(1);
		}

		try {
			const seed = await exportSeed(db, args["with-content"], {
				mediaBaseUrl: args["media-base-url"],
				warn: (message) => process.stderr.write(`Warning: ${message}\n`),
			});

			// Output to stdout
			const output = args.pretty ? JSON.stringify(seed, null, "\t") : JSON.stringify(seed);

			console.log(output);
		} catch (error) {
			consola.error("Export failed:", error);
			await db.destroy();
			process.exit(1);
		}

		await db.destroy();
	},
});

export interface ExportSeedOptions {
	/**
	 * Public origin (optionally with a base path) of the site the database
	 * belongs to. `$media` URLs are written relative to it; without it they are
	 * site-relative paths, which `applySeed` cannot download.
	 */
	mediaBaseUrl?: string;
	/** Receives messages about data the seed cannot carry. */
	warn?: (message: string) => void;
}

/**
 * Export database to seed file format
 */
export async function exportSeed(
	db: Kysely<Database>,
	withContent?: string,
	options: ExportSeedOptions = {},
): Promise<SeedFile> {
	const warn = options.warn ?? (() => {});
	const mediaUrlPrefix = mediaFileUrlPrefix(options.mediaBaseUrl);

	const seed: SeedFile = {
		$schema: "https://emdashcms.com/seed.schema.json",
		version: "1",
		meta: {
			name: "Exported Seed",
			description: "Exported from existing EmDash database",
		},
	};

	// 1. Export settings
	seed.settings = await exportSettings(db);

	// 2. Export block types before collections that reference them
	seed.blockTypes = await exportBlockTypes(db);

	// 3. Export collections and fields
	seed.collections = await exportCollections(db);

	// 3. Export the relations reference fields bind to. Emitted even when no
	// field binds one: a relation outlives the fields that viewed it.
	const relations = await exportRelations(db);
	if (relations.length > 0) {
		seed.relations = relations;
	}

	// Decide locale-awareness from the data. The runtime sets the i18n config via
	// middleware, but the CLI never does, so `isI18nEnabled()` is always false
	// under `emdash export-seed`. Detecting multiple locales in the data
	// keeps the export locale-aware without the runtime flag.
	const { i18nEnabled, defaultLocale } = await detectLocaleInfo(db, seed.collections);

	// Self-describe the default locale so a non-`en` single-locale project
	// survives the round-trip: `emdash seed` runs outside the runtime and would
	// otherwise backfill omitted locales as `en`.
	if (defaultLocale) seed.defaultLocale = defaultLocale;

	// 4. Export taxonomy definitions and terms
	seed.taxonomies = await exportTaxonomies(db, i18nEnabled);

	// Byline profiles. The returned map (translation_group -> seed-local id)
	// lets content credits reference the same ids the root list emits.
	const { bylines, groupToSeedId } = await exportBylines(db);

	// Content is read before menus so menu items can name their targets by
	// seed id.
	let exportedContent: ExportedContent | undefined;
	if (withContent !== undefined) {
		// Treat "all" as a synonym for the bare flag and "true". The args help
		// text documents `all` as a valid value, but without this the literal
		// string is read as a collection name and matches no collection.
		const includeAll = withContent === "" || withContent === "true" || withContent === "all";
		const collections = includeAll
			? null // all collections
			: withContent
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);

		exportedContent = await exportContent(
			db,
			seed.collections || [],
			collections,
			groupToSeedId,
			i18nEnabled,
			mediaUrlPrefix,
		);
	}

	seed.menus = await exportMenus(db, i18nEnabled, exportedContent?.groupSeedIds ?? new Map());

	const redirects = await exportRedirects(db, warn);
	if (redirects.length > 0) {
		seed.redirects = redirects;
	}

	seed.widgetAreas = await exportWidgetAreas(db);

	const sections = await exportSections(db, warn);
	if (sections.length > 0) {
		seed.sections = sections;
	}

	if (bylines.length > 0) {
		seed.bylines = bylines;
	}

	if (exportedContent) {
		seed.content = exportedContent.content;
		if (exportedContent.mediaCount > 0 && !options.mediaBaseUrl) {
			warn(
				`${exportedContent.mediaCount} media reference(s) use site-relative URLs, which \`emdash seed\` cannot download. Pass --media-base-url with the site's public URL to make them importable.`,
			);
		}
	}

	return seed;
}

const MEDIA_FILE_PATH = "/_emdash/api/media/file/";

/**
 * Prefix for `$media` URLs: the site's base URL (without a trailing slash)
 * plus the public media route, or the bare route when no base is given.
 */
function mediaFileUrlPrefix(mediaBaseUrl: string | undefined): string {
	if (mediaBaseUrl === undefined) return MEDIA_FILE_PATH;
	let base: URL;
	try {
		base = new URL(mediaBaseUrl);
	} catch {
		throw new Error(`Invalid media base URL: ${mediaBaseUrl}`);
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error(`Media base URL must use http or https: ${mediaBaseUrl}`);
	}
	return `${base.origin}${base.pathname.replace(TRAILING_SLASHES, "")}${MEDIA_FILE_PATH}`;
}

/**
 * Export byline profiles as root-level `bylines[]`.
 *
 * `SeedByline` has no locale axis, so locale siblings of the same byline
 * (sharing a `translation_group`) collapse to a single profile. The returned
 * `groupToSeedId` map keys on `translation_group` — the value stored in
 * `_emdash_content_bylines.byline_id` — so content credits can resolve to the
 * emitted seed id.
 */
async function exportBylines(
	db: Kysely<Database>,
): Promise<{ bylines: SeedByline[]; groupToSeedId: Map<string, string> }> {
	const bylineRepo = new BylineRepository(db);
	const bylines: SeedByline[] = [];
	const groupToSeedId = new Map<string, string>();
	const usedSeedIds = new Set<string>();

	let cursor: string | undefined;
	do {
		const result = await bylineRepo.findMany({ limit: 100, cursor });
		for (const byline of result.items) {
			const group = byline.translationGroup ?? byline.id;
			// One seed entry per translation group; first row seen wins.
			if (groupToSeedId.has(group)) continue;

			let seedId = `byline:${byline.slug}`;
			// Disambiguate the rare case of two distinct groups sharing a slug
			// (slug is unique per-locale, not globally) so seed ids stay unique.
			if (usedSeedIds.has(seedId)) seedId = `byline:${byline.slug}:${group}`;
			usedSeedIds.add(seedId);
			groupToSeedId.set(group, seedId);

			bylines.push({
				id: seedId,
				slug: byline.slug,
				displayName: byline.displayName,
				bio: byline.bio || undefined,
				websiteUrl: byline.websiteUrl || undefined,
				isGuest: byline.isGuest || undefined,
			});
		}
		cursor = result.nextCursor;
	} while (cursor);

	return { bylines, groupToSeedId };
}

/**
 * Determine locale-awareness and the data's default locale for the export.
 *
 * The runtime initializes the i18n config in middleware, but the CLI never does,
 * so `isI18nEnabled()` is always false under `emdash export-seed`. When
 * the flag is unset, fall back to the data: a project is multi-locale when its
 * i18n-aware tables hold rows in more than one distinct locale. `locale` is
 * NOT NULL (defaulting to the site's default locale), so a per-row presence
 * check is not enough — only the *count* of distinct locales distinguishes a
 * genuinely single-locale project from a multi-locale one. This keeps
 * single-locale exports on bare ids and gives multi-locale exports the
 * per-locale suffix they need to avoid duplicate seed ids.
 *
 * `defaultLocale` self-describes the single-locale case so a non-`en` default
 * survives the round-trip. When more than one locale is present every
 * row already carries its own `locale`, so no fallback is needed and we leave it
 * undefined rather than guess which locale is the "default" without the runtime
 * config.
 */
async function detectLocaleInfo(
	db: Kysely<Database>,
	collections: SeedCollection[],
): Promise<{ i18nEnabled: boolean; defaultLocale: string | undefined }> {
	const config = getI18nConfig();
	if (isI18nEnabled() && config) {
		return { i18nEnabled: true, defaultLocale: config.defaultLocale };
	}

	const locales = new Set<string>();
	const collectDistinctLocales = async (tableRef: ReturnType<typeof sql.ref>): Promise<void> => {
		const result = await sql<{ locale: string | null }>`
			SELECT DISTINCT locale FROM ${tableRef}
		`.execute(db);
		for (const row of result.rows) {
			if (row.locale) locales.add(row.locale);
		}
	};

	await collectDistinctLocales(sql.ref("_emdash_taxonomy_defs"));
	await collectDistinctLocales(sql.ref("_emdash_menus"));

	for (const collection of collections) {
		validateIdentifier(collection.slug, "collection slug");
		// On D1, deleteCollection is non-atomic, so a collection row can outlive
		// its ec_* table. Skip missing tables rather than crashing the export.
		try {
			await collectDistinctLocales(sql.ref(`ec_${collection.slug}`));
		} catch (error) {
			if (!isMissingTableError(error)) throw error;
		}
	}

	return {
		i18nEnabled: locales.size > 1,
		defaultLocale: locales.size === 1 ? [...locales][0] : undefined,
	};
}

/**
 * Export site settings
 */
async function exportSettings(db: Kysely<Database>): Promise<SeedFile["settings"]> {
	const options = new OptionsRepository(db);
	const allOptions = await options.getByPrefix(SETTINGS_PREFIX);

	const settings: Record<string, unknown> = {};
	for (const [key, value] of allOptions) {
		const settingKey = key.replace(SETTINGS_PREFIX, "");
		settings[settingKey] = value;
	}

	return Object.keys(settings).length > 0 ? settings : undefined;
}

async function exportBlockTypes(db: Kysely<Database>): Promise<SeedBlockType[]> {
	const blockTypes = await new BlockTypeRegistry(db).listBlockTypes();
	return blockTypes.map((blockType) => ({
		slug: blockType.slug,
		label: blockType.label,
		description: blockType.description,
		icon: blockType.icon,
		category: blockType.category,
		currentVersion: blockType.currentVersion,
		versions: blockType.versions.map((version) => ({
			version: version.version,
			fields: version.fields,
		})),
	}));
}

/**
 * Export collections and their fields
 */
async function exportCollections(db: Kysely<Database>): Promise<SeedCollection[]> {
	const registry = new SchemaRegistry(db);
	const collections = await registry.listCollections();
	const result: SeedCollection[] = [];

	for (const collection of collections) {
		const fields = await registry.listFields(collection.id);

		const seedCollection: SeedCollection = {
			slug: collection.slug,
			label: collection.label,
			labelSingular: collection.labelSingular || undefined,
			description: collection.description || undefined,
			icon: collection.icon || undefined,
			admin: collection.admin,
			supports: collection.supports.length > 0 ? collection.supports : undefined,
			urlPattern: collection.urlPattern || undefined,
			routable: collection.routable === false ? false : undefined,
			editLocking: collection.editLocking === false ? false : undefined,
			hidden: collection.hidden || undefined,
			sortOrder: collection.sortOrder,
			group: collection.group,
			commentsEnabled: collection.commentsEnabled || undefined,
			titleField: collection.titleField,
			dateField: collection.dateField,
			fields: fields.map(
				(field): SeedField => ({
					slug: field.slug,
					label: field.label,
					type: field.type,
					required: field.required || undefined,
					unique: field.unique || undefined,
					searchable: field.searchable || undefined,
					indexed: field.indexed || undefined,
					translatable: field.translatable === false ? false : undefined,
					defaultValue: field.defaultValue,
					validation: field.validation ? { ...field.validation } : undefined,
					widget: field.widget || undefined,
					options: field.options || undefined,
				}),
			),
		};

		result.push(seedCollection);
	}

	return result;
}

/**
 * Export relations as root-level `relations[]`.
 *
 * A reference field's `validation.relation` names a relation by slug, and the
 * field's validation is exported verbatim, so re-applying the seed binds the
 * field to this relation rather than creating another one.
 */
async function exportRelations(db: Kysely<Database>): Promise<SeedRelation[]> {
	const rows = await db
		.selectFrom("_emdash_relations")
		.select([
			"slug",
			"parent_collection",
			"child_collection",
			"parent_label",
			"parent_label_singular",
			"child_label",
			"child_label_singular",
			"max_children_per_parent",
			"max_parents_per_child",
		])
		.orderBy("slug", "asc")
		.execute();

	return rows.map((row) => ({
		slug: row.slug,
		parentCollection: row.parent_collection,
		childCollection: row.child_collection,
		parentLabel: row.parent_label,
		parentLabelSingular: row.parent_label_singular ?? undefined,
		childLabel: row.child_label,
		childLabelSingular: row.child_label_singular ?? undefined,
		maxChildrenPerParent: row.max_children_per_parent,
		maxParentsPerChild: row.max_parents_per_child,
	}));
}

/**
 * Export taxonomy definitions and terms
 */
async function exportTaxonomies(
	db: Kysely<Database>,
	i18nEnabled: boolean,
): Promise<SeedTaxonomy[]> {
	// Mirrors the content export pattern: one entry per (name, locale), stable
	// seed-local id, translations linked via `translationOf` to the anchor's id.
	const defs = await selectTaxonomyDefs(db)
		// Chained, not `orderBy(["name", "locale"])`: kysely deprecated the array
		// form and announces it with `console.log`, which lands in the seed
		// document this command writes to stdout.
		.orderBy("d.name")
		.orderBy("d.locale")
		.execute();

	const result: SeedTaxonomy[] = [];
	const termRepo = new TaxonomyRepository(db);

	// Taxonomy name -> seed-local id of the first def emitted for it. Every locale
	// of a name is one taxonomy, whatever translation_group its rows carry.
	const anchorByName = new Map<string, string>();

	for (const def of defs) {
		const defSeedId =
			i18nEnabled && def.locale ? `tax:${def.name}:${def.locale}` : `tax:${def.name}`;

		// Terms in this def's locale.
		const terms = await termRepo.findByName(def.name, { locale: def.locale });

		// translation_group -> slug for parent resolution within this locale.
		// `parentId` stores the parent's translation_group, not a row id.
		const groupToSlug = new Map<string, string>();
		for (const term of terms) groupToSlug.set(term.translationGroup ?? term.id, term.slug);

		// translation_group -> seed id of the anchor term.
		const termGroupToSeedId = new Map<string, string>();

		const seedTerms: SeedTaxonomyTerm[] = [];
		for (const term of terms) {
			const termSeedId =
				i18nEnabled && term.locale
					? `term:${def.name}:${term.slug}:${term.locale}`
					: `term:${def.name}:${term.slug}`;

			const seedTerm: SeedTaxonomyTerm = {
				id: termSeedId,
				slug: term.slug,
				label: term.label,
				description: typeof term.data?.description === "string" ? term.data.description : undefined,
			};

			if (term.parentId) seedTerm.parent = groupToSlug.get(term.parentId);

			if (i18nEnabled && term.locale) {
				seedTerm.locale = term.locale;
				if (term.translationGroup) {
					const anchor = termGroupToSeedId.get(term.translationGroup);
					if (anchor) seedTerm.translationOf = anchor;
					else termGroupToSeedId.set(term.translationGroup, termSeedId);
				}
			}

			seedTerms.push(seedTerm);
		}

		// Anchors first so import can resolve `translationOf`.
		seedTerms.sort((a, b) => Number(!!a.translationOf) - Number(!!b.translationOf));

		const taxonomy: SeedTaxonomy = {
			id: defSeedId,
			name: def.name,
			label: def.label,
			labelSingular: def.label_singular || undefined,
		};

		if (i18nEnabled && def.locale) {
			taxonomy.locale = def.locale;
			const anchor = anchorByName.get(def.name);
			if (anchor) taxonomy.translationOf = anchor;
			else anchorByName.set(def.name, defSeedId);
		}

		// The structure is the taxonomy's, so only the entry translations point at carries it.
		if (!taxonomy.translationOf) {
			taxonomy.hierarchical = def.hierarchical === 1;
			taxonomy.collections = parseTaxonomyCollections(def.collections);
		}

		if (seedTerms.length > 0) taxonomy.terms = seedTerms;

		result.push(taxonomy);
	}

	// Anchors first at def level too.
	result.sort((a, b) => Number(!!a.translationOf) - Number(!!b.translationOf));

	return result;
}

/**
 * Export menus with their items
 */
async function exportMenus(
	db: Kysely<Database>,
	i18nEnabled: boolean,
	contentGroupSeedIds: ContentGroupSeedIds,
): Promise<SeedMenu[]> {
	const menus = await db
		.selectFrom("_emdash_menus")
		.selectAll()
		// Chained, not `orderBy(["name", "locale"])`: kysely deprecated the array
		// form and announces it with `console.log`, which lands in the seed
		// document this command writes to stdout.
		.orderBy("name")
		.orderBy("locale")
		.execute();

	const result: SeedMenu[] = [];
	// translation_group -> seed-local id of the anchor menu in that group.
	const groupToSeedId = new Map<string, string>();
	// Shared across menus: translated items reference anchor items in sibling menus.
	const itemGroupToSeedId = new Map<string, string>();
	const usedItemSeedIds = new Set<string>();

	for (const menu of menus) {
		const seedId =
			i18nEnabled && menu.locale ? `menu:${menu.name}:${menu.locale}` : `menu:${menu.name}`;

		const items = await db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("menu_id", "=", menu.id)
			.orderBy("sort_order", "asc")
			.execute();

		const seedItems = buildMenuItemTree(items, {
			i18nEnabled,
			menuName: menu.name,
			menuLocale: menu.locale ?? null,
			itemGroupToSeedId,
			usedItemSeedIds,
			contentGroupSeedIds,
		});

		const seedMenu: SeedMenu = {
			id: seedId,
			name: menu.name,
			label: menu.label,
			items: seedItems,
		};

		if (i18nEnabled && menu.locale) {
			seedMenu.locale = menu.locale;
			if (menu.translation_group) {
				const anchor = groupToSeedId.get(menu.translation_group);
				if (anchor) seedMenu.translationOf = anchor;
				else groupToSeedId.set(menu.translation_group, seedId);
			}
		}

		result.push(seedMenu);
	}

	// Anchors first so import can resolve `translationOf`.
	result.sort((a, b) => Number(!!a.translationOf) - Number(!!b.translationOf));

	return result;
}

/** Type guard for valid widget types */
function isWidgetType(t: string): t is SeedWidget["type"] {
	return t === "content" || t === "menu" || t === "component";
}

/**
 * Build hierarchical menu item tree from flat array
 */
function buildMenuItemTree(
	items: Array<{
		id: string;
		parent_id: string | null;
		type: string;
		label: string;
		custom_url: string | null;
		reference_collection: string | null;
		reference_id: string | null;
		target: string | null;
		title_attr: string | null;
		css_classes: string | null;
		locale?: string | null;
		translation_group?: string | null;
	}>,
	i18nCtx: {
		i18nEnabled: boolean;
		menuName: string;
		menuLocale: string | null;
		// translation_group -> seed-local id of the anchor item in that group.
		itemGroupToSeedId: Map<string, string>;
		usedItemSeedIds: Set<string>;
		contentGroupSeedIds: ContentGroupSeedIds;
	},
): SeedMenuItem[] {
	// Build parent -> children map
	const childMap = new Map<string | null, typeof items>();

	for (const item of items) {
		const parentId = item.parent_id;
		if (!childMap.has(parentId)) {
			childMap.set(parentId, []);
		}
		childMap.get(parentId)!.push(item);
	}

	function makeSeedId(item: (typeof items)[number]): string {
		const base = slugify(item.label || "") || item.id;
		const locale = i18nCtx.i18nEnabled ? (item.locale ?? i18nCtx.menuLocale) : null;
		const candidate = locale
			? `item:${i18nCtx.menuName}:${base}:${locale}`
			: `item:${i18nCtx.menuName}:${base}`;
		if (!i18nCtx.usedItemSeedIds.has(candidate)) {
			i18nCtx.usedItemSeedIds.add(candidate);
			return candidate;
		}
		// Collision fallback: append DB id to disambiguate duplicate labels.
		const fallback = locale
			? `item:${i18nCtx.menuName}:${base}:${item.id}:${locale}`
			: `item:${i18nCtx.menuName}:${base}:${item.id}`;
		i18nCtx.usedItemSeedIds.add(fallback);
		return fallback;
	}

	// Recursively build tree
	function buildLevel(parentId: string | null): SeedMenuItem[] {
		const children = childMap.get(parentId) || [];
		const result = children.map((item) => {
			const seedItem: SeedMenuItem = {
				type: item.type,
				label: item.label || undefined,
			};

			if (item.type === "custom") {
				seedItem.url = item.custom_url || undefined;
			} else {
				// `reference_id` holds the target's translation_group. Content
				// targets are named by the seed id `applySeed` maps back to a row;
				// anything this export did not include keeps the stored value.
				const contentSeedId =
					item.type !== "taxonomy" && item.reference_id
						? i18nCtx.contentGroupSeedIds.get(item.reference_id)
						: undefined;
				seedItem.ref = contentSeedId ?? (item.reference_id || undefined);
				seedItem.collection = item.reference_collection || undefined;
			}

			if (item.target === "_blank") {
				seedItem.target = "_blank";
			}
			if (item.title_attr) {
				seedItem.titleAttr = item.title_attr;
			}
			if (item.css_classes) {
				seedItem.cssClasses = item.css_classes;
			}

			if (i18nCtx.i18nEnabled) {
				const itemLocale = item.locale ?? i18nCtx.menuLocale;
				const seedId = makeSeedId(item);
				seedItem.id = seedId;
				if (itemLocale) seedItem.locale = itemLocale;
				if (item.translation_group) {
					const anchor = i18nCtx.itemGroupToSeedId.get(item.translation_group);
					if (anchor && anchor !== seedId) seedItem.translationOf = anchor;
					else if (!anchor) i18nCtx.itemGroupToSeedId.set(item.translation_group, seedId);
				}
			}

			// Add children
			const itemChildren = buildLevel(item.id);
			if (itemChildren.length > 0) {
				seedItem.children = itemChildren;
			}

			return seedItem;
		});

		// Sibling order is preserved (maps to sort_order on import). Cross-menu
		// `translationOf` already resolves because exportMenus sorts anchors first.
		return result;
	}

	return buildLevel(null);
}

/**
 * Export widget areas with their widgets
 */
async function exportWidgetAreas(db: Kysely<Database>): Promise<SeedWidgetArea[]> {
	// Get all widget areas
	const areas = await db.selectFrom("_emdash_widget_areas").selectAll().execute();

	const result: SeedWidgetArea[] = [];

	for (const area of areas) {
		// Get widgets for this area
		const widgets = await db
			.selectFrom("_emdash_widgets")
			.selectAll()
			.where("area_id", "=", area.id)
			.orderBy("sort_order", "asc")
			.execute();

		const seedWidgets: SeedWidget[] = widgets
			.filter((w) => isWidgetType(w.type))
			.map((widget) => {
				const wType: SeedWidget["type"] = isWidgetType(widget.type) ? widget.type : "content";
				const seedWidget: SeedWidget = {
					type: wType,
				};

				if (widget.title) {
					seedWidget.title = widget.title;
				}

				if (widget.type === "content" && widget.content) {
					seedWidget.content = JSON.parse(widget.content);
				} else if (widget.type === "menu" && widget.menu_name) {
					seedWidget.menuName = widget.menu_name;
				} else if (widget.type === "component") {
					if (widget.component_id) {
						seedWidget.componentId = widget.component_id;
					}
					if (widget.component_props) {
						seedWidget.props = JSON.parse(widget.component_props);
					}
				}

				return seedWidget;
			});

		result.push({
			name: area.name,
			label: area.label,
			description: area.description || undefined,
			widgets: seedWidgets,
		});
	}

	return result;
}

function isSeedRedirectType(type: number): type is NonNullable<SeedRedirect["type"]> {
	return type === 301 || type === 302 || type === 307 || type === 308;
}

/**
 * Export redirect rules. Terminal rules (410/451) have no seed representation
 * and are reported through `warn` instead.
 *
 * Databases migrated from before the source guard can hold several rows for
 * one source; only the guarded row is exported, since a seed rejects duplicate
 * sources.
 */
async function exportRedirects(
	db: Kysely<Database>,
	warn: (message: string) => void,
): Promise<SeedRedirect[]> {
	const rows = await db
		.selectFrom("_emdash_redirects")
		.select(["source", "destination", "type", "enabled", "group_name", "source_guard"])
		.orderBy("created_at")
		.orderBy("id")
		.execute();

	const guardedRows = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const current = guardedRows.get(row.source);
		if (!current || (row.source_guard === 1 && current.source_guard !== 1)) {
			guardedRows.set(row.source, row);
		}
	}

	const result: SeedRedirect[] = [];
	for (const row of rows) {
		if (guardedRows.get(row.source) !== row) {
			warn(`Skipping duplicate rule for "${row.source}" -> "${row.destination}".`);
			continue;
		}
		if (!isSeedRedirectType(row.type)) {
			warn(`Skipping ${row.type} rule for "${row.source}": seeds only carry 301/302/307/308.`);
			continue;
		}
		const redirect: SeedRedirect = {
			source: row.source,
			destination: row.destination,
			type: row.type,
		};
		if (row.enabled === 0) redirect.enabled = false;
		if (row.group_name) redirect.groupName = row.group_name;
		result.push(redirect);
	}
	return result;
}

function isSeedSectionSource(source: string): source is NonNullable<SeedSection["source"]> {
	return source === "theme" || source === "user" || source === "import";
}

/** Section slugs a seed accepts. The WordPress importer can store others. */
const SEED_SECTION_SLUG_PATTERN = /^[a-z0-9-]+$/;

async function exportSections(
	db: Kysely<Database>,
	warn: (message: string) => void,
): Promise<SeedSection[]> {
	const rows = await db
		.selectFrom("_emdash_sections")
		.select(["slug", "title", "description", "keywords", "content", "source"])
		.orderBy("slug")
		.execute();

	const result: SeedSection[] = [];
	for (const row of rows) {
		if (!SEED_SECTION_SLUG_PATTERN.test(row.slug)) {
			warn(
				`Skipping section "${row.slug}": seed section slugs may only contain lowercase letters, digits, and hyphens.`,
			);
			continue;
		}
		const section: SeedSection = {
			slug: row.slug,
			title: row.title,
			content: JSON.parse(row.content),
		};
		if (row.description) section.description = row.description;
		if (row.keywords) section.keywords = JSON.parse(row.keywords);
		if (isSeedSectionSource(row.source)) section.source = row.source;
		result.push(section);
	}
	return result;
}

/** An entry read for export, paired with the seed id it will be written under. */
interface CollectedEntry {
	item: ContentItem;
	seedId: string;
}

/** A relation, by the slug a reference field addresses it under. */
type RelationsBySlug = Map<
	string,
	{ id: string; childCollection: string; maxChildrenPerParent: number | null }
>;

async function loadRelations(db: Kysely<Database>): Promise<RelationsBySlug> {
	const rows = await db
		.selectFrom("_emdash_relations")
		.select(["id", "slug", "child_collection", "max_children_per_parent"])
		.execute();
	return new Map(
		rows.map((row) => [
			row.slug,
			{
				id: row.id,
				childCollection: row.child_collection,
				maxChildrenPerParent: row.max_children_per_parent,
			},
		]),
	);
}

/** A legacy reference column holds a single entry id or an array of them. */
function legacyReferenceValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	return [];
}

/**
 * For each exported collection, the other exported collections its entries
 * point into.
 *
 * A field bound to a relation names its target in the relation, and its links
 * are not in `data` to be read. A field with no relation still holds entry ids
 * in its own column; those are read from the values rather than from a declared
 * target, so a field without `options.collection` is still accounted for.
 */
function referenceTargets(
	collected: Map<string, CollectedEntry[]>,
	collectionsBySlug: Map<string, SeedCollection>,
	entryIdToCollection: Map<string, string>,
	relations: RelationsBySlug,
): Map<string, Set<string>> {
	const targets = new Map<string, Set<string>>();

	for (const [slug, items] of collected) {
		const referenceFields = (collectionsBySlug.get(slug)?.fields ?? []).filter(
			(field) => field.type === "reference",
		);
		if (referenceFields.length === 0) continue;

		const found = new Set<string>();
		const add = (target: string | undefined): void => {
			if (target && target !== slug) found.add(target);
		};

		for (const field of referenceFields) {
			const relationSlug = field.validation?.relation;
			if (typeof relationSlug !== "string") continue;
			if (field.validation?.relationSide === "child") continue;
			add(relations.get(relationSlug)?.childCollection);
		}

		const columnFields = referenceFields
			.filter((field) => typeof field.validation?.relation !== "string")
			.map((field) => field.slug);
		if (columnFields.length > 0) {
			for (const { item } of items) {
				for (const fieldSlug of columnFields) {
					for (const value of legacyReferenceValues(item.data[fieldSlug])) {
						add(entryIdToCollection.get(value));
					}
				}
			}
		}

		if (found.size > 0) targets.set(slug, found);
	}

	return targets;
}

/**
 * Order collections so a reference's target is written before the entry that
 * points at it. `applySeed` fills its seed-id map as it walks the file, so a
 * `$ref` into a collection further down resolves to nothing and is stored
 * verbatim.
 *
 * Depth-first, with the caller's order as the tie-break so an export without
 * references keeps the collection order it had. A cycle has no valid order;
 * the collections on it stay where they were rather than failing the export.
 */
function orderByReferenceTargets(slugs: string[], targets: Map<string, Set<string>>): string[] {
	const exported = new Set(slugs);
	const ordered: string[] = [];
	const placed = new Set<string>();
	const visiting = new Set<string>();

	const visit = (slug: string): void => {
		if (placed.has(slug) || visiting.has(slug)) return;
		visiting.add(slug);
		for (const target of targets.get(slug) ?? []) {
			if (exported.has(target)) visit(target);
		}
		visiting.delete(slug);
		placed.add(slug);
		ordered.push(slug);
	};

	for (const slug of slugs) visit(slug);
	return ordered;
}

/** translation_group -> seed id of the entry anchoring that group */
type ContentGroupSeedIds = Map<string, string>;

interface MediaInfo {
	url: string;
	filename: string;
	alt?: string;
	caption?: string;
}

interface ExportedContent {
	content: Record<string, SeedContentEntry[]>;
	groupSeedIds: ContentGroupSeedIds;
	/** Number of `$media` references written. */
	mediaCount: number;
}

/**
 * Export content from collections
 */
async function exportContent(
	db: Kysely<Database>,
	collections: SeedCollection[],
	includeCollections: string[] | null,
	bylineGroupToSeedId: Map<string, string>,
	i18nEnabled: boolean,
	mediaUrlPrefix: string,
): Promise<ExportedContent> {
	const content: Record<string, SeedContentEntry[]> = {};
	const mediaCounter = { count: 0 };
	const contentRepo = new ContentRepository(db);
	const taxonomyRepo = new TaxonomyRepository(db);
	const mediaRepo = new MediaRepository(db);

	// Build media id -> info map for $media conversion
	const mediaMap = new Map<string, MediaInfo>();
	try {
		let cursor: string | undefined;
		do {
			const result = await mediaRepo.findMany({
				limit: 100,
				cursor,
				status: "all",
			});
			for (const media of result.items) {
				mediaMap.set(media.id, {
					url: `${mediaUrlPrefix}${media.storageKey}`,
					filename: media.filename,
					alt: media.alt || undefined,
					caption: media.caption || undefined,
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
	} catch {
		// Media table might not exist or be empty
	}

	// Read every entry and assign its seed id before emitting any of them. A
	// reference can point at a collection the emit loop has not reached yet, so
	// both seed-id maps have to be complete before the first conversion — and the
	// collection order itself is derived from what points where.
	//
	// Keyed two ways: links are keyed by translation group, while a legacy
	// reference column holding one entry id is not.
	const collected = new Map<string, CollectedEntry[]>();
	const entryIdToSeedId = new Map<string, string>();
	const entryIdToCollection = new Map<string, string>();
	const groupToSeedId = new Map<string, string>();
	const exported: ExportedEntry[] = [];

	for (const collection of collections) {
		// Skip if not in include list
		if (includeCollections && !includeCollections.includes(collection.slug)) {
			continue;
		}

		const items: CollectedEntry[] = [];
		let cursor: string | undefined;

		// Paginate through all entries
		do {
			const result = await contentRepo.findMany(collection.slug, {
				limit: 100,
				cursor,
			});

			for (const item of result.items) {
				// Generate seed ID from collection:slug:locale for stable references
				const seedId = item.slug
					? i18nEnabled && item.locale
						? `${collection.slug}:${item.slug}:${item.locale}`
						: `${collection.slug}:${item.slug}`
					: item.id;

				items.push({ item, seedId });
				entryIdToSeedId.set(item.id, seedId);
				entryIdToCollection.set(item.id, collection.slug);
				// The first entry of a group is the one written without
				// `translationOf`, so `applySeed` gives it the group's id.
				const group = item.translationGroup ?? item.id;
				if (!groupToSeedId.has(group)) groupToSeedId.set(group, seedId);
			}

			cursor = result.nextCursor;
		} while (cursor);

		collected.set(collection.slug, items);
	}

	const relations = await loadRelations(db);
	const collectionsBySlug = new Map(collections.map((c) => [c.slug, c]));
	const orderedSlugs = orderByReferenceTargets(
		[...collected.keys()],
		referenceTargets(collected, collectionsBySlug, entryIdToCollection, relations),
	);

	for (const slug of orderedSlugs) {
		const collection = collectionsBySlug.get(slug);
		const items = collected.get(slug);
		if (!collection || !items) continue;

		const entries: SeedContentEntry[] = [];

		// When i18n is enabled, track translation_group -> seed ID so that
		// translations can reference the source entry's seed-local ID.
		// Key: EmDash translation_group ULID, Value: seed-local ID of the first entry in that group
		const translationGroupToSeedId = new Map<string, string>();

		for (const { item, seedId } of items) {
			// Process data fields for $media conversion
			const processedData = processDataForExport(
				item.data,
				collection.fields,
				mediaMap,
				mediaCounter,
			);

			const entry: SeedContentEntry = {
				id: seedId,
				slug: item.slug?.trim() ? item.slug : collection.routable === false ? undefined : item.id,
				// Seeds carry no schedule, and `applySeed` publishes an entry with
				// no status, so every unpublished state (including scheduled) is a
				// draft.
				status: item.status === "published" ? "published" : "draft",
				data: processedData,
			};

			// Add i18n fields when enabled
			if (i18nEnabled && item.locale) {
				entry.locale = item.locale;

				if (item.translationGroup) {
					const sourceSeedId = translationGroupToSeedId.get(item.translationGroup);
					if (sourceSeedId) {
						// This is a translation — reference the source entry
						entry.translationOf = sourceSeedId;
					} else {
						// First entry in this translation group — track it
						translationGroupToSeedId.set(item.translationGroup, seedId);
					}
				}
			}

			// Get taxonomy assignments
			const taxonomies = await getTaxonomyAssignments(taxonomyRepo, collection.slug, item.id);
			if (Object.keys(taxonomies).length > 0) {
				entry.taxonomies = taxonomies;
			}

			// Get byline credits. Read the junction directly: its `byline_id`
			// stores the translation_group, which is exactly the key in
			// `bylineGroupToSeedId`. This is locale-agnostic (one row per
			// credit) and avoids the locale-sibling fan-out a hydrated read
			// would produce.
			const bylines = await getBylineCredits(db, collection.slug, item.id, bylineGroupToSeedId);
			if (bylines.length > 0) {
				entry.bylines = bylines;
			}

			exported.push({
				collection,
				entry,
				translationGroup: item.translationGroup ?? null,
				referenceValues: item.data,
			});

			entries.push(entry);
		}

		if (i18nEnabled && entries.length > 0) {
			// Sort entries so source locale entries appear before their translations.
			// Entries without translationOf come first; entries with translationOf come after.
			entries.sort((a, b) => {
				if (a.translationOf && !b.translationOf) return 1;
				if (!a.translationOf && b.translationOf) return -1;
				return 0;
			});
		}

		if (entries.length > 0) {
			content[collection.slug] = entries;
		}
	}

	await addReferenceLinks(db, exported, relations, groupToSeedId, entryIdToSeedId);

	return { content, groupSeedIds: groupToSeedId, mediaCount: mediaCounter.count };
}

interface ExportedEntry {
	collection: SeedCollection;
	entry: SeedContentEntry;
	translationGroup: string | null;
	/** The entry's stored `data`, which a reference field's column value is read from. */
	referenceValues: Record<string, unknown>;
}

/**
 * Write each entry's reference selection into its `data` as `$ref:` values, which
 * the seed's own content ids resolve on apply.
 *
 * A field bound to a relation takes its selection from the link table. Only the
 * parent side is emitted: both sides view one link set, so a child-side field
 * would restate links the parent side already carries, and `setReferenceChildren`
 * accepts them only from the parent. A field with no relation takes the entry id
 * in its column instead.
 *
 * Runs after every collection has been emitted, so the seed id of any target is
 * known. A target that was not exported has none: a link is then dropped, since
 * nothing in the seed owns it, while a column value keeps its `$ref:` prefix
 * around the raw row id. Stripping the prefix there would write a row id that no
 * restored row carries into the column, and the restore would report success.
 */
async function addReferenceLinks(
	db: Kysely<Database>,
	exported: ExportedEntry[],
	relations: RelationsBySlug,
	groupToSeedId: Map<string, string>,
	entryIdToSeedId: Map<string, string>,
): Promise<void> {
	if (exported.length === 0) return;

	// Relation id -> parent group -> ordered child groups.
	const linksByRelation = new Map<string, Map<string, string[]>>();
	if (relations.size > 0) {
		const edges = await db
			.selectFrom("_emdash_content_references")
			.select(["relation_id", "parent_group", "child_group"])
			.orderBy("sort_order", "asc")
			.execute();
		for (const edge of edges) {
			const byParent = linksByRelation.get(edge.relation_id) ?? new Map<string, string[]>();
			const children = byParent.get(edge.parent_group) ?? [];
			children.push(edge.child_group);
			byParent.set(edge.parent_group, children);
			linksByRelation.set(edge.relation_id, byParent);
		}
	}

	for (const { collection, entry, translationGroup, referenceValues } of exported) {
		for (const field of collection.fields) {
			if (field.type !== "reference") continue;
			const slug = field.validation?.relation;

			if (typeof slug !== "string") {
				// No relation: the field keeps its own column, holding one entry id or
				// a JSON array of them.
				const stored = referenceValues[field.slug];
				const ids = (Array.isArray(stored) ? stored : [stored]).filter(
					(id): id is string => typeof id === "string" && id.length > 0,
				);
				const refs = ids.map((id) => `$ref:${entryIdToSeedId.get(id) ?? id}`);
				if (refs.length === 0) continue;
				entry.data[field.slug] = Array.isArray(stored) ? refs : refs[0];
				continue;
			}

			if (field.validation?.relationSide === "child") continue;

			const relation = relations.get(slug);
			if (!relation || !translationGroup) continue;

			const childGroups = linksByRelation.get(relation.id)?.get(translationGroup) ?? [];
			const refs = childGroups
				.map((group) => groupToSeedId.get(group))
				.filter((seedId): seedId is string => seedId !== undefined)
				.map((seedId) => `$ref:${seedId}`);
			if (refs.length === 0) continue;

			entry.data[field.slug] = relation.maxChildrenPerParent === 1 ? refs[0] : refs;
		}
	}
}

/**
 * Convert a stored media value (image or file) to `$media` syntax. Values that
 * don't point at a known media row are kept as they are.
 */
function toSeedMedia(
	value: unknown,
	mediaMap: Map<string, MediaInfo>,
	mediaCounter: { count: number },
): unknown {
	if (!value || typeof value !== "object") return value;
	const mediaValue = value as { id?: unknown; alt?: unknown };
	const mediaInfo = typeof mediaValue.id === "string" ? mediaMap.get(mediaValue.id) : undefined;
	if (!mediaInfo) return value;

	mediaCounter.count++;
	return {
		$media: {
			url: mediaInfo.url,
			filename: mediaInfo.filename,
			alt: (typeof mediaValue.alt === "string" && mediaValue.alt) || mediaInfo.alt,
			caption: mediaInfo.caption,
		},
	};
}

/** Slugs of a repeater field's `image` sub-fields. */
function repeaterImageSubFields(field: SeedField): Set<string> {
	const subFields = field.validation?.subFields;
	const slugs = new Set<string>();
	if (!Array.isArray(subFields)) return slugs;
	for (const subField of subFields) {
		if (
			subField &&
			typeof subField === "object" &&
			subField.type === "image" &&
			typeof subField.slug === "string"
		) {
			slugs.add(subField.slug);
		}
	}
	return slugs;
}

/**
 * Process content data for export: media values become `$media` references
 * and reference values become `$ref:` seed ids.
 */
function processDataForExport(
	data: Record<string, unknown>,
	fields: SeedField[],
	mediaMap: Map<string, MediaInfo>,
	mediaCounter: { count: number },
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	const fieldsBySlug = new Map<string, SeedField>();
	for (const field of fields) {
		fieldsBySlug.set(field.slug, field);
	}

	for (const [key, value] of Object.entries(data)) {
		const field = fieldsBySlug.get(key);
		const fieldType: FieldType | undefined = field?.type;

		if (fieldType === "image" || fieldType === "file") {
			result[key] = toSeedMedia(value, mediaMap, mediaCounter);
		} else if (field && fieldType === "repeater" && Array.isArray(value)) {
			const imageSubFields = repeaterImageSubFields(field);
			result[key] = value.map((row: unknown) => {
				if (!row || typeof row !== "object" || Array.isArray(row)) return row;
				const exportedRow: Record<string, unknown> = {};
				for (const [subKey, subValue] of Object.entries(row)) {
					exportedRow[subKey] = imageSubFields.has(subKey)
						? toSeedMedia(subValue, mediaMap, mediaCounter)
						: subValue;
				}
				return exportedRow;
			});
		} else if (fieldType === "reference") {
			// Left for `addReferenceLinks`, which knows the seed id each entry was
			// emitted under. A `$ref:` built here from a raw entry id resolves
			// against nothing on apply.
			continue;
		} else {
			result[key] = value;
		}
	}

	return result;
}

/**
 * Get ordered byline credits for a content entry as `SeedBylineCredit[]`.
 *
 * The `_emdash_content_bylines.byline_id` column stores the credited byline's
 * `translation_group`, so it maps straight through `groupToSeedId`. Credits
 * whose group wasn't emitted in the root `bylines[]` are skipped (defensive;
 * shouldn't happen for a consistent DB).
 */
async function getBylineCredits(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	groupToSeedId: Map<string, string>,
): Promise<SeedBylineCredit[]> {
	const rows = await db
		.selectFrom("_emdash_content_bylines")
		.select(["byline_id", "role_label"])
		.where("collection_slug", "=", collection)
		.where("content_id", "=", entryId)
		.orderBy("sort_order", "asc")
		.execute();

	const credits: SeedBylineCredit[] = [];
	for (const row of rows) {
		const seedId = groupToSeedId.get(row.byline_id);
		if (!seedId) continue;
		const credit: SeedBylineCredit = { byline: seedId };
		if (row.role_label) credit.roleLabel = row.role_label;
		credits.push(credit);
	}

	return credits;
}

/**
 * Get taxonomy term assignments for a content entry
 */
async function getTaxonomyAssignments(
	taxonomyRepo: TaxonomyRepository,
	collection: string,
	entryId: string,
): Promise<Record<string, string[]>> {
	const terms = await taxonomyRepo.getTermsForEntry(collection, entryId);
	const result: Record<string, string[]> = {};

	for (const term of terms) {
		if (!result[term.name]) {
			result[term.name] = [];
		}
		result[term.name].push(term.slug);
	}

	return result;
}
