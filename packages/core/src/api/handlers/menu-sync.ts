/**
 * Bidirectional sidebar-menu sync engine
 *
 * Keeps admin sidebar structure and public menus aligned.
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

export interface SyncDiff {
	/** Menu items to add */
	toAdd: Array<{
		menuName: string;
		label: string;
		referenceCollection: string;
		sortOrder: number;
	}>;
	/** Menu items to remove (by ID) */
	toRemove: string[];
	/** Menu items to reorder */
	toReorder: Array<{
		id: string;
		sortOrder: number;
	}>;
}

/**
 * Compute the diff between sidebar structure and a public menu.
 * Returns items that need to be added, removed, or reordered.
 */
export async function computeMenuSyncDiff(
	db: Kysely<Database>,
	menuName: string,
): Promise<ApiResult<SyncDiff>> {
	try {
		// Get all collections ordered by sort_order
		const collections = await db
			.selectFrom("_emdash_collections")
			.select(["slug", "label", "sort_order"])
			.orderBy("sort_order", "asc")
			.orderBy("slug", "asc")
			.execute();

		// Get existing menu items of type 'collection'
		const menuItems = await db
			.selectFrom("_emdash_menu_items")
			.select(["_emdash_menu_items.id", "reference_collection", "sort_order"])
			.innerJoin("_emdash_menus", "_emdash_menu_items.menu_id", "_emdash_menus.id")
			.where("_emdash_menus.name", "=", menuName)
			.where("type", "=", "collection")
			.orderBy("sort_order", "asc")
			.execute();

		const menuCollectionSlugs = new Set(menuItems.map((item) => item.reference_collection));
		const sidebarSlugs = new Set(collections.map((c) => c.slug));

		// Collections in sidebar but not in menu -> add
		const toAdd = collections
			.filter((c) => !menuCollectionSlugs.has(c.slug))
			.map((c, i) => ({
				menuName,
				label: c.label,
				referenceCollection: c.slug,
				sortOrder: menuItems.length + i,
			}));

		// Menu items referencing deleted collections -> remove
		const toRemove = menuItems
			.filter((item) => !sidebarSlugs.has(item.reference_collection!))
			.map((item) => item.id);

		// Items that exist in both but have wrong sort order -> reorder
		const sortOrderMap = new Map(collections.map((c, i) => [c.slug, i]));
		const toReorder = menuItems
			.filter((item) => sidebarSlugs.has(item.reference_collection!))
			.map((item) => ({
				id: item.id,
				sortOrder: sortOrderMap.get(item.reference_collection!) ?? item.sort_order,
			}))
			.filter((item) => {
				const menuItem = menuItems.find((m) => m.id === item.id);
				return menuItem && item.sortOrder !== menuItem.sort_order;
			});

		return {
			success: true,
			data: { toAdd, toRemove, toReorder },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "SYNC_DIFF_ERROR",
				message: "Failed to compute sync diff",
			},
		};
	}
}

/**
 * Apply a sync diff to a public menu.
 */
export async function applyMenuSyncDiff(
	db: Kysely<Database>,
	diff: SyncDiff,
): Promise<ApiResult<{ added: number; removed: number; reordered: number }>> {
	try {
		let added = 0;
		let removed = 0;
		let reordered = 0;

		// Get menu ID
		const menu = await db
			.selectFrom("_emdash_menus")
			.select(["id", "locale"])
			.where("name", "=", diff.toAdd[0]?.menuName ?? "")
			.executeTakeFirst();

		if (!menu && diff.toAdd.length > 0) {
			return {
				success: false,
				error: { code: "MENU_NOT_FOUND", message: `Menu not found: ${diff.toAdd[0].menuName}` },
			};
		}

		// Add new items
		for (const item of diff.toAdd) {
			const id = ulid();
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id,
					menu_id: menu!.id,
					type: "collection",
					reference_collection: item.referenceCollection,
					reference_id: null,
					custom_url: null,
					label: item.label,
					sort_order: item.sortOrder,
					title_attr: null,
					target: null,
					css_classes: null,
					locale: menu!.locale ?? "en",
					translation_group: id,
				})
				.execute();
			added++;
		}

		// Remove orphaned items
		for (const id of diff.toRemove) {
			await db.deleteFrom("_emdash_menu_items").where("id", "=", id).execute();
			removed++;
		}

		// Reorder items
		for (const item of diff.toReorder) {
			await db
				.updateTable("_emdash_menu_items")
				.set({ sort_order: item.sortOrder })
				.where("id", "=", item.id)
				.execute();
			reordered++;
		}

		return {
			success: true,
			data: { added, removed, reordered },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "SYNC_APPLY_ERROR",
				message: "Failed to apply sync diff",
			},
		};
	}
}

/**
 * Full sync: compute diff and apply it in one step.
 */
export async function syncSidebarToMenu(
	db: Kysely<Database>,
	menuName: string,
): Promise<ApiResult<{ added: number; removed: number; reordered: number }>> {
	const diffResult = await computeMenuSyncDiff(db, menuName);
	if (!diffResult.success) return diffResult;

	return applyMenuSyncDiff(db, diffResult.data);
}
