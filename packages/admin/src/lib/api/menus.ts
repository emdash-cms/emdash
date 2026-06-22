/**
 * Menu management APIs.
 *
 * i18n: all endpoints accept an optional `locale`. When omitted, the server
 * returns or acts on all locales (legacy behaviour for clients that haven't
 * been updated yet).
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface Menu {
	id: string;
	name: string;
	label: string;
	createdAt: string;
	updatedAt: string;
	itemCount?: number;
	locale: string;
	translationGroup: string | null;
}

export interface MenuItem {
	id: string;
	menuId: string;
	parentId: string | null;
	sortOrder: number;
	type: string;
	referenceCollection: string | null;
	referenceId: string | null;
	customUrl: string | null;
	label: string;
	titleAttr: string | null;
	target: string | null;
	cssClasses: string | null;
	createdAt: string;
	locale: string;
	translationGroup: string | null;
}

export interface MenuWithItems extends Menu {
	items: MenuItem[];
}

export interface MenuTranslation {
	id: string;
	name: string;
	label: string;
	locale: string;
	updatedAt: string;
}

export interface MenuTranslationsResponse {
	translationGroup: string | null;
	translations: MenuTranslation[];
}

export interface CreateMenuInput {
	name: string;
	label: string;
	locale?: string;
	translationOf?: string;
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

export interface LocaleOptions {
	locale?: string;
}

function withLocale(path: string, locale?: string): string {
	return locale
		? `${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(locale)}`
		: path;
}

/**
 * Fetch all menus
 */
export async function fetchMenus(options: LocaleOptions = {}): Promise<Menu[]> {
	const response = await apiFetch(withLocale(`${API_BASE}/menus`, options.locale));
	return parseApiResponse<Menu[]>(response, "Failed to fetch menus");
}

/**
 * Fetch a single menu with items
 */
export async function fetchMenu(name: string, options: LocaleOptions = {}): Promise<MenuWithItems> {
	const response = await apiFetch(withLocale(`${API_BASE}/menus/${name}`, options.locale));
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
export async function updateMenu(
	name: string,
	input: UpdateMenuInput,
	options: LocaleOptions = {},
): Promise<Menu> {
	const response = await apiFetch(withLocale(`${API_BASE}/menus/${name}`, options.locale), {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return parseApiResponse<Menu>(response, "Failed to update menu");
}

/**
 * Delete a menu
 */
export async function deleteMenu(name: string, options: LocaleOptions = {}): Promise<void> {
	const response = await apiFetch(withLocale(`${API_BASE}/menus/${name}`, options.locale), {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete menu`));
}

/**
 * Create a menu item
 */
export async function createMenuItem(
	menuName: string,
	input: CreateMenuItemInput,
	options: LocaleOptions = {},
): Promise<MenuItem> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/menus/${menuName}/items`, options.locale),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	return parseApiResponse<MenuItem>(response, "Failed to create menu item");
}

/**
 * Update a menu item
 */
export async function updateMenuItem(
	menuName: string,
	itemId: string,
	input: UpdateMenuItemInput,
	options: LocaleOptions = {},
): Promise<MenuItem> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/menus/${menuName}/items/${itemId}`, options.locale),
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	return parseApiResponse<MenuItem>(response, "Failed to update menu item");
}

/**
 * Delete a menu item
 */
export async function deleteMenuItem(
	menuName: string,
	itemId: string,
	options: LocaleOptions = {},
): Promise<void> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/menus/${menuName}/items/${itemId}`, options.locale),
		{ method: "DELETE" },
	);
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to delete menu item`));
}

/**
 * Reorder menu items
 */
export async function reorderMenuItems(
	menuName: string,
	input: ReorderMenuItemsInput,
	options: LocaleOptions = {},
): Promise<MenuItem[]> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/menus/${menuName}/reorder`, options.locale),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	return parseApiResponse<MenuItem[]>(response, "Failed to reorder menu items");
}

/** List every translation (locale variant) of a menu. */
export async function fetchMenuTranslations(
	name: string,
	options: LocaleOptions = {},
): Promise<MenuTranslationsResponse> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/menus/${name}/translations`, options.locale),
	);
	return parseApiResponse<MenuTranslationsResponse>(response, "Failed to fetch menu translations");
}

/**
 * Create a new locale translation of a menu. The new menu inherits the
 * source's items and label unless overridden.
 */
export async function createMenuTranslation(
	name: string,
	input: { locale: string; label?: string },
	options: LocaleOptions = {},
): Promise<Menu> {
	const response = await apiFetch(
		withLocale(`${API_BASE}/menus/${name}/translations`, options.locale),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	return parseApiResponse<Menu>(response, "Failed to create menu translation");
}
