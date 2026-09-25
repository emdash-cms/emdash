/**
 * Seed file validation
 *
 * Validates a seed file structure before applying it.
 */

import { getI18nConfig, resolveConfiguredLocale } from "../i18n/config.js";
import { validateBlockFields } from "../schema/block-type-contract.js";
import {
	FIELD_TYPES,
	isIndexableFieldType,
	MAX_COLLECTION_GROUP_LENGTH,
	MAX_COLLECTION_LIST_COLUMNS,
} from "../schema/types.js";
import type { SeedFile, SeedMenuItem, SeedTaxonomy, ValidationResult } from "./types.js";

const COLLECTION_FIELD_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Matches `SchemaRegistry.validateSlug`, which collection and field slugs go through. */
const MAX_SLUG_LENGTH = 63;
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const REDIRECT_TYPES = new Set([301, 302, 307, 308]);
const CRLF_PATTERN = /[\r\n]/;

/** Type guard for Record<string, unknown> */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRedirectPath(path: string): boolean {
	if (!path.startsWith("/") || path.startsWith("//") || CRLF_PATTERN.test(path)) {
		return false;
	}

	try {
		return !decodeURIComponent(path).split("/").includes("..");
	} catch {
		return false;
	}
}

/**
 * The entry that declares `taxonomy`'s `hierarchical` and `collections`: the last
 * entry of its `translationOf` chain within the taxonomy's name, or undefined when
 * the chain loops.
 */
export function findTaxonomyStructureSource<T extends Pick<SeedTaxonomy, "name" | "translationOf">>(
	taxonomy: T,
	taxonomiesById: ReadonlyMap<string, T>,
): T | undefined {
	const visited = new Set<T>();
	let current = taxonomy;
	while (!visited.has(current)) {
		visited.add(current);
		const source = current.translationOf ? taxonomiesById.get(current.translationOf) : undefined;
		if (!source || source.name !== current.name) return current;
		current = source;
	}
	return undefined;
}

/** Whether `a` and `b` disagree on `hierarchical` or `collections`, comparing only fields both declare. */
function declaresDifferentStructure(a: SeedTaxonomy, b: SeedTaxonomy): boolean {
	if (
		a.hierarchical !== undefined &&
		b.hierarchical !== undefined &&
		a.hierarchical !== b.hierarchical
	) {
		return true;
	}
	if (!Array.isArray(a.collections) || !Array.isArray(b.collections)) return false;
	const own = new Set(a.collections);
	const other = new Set(b.collections);
	return own.size !== other.size || [...own].some((collection) => !other.has(collection));
}

/**
 * Validate a seed file
 *
 * @param data - Unknown data to validate as a seed file
 * @returns Validation result with errors and warnings
 */
export function validateSeed(data: unknown): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Basic type check
	if (!data || typeof data !== "object") {
		return {
			valid: false,
			errors: ["Seed must be an object"],
			warnings: [],
		};
	}

	const seed = data as Partial<SeedFile>;
	const defaultLocale =
		getI18nConfig()?.defaultLocale ??
		(typeof seed.defaultLocale === "string" ? seed.defaultLocale : "en");

	// Required fields
	if (!seed.version) {
		errors.push("Seed must have a version field");
	} else if (seed.version !== "1") {
		errors.push(`Unsupported seed version: ${String(seed.version)}`);
	}

	// defaultLocale backfills the locale of rows that omit one, so a blank or
	// whitespace-padded value would silently write empty/invalid locales to the DB.
	// Exported seeds never hit this, but it's part of the public schema now.
	if (seed.defaultLocale !== undefined) {
		if (
			typeof seed.defaultLocale !== "string" ||
			seed.defaultLocale.length === 0 ||
			seed.defaultLocale !== seed.defaultLocale.trim()
		) {
			errors.push(
				"defaultLocale: must be a non-empty string with no leading or trailing whitespace",
			);
		}
	}

	if (seed.blockTypes !== undefined) {
		if (!Array.isArray(seed.blockTypes)) {
			errors.push("blockTypes must be an array");
		} else {
			const slugs = new Set<string>();
			for (const [index, blockType] of seed.blockTypes.entries()) {
				const prefix = `blockTypes[${index}]`;
				if (!blockType.slug || !COLLECTION_FIELD_SLUG_PATTERN.test(blockType.slug)) {
					errors.push(`${prefix}.slug: must be a valid block type slug`);
				} else if (slugs.has(blockType.slug)) {
					errors.push(`${prefix}.slug: duplicate block type slug "${blockType.slug}"`);
				} else {
					slugs.add(blockType.slug);
				}
				if (!blockType.label) errors.push(`${prefix}.label: is required`);
				if (!Array.isArray(blockType.versions) || blockType.versions.length === 0) {
					errors.push(`${prefix}.versions: must be a non-empty array`);
					continue;
				}
				const numbers = blockType.versions.map((version) => version.version);
				const sorted = [...numbers].toSorted((left, right) => left - right);
				if (
					sorted[0] !== 1 ||
					sorted.some((version, versionIndex) => version !== versionIndex + 1)
				) {
					errors.push(`${prefix}.versions: numbers must be contiguous and start at 1`);
				}
				if (!numbers.includes(blockType.currentVersion)) {
					errors.push(`${prefix}.currentVersion: must name a declared version`);
				}
				for (const [versionIndex, version] of blockType.versions.entries()) {
					try {
						validateBlockFields(version.fields);
					} catch (error) {
						errors.push(
							`${prefix}.versions[${versionIndex}].${error instanceof Error ? error.message : "invalid fields"}`,
						);
					}
				}
			}
		}
	}

	// Validate collections
	if (seed.collections) {
		if (!Array.isArray(seed.collections)) {
			errors.push("collections must be an array");
		} else {
			const collectionSlugs = new Set<string>();

			for (let i = 0; i < seed.collections.length; i++) {
				const collection = seed.collections[i];
				const prefix = `collections[${i}]`;

				if (!collection.slug) {
					errors.push(`${prefix}: slug is required`);
				} else {
					// Check for valid slug format
					if (!COLLECTION_FIELD_SLUG_PATTERN.test(collection.slug)) {
						errors.push(
							`${prefix}.slug: must start with a letter and contain only lowercase letters, numbers, and underscores`,
						);
					}

					// Check for duplicate slugs
					if (collectionSlugs.has(collection.slug)) {
						errors.push(`${prefix}.slug: duplicate collection slug "${collection.slug}"`);
					}
					collectionSlugs.add(collection.slug);
				}

				if (!collection.label) {
					errors.push(`${prefix}: label is required`);
				}
				if (collection.editLocking !== undefined && typeof collection.editLocking !== "boolean") {
					errors.push(`${prefix}.editLocking: must be a boolean`);
				}
				if (collection.routable !== undefined && typeof collection.routable !== "boolean") {
					errors.push(`${prefix}.routable: must be a boolean`);
				}
				if (collection.group !== undefined) {
					if (typeof collection.group !== "string") {
						errors.push(`${prefix}.group: must be a string`);
					} else if (collection.group.trim().length > MAX_COLLECTION_GROUP_LENGTH) {
						errors.push(
							`${prefix}.group: must be at most ${MAX_COLLECTION_GROUP_LENGTH} characters`,
						);
					}
				}

				const declaredFieldSlugs = new Set(
					Array.isArray(collection.fields)
						? collection.fields.flatMap((field) =>
								isRecord(field) && typeof field.slug === "string" ? [field.slug] : [],
							)
						: [],
				);

				if (collection.admin !== undefined) {
					if (!isRecord(collection.admin)) {
						errors.push(`${prefix}.admin: must be an object`);
					} else if (collection.admin.listColumns !== undefined) {
						if (!Array.isArray(collection.admin.listColumns)) {
							errors.push(`${prefix}.admin.listColumns: must be an array`);
						} else {
							if (collection.admin.listColumns.length > MAX_COLLECTION_LIST_COLUMNS) {
								errors.push(
									`${prefix}.admin.listColumns: must contain at most ${MAX_COLLECTION_LIST_COLUMNS} items`,
								);
							}
							for (let j = 0; j < collection.admin.listColumns.length; j++) {
								const slug = collection.admin.listColumns[j];
								if (typeof slug !== "string" || !COLLECTION_FIELD_SLUG_PATTERN.test(slug)) {
									errors.push(`${prefix}.admin.listColumns[${j}]: must be a valid field slug`);
								} else if (!declaredFieldSlugs.has(slug)) {
									errors.push(
										`${prefix}.admin.listColumns[${j}]: references unknown field "${slug}"`,
									);
								}
							}
						}
					}
				}

				// Validate fields
				if (!Array.isArray(collection.fields)) {
					errors.push(`${prefix}.fields: must be an array`);
				} else {
					const fieldSlugs = new Set<string>();

					for (let j = 0; j < collection.fields.length; j++) {
						const field = collection.fields[j];
						const fieldPrefix = `${prefix}.fields[${j}]`;

						if (!field.slug) {
							errors.push(`${fieldPrefix}: slug is required`);
						} else {
							// Check for valid slug format
							if (!COLLECTION_FIELD_SLUG_PATTERN.test(field.slug)) {
								errors.push(
									`${fieldPrefix}.slug: must start with a letter and contain only lowercase letters, numbers, and underscores`,
								);
							}

							// Check for duplicate field slugs
							if (fieldSlugs.has(field.slug)) {
								errors.push(
									`${fieldPrefix}.slug: duplicate field slug "${field.slug}" in collection "${collection.slug}"`,
								);
							}
							fieldSlugs.add(field.slug);
						}

						if (!field.label) {
							errors.push(`${fieldPrefix}: label is required`);
						}

						if (field.indexed !== undefined && typeof field.indexed !== "boolean") {
							errors.push(`${fieldPrefix}.indexed: must be a boolean`);
						}

						if (!field.type) {
							errors.push(`${fieldPrefix}: type is required`);
						} else if (!(FIELD_TYPES as readonly string[]).includes(field.type)) {
							errors.push(`${fieldPrefix}.type: unsupported field type "${field.type}"`);
						} else if (field.indexed === true && !isIndexableFieldType(field.type)) {
							errors.push(`${fieldPrefix}.indexed: type "${field.type}" cannot be indexed`);
						} else if (
							field.indexed === true &&
							field.type === "reference" &&
							typeof field.validation?.targetCollection === "string"
						) {
							// A targetCollection makes this field storage-less on apply: its
							// selection becomes relation edges, leaving no column to index.
							// Without one it stays a plain entry-id column, which can be.
							errors.push(
								`${fieldPrefix}.indexed: a reference field with a targetCollection stores no column to index`,
							);
						}
					}
				}
			}
		}
	}

	// Validate relations
	if (seed.relations) {
		if (!Array.isArray(seed.relations)) {
			errors.push("relations must be an array");
		} else {
			const relationSlugs = new Set<string>();

			for (let i = 0; i < seed.relations.length; i++) {
				const relation = seed.relations[i];
				const prefix = `relations[${i}]`;
				if (!relation) continue;

				if (!relation.slug) {
					errors.push(`${prefix}: slug is required`);
				} else {
					if (!COLLECTION_FIELD_SLUG_PATTERN.test(relation.slug)) {
						errors.push(
							`${prefix}.slug: must start with a letter and contain only lowercase letters, numbers, and underscores`,
						);
					}
					if (relation.slug.length > MAX_SLUG_LENGTH) {
						errors.push(`${prefix}.slug: must be ${MAX_SLUG_LENGTH} characters or fewer`);
					}
					if (relationSlugs.has(relation.slug)) {
						errors.push(`${prefix}.slug: duplicate relation slug "${relation.slug}"`);
					}
					relationSlugs.add(relation.slug);
				}

				for (const end of ["parentCollection", "childCollection"] as const) {
					const value = relation[end];
					if (!value) {
						errors.push(`${prefix}: ${end} is required`);
					} else if (!COLLECTION_FIELD_SLUG_PATTERN.test(value)) {
						errors.push(`${prefix}.${end}: "${value}" is not a valid collection slug`);
					}
				}

				for (const label of ["parentLabel", "childLabel"] as const) {
					if (!relation[label]) errors.push(`${prefix}: ${label} is required`);
				}
				for (const label of ["parentLabelSingular", "childLabelSingular"] as const) {
					const value = relation[label];
					if (value !== undefined && typeof value !== "string") {
						errors.push(`${prefix}.${label}: must be a string`);
					}
				}

				for (const limit of ["maxChildrenPerParent", "maxParentsPerChild"] as const) {
					const value = relation[limit];
					if (value === undefined || value === null) continue;
					if (!Number.isInteger(value) || value < 1) {
						errors.push(`${prefix}.${limit}: must be a positive integer, or null for unlimited`);
					}
				}
			}
		}
	}

	// Validate taxonomies
	if (seed.taxonomies) {
		if (!Array.isArray(seed.taxonomies)) {
			errors.push("taxonomies must be an array");
		} else {
			const taxonomyNames = new Set<string>();
			const taxonomiesById = new Map<string, SeedTaxonomy>();
			for (const taxonomy of seed.taxonomies) {
				if (taxonomy.id) taxonomiesById.set(taxonomy.id, taxonomy);
			}
			const structureDeclarations = new Map<string, SeedTaxonomy>();

			for (let i = 0; i < seed.taxonomies.length; i++) {
				const taxonomy = seed.taxonomies[i];
				const prefix = `taxonomies[${i}]`;

				if (!taxonomy.name) {
					errors.push(`${prefix}: name is required`);
				} else {
					// Uniqueness is per (name, locale).
					const locale = resolveConfiguredLocale(taxonomy.locale ?? defaultLocale);
					const key = `${taxonomy.name}::${locale}`;
					if (taxonomyNames.has(key)) {
						errors.push(
							taxonomy.locale
								? `${prefix}.name: duplicate taxonomy "${taxonomy.name}" in locale "${taxonomy.locale}"`
								: `${prefix}.name: duplicate taxonomy name "${taxonomy.name}"`,
						);
					}
					taxonomyNames.add(key);
				}

				if (!taxonomy.label) {
					errors.push(`${prefix}: label is required`);
				}

				const structureSource = findTaxonomyStructureSource(taxonomy, taxonomiesById);

				// A translation takes its taxonomy's structure, so it may omit both, but only
				// from an entry of the same taxonomy.
				if (
					taxonomy.translationOf &&
					(taxonomy.hierarchical === undefined || taxonomy.collections === undefined)
				) {
					if (!structureSource) {
						errors.push(
							`${prefix}.translationOf: the translationOf chain from "${taxonomy.translationOf}" loops, so hierarchical and collections are required`,
						);
					} else if (structureSource === taxonomy) {
						errors.push(
							`${prefix}.translationOf: "${taxonomy.translationOf}" is not an entry of taxonomy "${taxonomy.name}", so hierarchical and collections are required`,
						);
					}
				}

				if (taxonomy.hierarchical === undefined && !taxonomy.translationOf) {
					errors.push(`${prefix}: hierarchical is required`);
				}

				if (taxonomy.collections === undefined) {
					if (!taxonomy.translationOf) errors.push(`${prefix}.collections: must be an array`);
				} else if (!Array.isArray(taxonomy.collections)) {
					errors.push(`${prefix}.collections: must be an array`);
				} else if (taxonomy.collections.length === 0 && !taxonomy.translationOf) {
					warnings.push(
						`${prefix}.collections: taxonomy "${taxonomy.name}" is not assigned to any collections`,
					);
				}

				if (structureSource && structureSource !== taxonomy) {
					if (declaresDifferentStructure(taxonomy, structureSource)) {
						warnings.push(
							`${prefix}: hierarchical and collections come from taxonomies[${seed.taxonomies.indexOf(structureSource)}], so the values declared here are ignored`,
						);
					}
				} else if (structureSource && taxonomy.name) {
					const declaring = structureDeclarations.get(taxonomy.name);
					if (!declaring) {
						structureDeclarations.set(taxonomy.name, taxonomy);
					} else if (declaresDifferentStructure(taxonomy, declaring)) {
						warnings.push(
							`${prefix}: hierarchical and collections differ from taxonomies[${seed.taxonomies.indexOf(declaring)}]; every locale of taxonomy "${taxonomy.name}" shares them, so only one entry's values apply`,
						);
					}
				}

				const hierarchical = (structureSource ?? taxonomy).hierarchical;

				// Validate terms if present
				if (taxonomy.terms) {
					if (!Array.isArray(taxonomy.terms)) {
						errors.push(`${prefix}.terms: must be an array`);
					} else {
						const termSlugs = new Set<string>();

						for (let j = 0; j < taxonomy.terms.length; j++) {
							const term = taxonomy.terms[j];
							const termPrefix = `${prefix}.terms[${j}]`;

							if (!term.slug) {
								errors.push(`${termPrefix}: slug is required`);
							} else {
								// Uniqueness is per (slug, locale) so the same slug can repeat
								// across locale variants of the def.
								const locale = resolveConfiguredLocale(
									term.locale ?? taxonomy.locale ?? defaultLocale,
								);
								const key = `${term.slug}::${locale}`;
								if (termSlugs.has(key)) {
									errors.push(
										`${termPrefix}.slug: duplicate term slug "${term.slug}" in taxonomy "${taxonomy.name}"`,
									);
								}
								termSlugs.add(key);
							}

							if (!term.label) {
								errors.push(`${termPrefix}: label is required`);
							}

							// Check parent reference validity (for hierarchical taxonomies)
							if (term.parent && hierarchical) {
								// Parent will be validated in a second pass
							} else if (term.parent && !hierarchical) {
								warnings.push(
									`${termPrefix}.parent: taxonomy "${taxonomy.name}" is not hierarchical, parent will be ignored`,
								);
							}
						}

						// Second pass: validate parent references (within the same locale).
						if (hierarchical && taxonomy.terms) {
							for (let j = 0; j < taxonomy.terms.length; j++) {
								const term = taxonomy.terms[j];
								const termLocale = resolveConfiguredLocale(
									term.locale ?? taxonomy.locale ?? defaultLocale,
								);
								if (term.parent && !termSlugs.has(`${term.parent}::${termLocale}`)) {
									errors.push(
										`${prefix}.terms[${j}].parent: parent term "${term.parent}" not found in taxonomy`,
									);
								}

								// Check for circular references
								if (term.parent === term.slug) {
									errors.push(`${prefix}.terms[${j}].parent: term cannot be its own parent`);
								}
							}
						}
					}
				}
			}
		}
	}

	// Validate menus
	if (seed.menus) {
		if (!Array.isArray(seed.menus)) {
			errors.push("menus must be an array");
		} else {
			const menuNames = new Set<string>();

			for (let i = 0; i < seed.menus.length; i++) {
				const menu = seed.menus[i];
				const prefix = `menus[${i}]`;

				if (!menu.name) {
					errors.push(`${prefix}: name is required`);
				} else {
					// Uniqueness is per (name, locale) — siblings of a translation
					// group share name but differ in locale.
					const locale = resolveConfiguredLocale(menu.locale ?? defaultLocale);
					const key = `${menu.name}::${locale}`;
					if (menuNames.has(key)) {
						errors.push(
							menu.locale
								? `${prefix}.name: duplicate menu "${menu.name}" in locale "${menu.locale}"`
								: `${prefix}.name: duplicate menu name "${menu.name}"`,
						);
					}
					menuNames.add(key);
				}

				if (!menu.label) {
					errors.push(`${prefix}: label is required`);
				}

				if (!Array.isArray(menu.items)) {
					errors.push(`${prefix}.items: must be an array`);
				} else {
					validateMenuItems(menu.items, prefix, errors, warnings);
				}
			}
		}
	}

	// Validate redirects
	if (seed.redirects) {
		if (!Array.isArray(seed.redirects)) {
			errors.push("redirects must be an array");
		} else {
			const redirectSources = new Set<string>();

			for (let i = 0; i < seed.redirects.length; i++) {
				const redirect = seed.redirects[i];
				const prefix = `redirects[${i}]`;

				if (!isRecord(redirect)) {
					errors.push(`${prefix}: must be an object`);
					continue;
				}

				const source = typeof redirect.source === "string" ? redirect.source : undefined;
				const destination =
					typeof redirect.destination === "string" ? redirect.destination : undefined;

				if (!source) {
					errors.push(`${prefix}: source is required`);
				} else {
					if (!isValidRedirectPath(source)) {
						errors.push(
							`${prefix}.source: must be a path starting with / (no protocol-relative URLs, path traversal, or newlines)`,
						);
					}

					if (redirectSources.has(source)) {
						errors.push(`${prefix}.source: duplicate redirect source "${source}"`);
					}
					redirectSources.add(source);
				}

				if (!destination) {
					errors.push(`${prefix}: destination is required`);
				} else if (!isValidRedirectPath(destination)) {
					errors.push(
						`${prefix}.destination: must be a path starting with / (no protocol-relative URLs, path traversal, or newlines)`,
					);
				}

				if (redirect.type !== undefined) {
					if (typeof redirect.type !== "number" || !REDIRECT_TYPES.has(redirect.type)) {
						errors.push(`${prefix}.type: must be 301, 302, 307, or 308`);
					}
				}

				if (redirect.enabled !== undefined && typeof redirect.enabled !== "boolean") {
					errors.push(`${prefix}.enabled: must be a boolean`);
				}

				if (
					redirect.groupName !== undefined &&
					typeof redirect.groupName !== "string" &&
					redirect.groupName !== null
				) {
					errors.push(`${prefix}.groupName: must be a string or null`);
				}
			}
		}
	}

	// Validate widget areas
	if (seed.widgetAreas) {
		if (!Array.isArray(seed.widgetAreas)) {
			errors.push("widgetAreas must be an array");
		} else {
			const areaNames = new Set<string>();

			for (let i = 0; i < seed.widgetAreas.length; i++) {
				const area = seed.widgetAreas[i];
				const prefix = `widgetAreas[${i}]`;

				if (!area.name) {
					errors.push(`${prefix}: name is required`);
				} else {
					// Check for duplicate area names
					if (areaNames.has(area.name)) {
						errors.push(`${prefix}.name: duplicate widget area name "${area.name}"`);
					}
					areaNames.add(area.name);
				}

				if (!area.label) {
					errors.push(`${prefix}: label is required`);
				}

				if (!Array.isArray(area.widgets)) {
					errors.push(`${prefix}.widgets: must be an array`);
				} else {
					for (let j = 0; j < area.widgets.length; j++) {
						const widget = area.widgets[j];
						const widgetPrefix = `${prefix}.widgets[${j}]`;

						if (!widget.type) {
							errors.push(`${widgetPrefix}: type is required`);
						} else if (!["content", "menu", "component"].includes(widget.type)) {
							errors.push(`${widgetPrefix}.type: must be "content", "menu", or "component"`);
						}

						// Type-specific validation
						if (widget.type === "menu" && !widget.menuName) {
							errors.push(`${widgetPrefix}: menuName is required for menu widgets`);
						}

						if (widget.type === "component" && !widget.componentId) {
							errors.push(`${widgetPrefix}: componentId is required for component widgets`);
						}
					}
				}
			}
		}
	}

	// Validate sections
	if (seed.sections) {
		if (!Array.isArray(seed.sections)) {
			errors.push("sections must be an array");
		} else {
			const sectionSlugs = new Set<string>();

			for (let i = 0; i < seed.sections.length; i++) {
				const section = seed.sections[i];
				const prefix = `sections[${i}]`;

				if (!section.slug) {
					errors.push(`${prefix}: slug is required`);
				} else {
					if (!SLUG_PATTERN.test(section.slug)) {
						errors.push(
							`${prefix}.slug: must contain only lowercase letters, numbers, and hyphens`,
						);
					}
					if (sectionSlugs.has(section.slug)) {
						errors.push(`${prefix}.slug: duplicate section slug "${section.slug}"`);
					}
					sectionSlugs.add(section.slug);
				}

				if (!section.title) {
					errors.push(`${prefix}: title is required`);
				}

				if (!Array.isArray(section.content)) {
					errors.push(`${prefix}.content: must be an array`);
				}

				// Validate source
				if (section.source && !["theme", "import"].includes(section.source)) {
					errors.push(`${prefix}.source: must be "theme" or "import"`);
				}
			}
		}
	}

	// Validate bylines
	if (seed.bylines) {
		if (!Array.isArray(seed.bylines)) {
			errors.push("bylines must be an array");
		} else {
			const bylineIds = new Set<string>();
			const bylineSlugs = new Set<string>();
			for (let i = 0; i < seed.bylines.length; i++) {
				const byline = seed.bylines[i];
				const prefix = `bylines[${i}]`;

				if (!byline.id) {
					errors.push(`${prefix}: id is required`);
				} else {
					if (bylineIds.has(byline.id)) {
						errors.push(`${prefix}.id: duplicate byline id "${byline.id}"`);
					}
					bylineIds.add(byline.id);
				}

				if (!byline.slug) {
					errors.push(`${prefix}: slug is required`);
				} else {
					if (!SLUG_PATTERN.test(byline.slug)) {
						errors.push(
							`${prefix}.slug: must contain only lowercase letters, numbers, and hyphens`,
						);
					}
					if (bylineSlugs.has(byline.slug)) {
						errors.push(`${prefix}.slug: duplicate byline slug "${byline.slug}"`);
					}
					bylineSlugs.add(byline.slug);
				}

				if (!byline.displayName) {
					errors.push(`${prefix}: displayName is required`);
				}

				if (byline.avatar !== undefined) {
					const avatar: unknown = byline.avatar;
					if (!isRecord(avatar)) {
						errors.push(`${prefix}.avatar: must be an object`);
					} else {
						// storageKey is used verbatim in a `where storage_key = ?` lookup,
						// so surrounding whitespace would silently never match a real key.
						if (
							typeof avatar.storageKey !== "string" ||
							avatar.storageKey.length === 0 ||
							avatar.storageKey !== avatar.storageKey.trim()
						) {
							errors.push(
								`${prefix}.avatar.storageKey: must be a non-empty string with no leading or trailing whitespace`,
							);
						}
						for (const key of ["alt", "filename", "mimeType"] as const) {
							if (avatar[key] !== undefined && typeof avatar[key] !== "string") {
								errors.push(`${prefix}.avatar.${key}: must be a string`);
							}
						}
						// filename/mimeType are used verbatim, so reject blank or
						// whitespace-padded values (an empty filename would create a
						// media row with no basename; a padded mime type is invalid).
						for (const key of ["filename", "mimeType"] as const) {
							const v = avatar[key];
							if (typeof v === "string" && (v.length === 0 || v !== v.trim())) {
								errors.push(`${prefix}.avatar.${key}: must not be empty or whitespace-padded`);
							}
						}
						for (const key of ["width", "height"] as const) {
							const v = avatar[key];
							if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
								errors.push(`${prefix}.avatar.${key}: must be a non-negative number`);
							}
						}
					}
				}
			}
		}
	}

	// Validate content
	if (seed.content) {
		if (typeof seed.content !== "object" || Array.isArray(seed.content)) {
			errors.push("content must be an object (collection -> entries)");
		} else {
			for (const [collectionSlug, entries] of Object.entries(seed.content)) {
				if (!Array.isArray(entries)) {
					errors.push(`content.${collectionSlug}: must be an array`);
					continue;
				}
				const collectionRoutable =
					seed.collections?.find((collection) => collection.slug === collectionSlug)?.routable !==
					false;

				const entryIds = new Set<string>();

				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i];
					const prefix = `content.${collectionSlug}[${i}]`;

					if (!entry.id) {
						errors.push(`${prefix}: id is required`);
					} else {
						// Check for duplicate entry IDs
						if (entryIds.has(entry.id)) {
							errors.push(
								`${prefix}.id: duplicate entry id "${entry.id}" in collection "${collectionSlug}"`,
							);
						}
						entryIds.add(entry.id);
					}

					const hasSlug = typeof entry.slug === "string" && entry.slug.trim().length > 0;
					if (entry.slug !== undefined && entry.slug !== null && typeof entry.slug !== "string") {
						errors.push(`${prefix}.slug: must be a string`);
					}
					if (collectionRoutable && !hasSlug) {
						errors.push(`${prefix}: slug is required`);
					}

					if (!entry.data || typeof entry.data !== "object") {
						errors.push(`${prefix}: data must be an object`);
					}

					// Validate i18n fields
					if (entry.translationOf) {
						if (!entry.locale) {
							errors.push(`${prefix}: locale is required when translationOf is set`);
						}
					}
				}

				// Second pass: validate translationOf references within this collection
				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i];
					if (entry.translationOf && !entryIds.has(entry.translationOf)) {
						errors.push(
							`content.${collectionSlug}[${i}].translationOf: references "${entry.translationOf}" which is not in this collection`,
						);
					}
				}
			}
		}
	}

	// Validate cross-references (content refs in menus)
	if (seed.menus && seed.content) {
		const allContentIds = new Set<string>();
		for (const entries of Object.values(seed.content)) {
			if (Array.isArray(entries)) {
				for (const entry of entries) {
					if (entry.id) {
						allContentIds.add(entry.id);
					}
				}
			}
		}

		// Check menu item refs
		for (const menu of seed.menus) {
			if (Array.isArray(menu.items)) {
				validateMenuItemRefs(menu.items, allContentIds, warnings);
			}
		}
	}

	// Validate byline refs in content
	if (seed.content) {
		const seedBylineIds = new Set<string>((seed.bylines ?? []).map((byline) => byline.id));
		for (const [collectionSlug, entries] of Object.entries(seed.content)) {
			if (!Array.isArray(entries)) continue;
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				if (!entry.bylines) continue;
				if (!Array.isArray(entry.bylines)) {
					errors.push(`content.${collectionSlug}[${i}].bylines: must be an array`);
					continue;
				}
				for (let j = 0; j < entry.bylines.length; j++) {
					const credit = entry.bylines[j];
					const prefix = `content.${collectionSlug}[${i}].bylines[${j}]`;
					if (!credit.byline) {
						errors.push(`${prefix}.byline: is required`);
						continue;
					}
					if (!seedBylineIds.has(credit.byline)) {
						errors.push(`${prefix}.byline: references unknown byline "${credit.byline}"`);
					}
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Validate menu items recursively
 */
function validateMenuItems(
	items: unknown[],
	prefix: string,
	errors: string[],
	warnings: string[],
): void {
	for (let i = 0; i < items.length; i++) {
		const raw = items[i];
		const itemPrefix = `${prefix}.items[${i}]`;

		if (!isRecord(raw)) {
			errors.push(`${itemPrefix}: must be an object`);
			continue;
		}

		const item = raw;

		const itemType = typeof item.type === "string" ? item.type : undefined;

		if (!itemType) {
			errors.push(`${itemPrefix}: type is required`);
		} else if (!["custom", "page", "post", "taxonomy", "collection"].includes(itemType)) {
			errors.push(
				`${itemPrefix}.type: must be "custom", "page", "post", "taxonomy", or "collection"`,
			);
		}

		// Type-specific validation
		if (itemType === "custom" && !item.url) {
			errors.push(`${itemPrefix}: url is required for custom menu items`);
		}

		if ((itemType === "page" || itemType === "post") && !item.ref) {
			errors.push(`${itemPrefix}: ref is required for page/post menu items`);
		}

		// Validate children recursively
		if (Array.isArray(item.children)) {
			validateMenuItems(item.children, itemPrefix, errors, warnings);
		}
	}
}

/**
 * Validate menu item references exist in content
 */
function validateMenuItemRefs(
	items: SeedMenuItem[],
	contentIds: Set<string>,
	warnings: string[],
): void {
	for (const item of items) {
		if ((item.type === "page" || item.type === "post") && item.ref) {
			if (!contentIds.has(item.ref)) {
				warnings.push(`Menu item references content "${item.ref}" which is not in the seed file`);
			}
		}

		if (item.children) {
			validateMenuItemRefs(item.children, contentIds, warnings);
		}
	}
}
