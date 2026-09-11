/**
 * Pure grouping for the admin sidebar: entries that declare the same `group`
 * fold into one collapsible folder positioned where the group first appears.
 */

export interface GroupableNavItem {
	/** Folder label shared by every member; unset keeps the item inline. */
	group?: string;
	/** Members of one folder sort by rank first (stable), then input order. */
	groupRank?: number;
}

export interface NavFolder<T> {
	kind: "folder";
	label: string;
	items: T[];
}

export type NavEntry<T> = { kind: "item"; item: T } | NavFolder<T>;

/** Normalize a declared group label; blank labels mean "no group". */
export function normalizeGroup(group: string | null | undefined): string | undefined {
	const trimmed = group?.trim();
	return trimmed ? trimmed : undefined;
}

export function groupNavItems<T extends GroupableNavItem>(items: readonly T[]): NavEntry<T>[] {
	const entries: NavEntry<T>[] = [];
	const folders = new Map<string, NavFolder<T>>();

	for (const item of items) {
		const label = normalizeGroup(item.group);
		if (!label) {
			entries.push({ kind: "item", item });
			continue;
		}
		let folder = folders.get(label);
		if (!folder) {
			folder = { kind: "folder", label, items: [] };
			folders.set(label, folder);
			entries.push(folder);
		}
		folder.items.push(item);
	}

	for (const folder of folders.values()) {
		folder.items.sort((a, b) => (a.groupRank ?? 0) - (b.groupRank ?? 0));
	}

	return entries;
}

/**
 * Resolve the folder a taxonomy belongs to: the shared group of every
 * collection it is assigned to, or `undefined` when they disagree or none
 * has a group.
 */
export function taxonomyGroup(
	assignedCollections: readonly string[],
	collectionGroups: ReadonlyMap<string, string | undefined>,
): string | undefined {
	if (assignedCollections.length === 0) return undefined;
	let shared: string | undefined;
	for (const slug of assignedCollections) {
		const group = normalizeGroup(collectionGroups.get(slug));
		if (!group || (shared && shared !== group)) return undefined;
		shared = group;
	}
	return shared;
}
