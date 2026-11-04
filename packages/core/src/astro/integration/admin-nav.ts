/**
 * Built-in admin navigation entries that `admin.hiddenNavItems` can hide.
 */
export const HIDEABLE_ADMIN_NAV_ITEMS = [
	"calendar",
	"media",
	"comments",
	"menus",
	"redirects",
	"widgets",
	"sections",
	"bylines",
	"import",
] as const;

export type HideableAdminNavItem = (typeof HIDEABLE_ADMIN_NAV_ITEMS)[number];

const HIDEABLE = new Set<string>(HIDEABLE_ADMIN_NAV_ITEMS);

function isHideableAdminNavItem(entry: unknown): entry is HideableAdminNavItem {
	return typeof entry === "string" && HIDEABLE.has(entry);
}

/**
 * Validate a user-supplied `admin.hiddenNavItems` list. Duplicates are
 * dropped. Throws, naming every unrecognized entry and listing the valid
 * names, if any entry is not a hideable navigation item.
 */
export function resolveHiddenNavItems(requested: unknown): HideableAdminNavItem[] {
	if (!Array.isArray(requested)) {
		throw new Error("`admin.hiddenNavItems` must be an array of navigation item names.");
	}
	const entries: unknown[] = requested;
	const resolved = new Set<HideableAdminNavItem>();
	const unknownEntries: string[] = [];
	for (const entry of entries) {
		if (isHideableAdminNavItem(entry)) {
			resolved.add(entry);
		} else {
			unknownEntries.push(String(JSON.stringify(entry)));
		}
	}

	if (unknownEntries.length > 0) {
		throw new Error(
			`Unknown navigation item${unknownEntries.length === 1 ? "" : "s"} in \`admin.hiddenNavItems\`: ` +
				`${unknownEntries.join(", ")}. Valid names: ${HIDEABLE_ADMIN_NAV_ITEMS.join(", ")}.`,
		);
	}

	return [...resolved];
}
