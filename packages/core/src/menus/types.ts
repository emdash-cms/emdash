/**
 * Menu item types
 */
export type MenuItemType = string;

/**
 * Menu item as returned to templates (with resolved URL)
 */
export interface MenuItem {
	id: string;
	label: string;
	url: string; // Resolved URL
	target?: string; // '_blank' etc
	titleAttr?: string; // title="" attribute
	cssClasses?: string;
	children: MenuItem[]; // Nested items
}

/**
 * Menu as returned to templates
 */
export interface Menu {
	id: string;
	name: string;
	label: string;
	items: MenuItem[];
	locale: string;
	translationGroup: string | null;
}

/**
 * Menu item as stored in database
 */
export interface MenuItemRow {
	id: string;
	menu_id: string;
	parent_id: string | null;
	sort_order: number;
	type: MenuItemType;
	reference_collection: string | null;
	reference_id: string | null; // translation_group of referenced content/term
	custom_url: string | null;
	label: string;
	title_attr: string | null;
	target: string | null;
	css_classes: string | null;
	created_at: string;
	locale: string;
	translation_group: string | null;
}

/**
 * Menu as stored in database
 */
export interface MenuRow {
	id: string;
	name: string;
	label: string;
	created_at: string;
	updated_at: string;
	locale: string;
	translation_group: string | null;
}

/**
 * Input for creating a menu item
 */
export interface CreateMenuItemInput {
	type: MenuItemType;
	label: string;
	/**
	 * Identifier of the referenced entity. For `reference_collection` items it is
	 * the content's translation_group (locale-agnostic); for `taxonomy` items it
	 * is the term's translation_group.
	 */
	referenceCollection?: string;
	referenceId?: string;
	customUrl?: string;
	target?: string;
	titleAttr?: string;
	cssClasses?: string;
	parentId?: string;
	sortOrder?: number;
}

/**
 * Input for updating a menu item
 */
export interface UpdateMenuItemInput {
	label?: string;
	customUrl?: string;
	target?: string;
	titleAttr?: string;
	cssClasses?: string;
	parentId?: string | null;
	sortOrder?: number;
}

/**
 * Input for creating a menu
 */
export interface CreateMenuInput {
	name: string;
	label: string;
	locale?: string;
	/** When set, links the new menu into an existing translation_group. */
	translationOf?: string;
}

/**
 * Input for updating a menu
 */
export interface UpdateMenuInput {
	label?: string;
}

/**
 * Input for reordering menu items
 */
export interface ReorderMenuItemsInput {
	items: Array<{
		id: string;
		parentId: string | null;
		sortOrder: number;
	}>;
}
