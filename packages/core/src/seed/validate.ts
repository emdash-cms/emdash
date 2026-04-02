/**
 * Seed file validation
 *
 * Validates a seed file structure before applying it.
 */

import { FIELD_TYPES } from "../schema/types.js";
import type { SeedFile, SeedMenuItem, ValidationResult } from "./types.js";

const COLLECTION_FIELD_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const REDIRECT_TYPES = new Set([301, 302, 307, 308]);
const CRLF_PATTERN = /[\r\n]/;
const ISO_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:\d{2})$/;

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

function validateOptionalTimestamp(
	value: unknown,
	prefix: string,
	errors: string[],
	warnings: string[],
): void {
	if (value === undefined) {
		return;
	}

	if (typeof value !== "string") {
		errors.push(`${prefix}: must be an ISO 8601 string`);
		return;
	}

	if (Number.isNaN(Date.parse(value))) {
		errors.push(`${prefix}: must be a valid ISO 8601 date`);
		return;
	}

	if (!ISO_TIMEZONE_PATTERN.test(value)) {
		warnings.push(`${prefix}: missing timezone designator; prefer UTC or explicit offset`);
	}
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

	// Required fields
	if (!seed.version) {
		errors.push("Seed must have a version field");
	} else if (seed.version !== "1") {
		errors.push(`Unsupported seed version: ${String(seed.version)}`);
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

						if (!field.type) {
							errors.push(`${fieldPrefix}: type is required`);
						} else if (!(FIELD_TYPES as readonly string[]).includes(field.type)) {
							errors.push(`${fieldPrefix}.type: unsupported field type "${field.type}"`);
						}
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

			for (let i = 0; i < seed.taxonomies.length; i++) {
				const taxonomy = seed.taxonomies[i];
				const prefix = `taxonomies[${i}]`;

				if (!taxonomy.name) {
					errors.push(`${prefix}: name is required`);
				} else {
					// Check for duplicate taxonomy names
					if (taxonomyNames.has(taxonomy.name)) {
						errors.push(`${prefix}.name: duplicate taxonomy name "${taxonomy.name}"`);
					}
					taxonomyNames.add(taxonomy.name);
				}

				if (!taxonomy.label) {
					errors.push(`${prefix}: label is required`);
				}

				if (taxonomy.hierarchical === undefined) {
					errors.push(`${prefix}: hierarchical is required`);
				}

				if (!Array.isArray(taxonomy.collections)) {
					errors.push(`${prefix}.collections: must be an array`);
				} else if (taxonomy.collections.length === 0) {
					warnings.push(
						`${prefix}.collections: taxonomy "${taxonomy.name}" is not assigned to any collections`,
					);
				}

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
								// Check for duplicate term slugs
								if (termSlugs.has(term.slug)) {
									errors.push(
										`${termPrefix}.slug: duplicate term slug "${term.slug}" in taxonomy "${taxonomy.name}"`,
									);
								}
								termSlugs.add(term.slug);
							}

							if (!term.label) {
								errors.push(`${termPrefix}: label is required`);
							}

							// Check parent reference validity (for hierarchical taxonomies)
							if (term.parent && taxonomy.hierarchical) {
								// Parent will be validated in a second pass
							} else if (term.parent && !taxonomy.hierarchical) {
								warnings.push(
									`${termPrefix}.parent: taxonomy "${taxonomy.name}" is not hierarchical, parent will be ignored`,
								);
							}
						}

						// Second pass: validate parent references
						if (taxonomy.hierarchical && taxonomy.terms) {
							for (let j = 0; j < taxonomy.terms.length; j++) {
								const term = taxonomy.terms[j];
								if (term.parent && !termSlugs.has(term.parent)) {
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
					// Check for duplicate menu names
					if (menuNames.has(menu.name)) {
						errors.push(`${prefix}.name: duplicate menu name "${menu.name}"`);
					}
					menuNames.add(menu.name);
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

					if (!entry.slug) {
						errors.push(`${prefix}: slug is required`);
					}

					if (!entry.data || typeof entry.data !== "object") {
						errors.push(`${prefix}: data must be an object`);
					}

					validateOptionalTimestamp(entry.createdAt, `${prefix}.createdAt`, errors, warnings);
					validateOptionalTimestamp(entry.updatedAt, `${prefix}.updatedAt`, errors, warnings);
					validateOptionalTimestamp(entry.publishedAt, `${prefix}.publishedAt`, errors, warnings);

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
