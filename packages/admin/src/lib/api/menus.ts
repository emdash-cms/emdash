/**
 * Menu management APIs
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface Menu {
	id: string;
	name: string;
	label: string;
	created_at: string;
	updated_at: string;
	itemCount?: number;
}

export interface MenuItem {
	id: string;
	menu_id: string;
	parent_id: string | null;
	sort_order: number;
	type: string;
	reference_collection: string | null;
	reference_id: string | null;
	custom_url: string | null;
	label: string;
	title_attr: string | null;
	target: string | null;
	css_classes: string | null;
	created_at: string;
}

export interface MenuWithItems extends Menu {
	items: MenuItem[];
}

export interface CreateMenuInput {
	name: string;
	label: string;
}

export interface UpdateMenuInput {
	label?: string;
}

export interface CreateMenuItemInput {
	type: string;
	label: string;
	referenceCollection?: string;
	referenceId?: string;
	customUrl?: string;
	target?: string;
	titleAttr?: string;
	cssClasses?: string;
	parentId?: string;
	sortOrder?: number;
}

export interface UpdateMenuItemInput {
	label?: string;
	customUrl?: string;
	target?: string;
	titleAttr?: string;
	cssClasses?: string;
	parentId?: string | null;
	sortOrder?: number;
}

export interface ReorderMenuItemsInput {
	items: Array<{
		id: string;
		parentId: string | null;
		sortOrder: number;
	}>;
}

/**
 * Fetch all menus
 */
export async function fetchMenus(): Promise<Menu[]> {
	const response = await apiFetch(`${API_BASE}/menus`);
	return parseApiResponse<Menu[]>(response, "Failed to fetch menus");
}

/**
 * Fetch a single menu with items
 */
export async function fetchMenu(name: string): Promise<MenuWithItems> {
	const response = await apiFetch(`${API_BASE}/menus/${name}`);
	return parseApiResponse<MenuWithItems>(response, "Failed to fetch menu");
}

/**
 * Create a menu
 */
export async function createMenu(input: CreateMenuInput): Promise<Menu> {
	const response = await apiFetch(`${API_BASE}/menus`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<Menu>(response, "Failed to create menu");
}

/**
 * Update a menu
 */
export async function updateMenu(name: string, input: UpdateMenuInput): Promise<Menu> {
	const response = await apiFetch(`${API_BASE}/menus/${name}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<Menu>(response, "Failed to update menu");
}

/**
 * Delete a menu
 */
export async function deleteMenu(name: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/menus/${name}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete menu");
}

/**
 * Create a menu item
 */
export async function createMenuItem(
	menuName: string,
	input: CreateMenuItemInput,
): Promise<MenuItem> {
	const response = await apiFetch(`${API_BASE}/menus/${menuName}/items`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<MenuItem>(response, "Failed to create menu item");
}

/**
 * Update a menu item
 */
export async function updateMenuItem(
	menuName: string,
	itemId: string,
	input: UpdateMenuItemInput,
): Promise<MenuItem> {
	const response = await apiFetch(`${API_BASE}/menus/${menuName}/items?id=${itemId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<MenuItem>(response, "Failed to update menu item");
}

/**
 * Delete a menu item
 */
export async function deleteMenuItem(menuName: string, itemId: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/menus/${menuName}/items?id=${itemId}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete menu item");
}

/**
 * Reorder menu items
 */
export async function reorderMenuItems(
	menuName: string,
	input: ReorderMenuItemsInput,
): Promise<MenuItem[]> {
	const response = await apiFetch(`${API_BASE}/menus/${menuName}/reorder`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<MenuItem[]>(response, "Failed to reorder menu items");
}
