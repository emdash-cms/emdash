/**
 * emdash export-seed
 *
 * Export current database schema (and optionally content) as a seed file
 */

import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import type { Kysely } from "kysely";

import { createDatabase } from "../../database/connection.js";
import { runMigrations } from "../../database/migrations/runner.js";
import { ContentRepository } from "../../database/repositories/content.js";
import { MediaRepository } from "../../database/repositories/media.js";
import { OptionsRepository } from "../../database/repositories/options.js";
import { TaxonomyRepository } from "../../database/repositories/taxonomy.js";
import type { Database } from "../../database/types.js";
import { isI18nEnabled } from "../../i18n/config.js";
import { SchemaRegistry } from "../../schema/registry.js";
import type { FieldType } from "../../schema/types.js";
import type {
	SeedFile,
	SeedCollection,
	SeedField,
	SeedTaxonomy,
	SeedTaxonomyTerm,
	SeedMenu,
	SeedMenuItem,
	SeedWidgetArea,
	SeedWidget,
	SeedContentEntry,
} from "../../seed/types.js";

const SETTINGS_PREFIX = "site:";

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
	},
	async run({ args }) {
		const cwd = resolve(args.cwd);

		// Connect to database
		const dbPath = resolve(cwd, args.database);
		consola.info(`Database: ${dbPath}`);

		const db = createDatabase({ url: `file:${dbPath}` });

		// Run migrations to ensure tables exist
		try {
			await runMigrations(db);
		} catch (error) {
			consola.error("Migration failed:", error);
			await db.destroy();
			process.exit(1);
		}

		try {
			const seed = await exportSeed(db, args["with-content"]);

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

/**
 * Export database to seed file format
 */
async function exportSeed(db: Kysely<Database>, withContent?: string): Promise<SeedFile> {
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

	// 2. Export collections and fields
	seed.collections = await exportCollections(db);

	// 3. Export taxonomy definitions and terms
	seed.taxonomies = await exportTaxonomies(db);

	// 4. Export menus
	seed.menus = await exportMenus(db);

	// 5. Export widget areas
	seed.widgetAreas = await exportWidgetAreas(db);

	// 6. Export content (if requested)
	if (withContent !== undefined) {
		const collections =
			withContent === "" || withContent === "true"
				? null // all collections
				: withContent
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);

		seed.content = await exportContent(db, seed.collections || [], collections);
	}

	return seed;
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
			supports:
				collection.supports.length > 0
					? (collection.supports as (
							| "drafts"
							| "revisions"
							| "preview"
							| "scheduling"
							| "search"
						)[])
					: undefined,
			urlPattern: collection.urlPattern || undefined,
			fields: fields.map(
				(field): SeedField => ({
					slug: field.slug,
					label: field.label,
					type: field.type,
					required: field.required || undefined,
					unique: field.unique || undefined,
					searchable: field.searchable || undefined,
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
 * Export taxonomy definitions and terms
 */
async function exportTaxonomies(db: Kysely<Database>): Promise<SeedTaxonomy[]> {
	const i18nEnabled = isI18nEnabled();

	// Mirrors the content export pattern: one entry per (name, locale), stable
	// seed-local id, translations linked via `translationOf` to the anchor's id.
	const defs = await db
		.selectFrom("_emdash_taxonomy_defs")
		.selectAll()
		.orderBy(["name", "locale"])
		.execute();

	const result: SeedTaxonomy[] = [];
	const termRepo = new TaxonomyRepository(db);

	// translation_group -> seed-local id of first def we emitted in that group.
	const defGroupToSeedId = new Map<string, string>();

	for (const def of defs) {
		const defSeedId =
			i18nEnabled && def.locale ? `tax:${def.name}:${def.locale}` : `tax:${def.name}`;

		// Terms in this def's locale.
		const terms = await termRepo.findByName(def.name, { locale: def.locale });

		// id -> slug for parent resolution within this locale.
		const idToSlug = new Map<string, string>();
		for (const term of terms) idToSlug.set(term.id, term.slug);

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

			if (term.parentId) seedTerm.parent = idToSlug.get(term.parentId);

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
			hierarchical: def.hierarchical === 1,
			collections: def.collections ? JSON.parse(def.collections) : [],
		};

		if (i18nEnabled && def.locale) {
			taxonomy.locale = def.locale;
			if (def.translation_group) {
				const anchor = defGroupToSeedId.get(def.translation_group);
				if (anchor) taxonomy.translationOf = anchor;
				else defGroupToSeedId.set(def.translation_group, defSeedId);
			}
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
async function exportMenus(db: Kysely<Database>): Promise<SeedMenu[]> {
	const i18nEnabled = isI18nEnabled();

	const menus = await db
		.selectFrom("_emdash_menus")
		.selectAll()
		.orderBy(["name", "locale"])
		.execute();

	const result: SeedMenu[] = [];
	// translation_group -> seed-local id of the anchor menu in that group.
	const groupToSeedId = new Map<string, string>();

	for (const menu of menus) {
		const seedId =
			i18nEnabled && menu.locale ? `menu:${menu.name}:${menu.locale}` : `menu:${menu.name}`;

		const items = await db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("menu_id", "=", menu.id)
			.orderBy("sort_order", "asc")
			.execute();

		const seedItems = buildMenuItemTree(items);

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
	}>,
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

	// Recursively build tree
	function buildLevel(parentId: string | null): SeedMenuItem[] {
		const children = childMap.get(parentId) || [];
		return children.map((item) => {
			const seedItem: SeedMenuItem = {
				type: item.type,
				label: item.label || undefined,
			};

			if (item.type === "custom") {
				seedItem.url = item.custom_url || undefined;
			} else {
				seedItem.ref = item.reference_id || undefined;
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

			// Add children
			const itemChildren = buildLevel(item.id);
			if (itemChildren.length > 0) {
				seedItem.children = itemChildren;
			}

			return seedItem;
		});
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

/**
 * Export content from collections
 */
async function exportContent(
	db: Kysely<Database>,
	collections: SeedCollection[],
	includeCollections: string[] | null,
): Promise<Record<string, SeedContentEntry[]>> {
	const content: Record<string, SeedContentEntry[]> = {};
	const contentRepo = new ContentRepository(db);
	const taxonomyRepo = new TaxonomyRepository(db);
	const mediaRepo = new MediaRepository(db);

	// Build media id -> info map for $media conversion
	const mediaMap = new Map<
		string,
		{ url: string; filename: string; alt?: string; caption?: string }
	>();
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
					url: `/_emdash/api/media/file/${media.storageKey}`,
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

	const i18nEnabled = isI18nEnabled();

	for (const collection of collections) {
		// Skip if not in include list
		if (includeCollections && !includeCollections.includes(collection.slug)) {
			continue;
		}

		const entries: SeedContentEntry[] = [];
		let cursor: string | undefined;

		// When i18n is enabled, track translation_group -> seed ID so that
		// translations can reference the source entry's seed-local ID.
		// Key: EmDash translation_group ULID, Value: seed-local ID of the first entry in that group
		const translationGroupToSeedId = new Map<string, string>();

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

				// Process data fields for $media conversion
				const processedData = processDataForExport(item.data, collection.fields, mediaMap);

				const entry: SeedContentEntry = {
					id: seedId,
					slug: item.slug || item.id,
					status: item.status === "published" || item.status === "draft" ? item.status : undefined,
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

				entries.push(entry);
			}

			cursor = result.nextCursor;
		} while (cursor);

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

	return content;
}

/**
 * Process content data for export, converting image fields to $media syntax
 */
function processDataForExport(
	data: Record<string, unknown>,
	fields: SeedField[],
	mediaMap: Map<string, { url: string; filename: string; alt?: string; caption?: string }>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	// Create field type lookup
	const fieldTypes = new Map<string, FieldType>();
	for (const field of fields) {
		fieldTypes.set(field.slug, field.type);
	}

	for (const [key, value] of Object.entries(data)) {
		const fieldType = fieldTypes.get(key);

		if (fieldType === "image" && value && typeof value === "object") {
			// Convert image field to $media syntax
			const imageValue = value as { id?: string; src?: string; alt?: string };
			if (imageValue.id) {
				const mediaInfo = mediaMap.get(imageValue.id);
				if (mediaInfo) {
					result[key] = {
						$media: {
							url: mediaInfo.url,
							filename: mediaInfo.filename,
							alt: imageValue.alt || mediaInfo.alt,
							caption: mediaInfo.caption,
						},
					};
					continue;
				}
			}
			// Fallback: keep as-is if no media info found
			result[key] = value;
		} else if (fieldType === "reference" && typeof value === "string") {
			// Convert reference to $ref syntax (assumes same collection for now)
			result[key] = `$ref:${value}`;
		} else if (Array.isArray(value)) {
			// Process arrays (could contain references or images)
			result[key] = value.map((item) => {
				if (typeof item === "string" && fieldType === "reference") {
					return `$ref:${item}`;
				}
				return item;
			});
		} else {
			result[key] = value;
		}
	}

	return result;
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
