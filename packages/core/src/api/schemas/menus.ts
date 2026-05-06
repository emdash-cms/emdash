import { z } from "zod";

import { isSafeHref } from "../../utils/url.js";

// ---------------------------------------------------------------------------
// Menus: Input schemas
// ---------------------------------------------------------------------------

const menuItemType = z.string().min(1);

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
	.meta({ id: "CreateMenuBody" });

export const updateMenuBody = z
	.object({
		label: z.string().min(1).optional(),
	})
	.meta({ id: "UpdateMenuBody" });

export const createMenuItemBody = z
	.object({
		type: menuItemType,
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
	.meta({ id: "UpdateMenuItemBody" });

export const menuItemDeleteQuery = z.object({
	id: z.string().min(1),
});

export const menuItemUpdateQuery = z.object({
	id: z.string().min(1),
});

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
// ---------------------------------------------------------------------------

export const menuSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		label: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
		locale: z.string(),
		translation_group: z.string().nullable(),
	})
	.meta({ id: "Menu" });

export const menuItemSchema = z
	.object({
		id: z.string(),
		menu_id: z.string(),
		parent_id: z.string().nullable(),
		sort_order: z.number().int(),
		type: z.string(),
		reference_collection: z.string().nullable(),
		reference_id: z.string().nullable(),
		custom_url: z.string().nullable(),
		label: z.string(),
		title_attr: z.string().nullable(),
		target: z.string().nullable(),
		css_classes: z.string().nullable(),
		created_at: z.string(),
		locale: z.string(),
		translation_group: z.string().nullable(),
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
