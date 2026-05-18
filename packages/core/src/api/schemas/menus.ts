import { z } from "zod";

import { isSafeHref } from "../../utils/url.js";

// ---------------------------------------------------------------------------
// Menus: Input schemas
// ---------------------------------------------------------------------------

/**
 * Allowed menu item types. `custom` uses `customUrl`; the others resolve a URL
 * from `referenceCollection` + `referenceId` (a translation_group id).
 */
export const menuItemTypeEnum = z.enum(["custom", "page", "post", "taxonomy", "collection"]);

const safeHref = z
	.string()
	.trim()
	.refine(
		isSafeHref,
		"URL must use http, https, mailto, tel, a relative path, or a fragment identifier",
	);

export const createMenuBody = z
	.object({
		name: z.string().min(1),
		label: z.string().min(1),
		locale: z.string().min(1).optional(),
		/** When set, clones the items from the source menu. The new menu joins
		 * the source's translation_group. */
		translationOf: z.string().min(1).optional(),
	})
	.strict()
	.meta({ id: "CreateMenuBody" });

export const updateMenuBody = z
	.object({
		label: z.string().min(1).optional(),
	})
	.strict()
	.meta({ id: "UpdateMenuBody" });

export const createMenuItemBody = z
	.object({
		type: menuItemTypeEnum,
		label: z.string().min(1),
		referenceCollection: z.string().optional(),
		referenceId: z.string().optional(),
		customUrl: safeHref.optional(),
		target: z.string().optional(),
		titleAttr: z.string().optional(),
		cssClasses: z.string().optional(),
		parentId: z.string().optional(),
		sortOrder: z.number().int().min(0).optional(),
	})
	.strict()
	.meta({ id: "CreateMenuItemBody" });

export const updateMenuItemBody = z
	.object({
		label: z.string().min(1).optional(),
		customUrl: safeHref.optional(),
		target: z.string().optional(),
		titleAttr: z.string().optional(),
		cssClasses: z.string().optional(),
		parentId: z.string().nullish(),
		sortOrder: z.number().int().min(0).optional(),
	})
	.strict()
	.meta({ id: "UpdateMenuItemBody" });

export const reorderMenuItemsBody = z
	.object({
		items: z.array(
			z.object({
				id: z.string().min(1),
				parentId: z.string().nullable(),
				sortOrder: z.number().int().min(0),
			}),
		),
	})
	.meta({ id: "ReorderMenuItemsBody" });

// ---------------------------------------------------------------------------
// Menus: Response schemas
//
// All responses are camelCase to align with the rest of the EmDash REST API
// (content, taxonomies, redirects, etc.). The DB columns are snake_case;
// handlers hydrate rows into the shapes below before returning.
// ---------------------------------------------------------------------------

export const menuSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		label: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		locale: z.string(),
		translationGroup: z.string().nullable(),
	})
	.meta({ id: "Menu" });

export const menuItemSchema = z
	.object({
		id: z.string(),
		menuId: z.string(),
		parentId: z.string().nullable(),
		sortOrder: z.number().int(),
		type: z.string(),
		referenceCollection: z.string().nullable(),
		referenceId: z.string().nullable(),
		customUrl: z.string().nullable(),
		label: z.string(),
		titleAttr: z.string().nullable(),
		target: z.string().nullable(),
		cssClasses: z.string().nullable(),
		createdAt: z.string(),
		locale: z.string(),
		translationGroup: z.string().nullable(),
	})
	.meta({ id: "MenuItem" });

export const menuTranslationsSchema = z
	.object({
		translationGroup: z.string().nullable(),
		translations: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				label: z.string(),
				locale: z.string(),
				updatedAt: z.string(),
			}),
		),
	})
	.meta({ id: "MenuTranslations" });

export const menuListItemSchema = menuSchema
	.extend({
		itemCount: z.number().int(),
	})
	.meta({ id: "MenuListItem" });

export const menuWithItemsSchema = menuSchema
	.extend({
		items: z.array(menuItemSchema),
	})
	.meta({ id: "MenuWithItems" });
