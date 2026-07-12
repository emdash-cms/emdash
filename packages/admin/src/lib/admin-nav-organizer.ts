/**
 * Navigation organizer draft state.
 *
 * Pure editing model behind Settings → Navigation. A draft is created from
 * the resolved nav model (so it always reflects what the sidebar would
 * render), edited through the op functions below (each returns a new
 * draft), and serialized back to the sparse `AdminNavigationConfig` the
 * server stores.
 *
 * Serialization stays deliberately minimal:
 * - default groups are written only when moved/renamed/collapse-changed,
 *   and their label only when renamed — so default labels keep translating
 * - items are always written with explicit group + order (the admin's
 *   layout is intentional); hidden items carry only the hidden flag and
 *   return to their default group when shown again
 * - the dashboard block is never part of the draft: `core:dashboard` stays
 *   pinned first and any hand-written config placing it elsewhere resets
 *   on the next organizer save
 */

import type {
	AdminNavigationConfig,
	AdminNavigationGroupConfig,
	AdminNavigationItemConfig,
	AdminNavModel,
} from "./admin-nav";

export const DEFAULT_GROUP_IDS: ReadonlySet<string> = new Set([
	"content",
	"manage",
	"admin",
	"plugins",
]);

const DEFAULT_GROUP_IMPLICIT_ORDER: Record<string, number> = {
	content: 100,
	manage: 200,
	admin: 300,
	plugins: 400,
};

/** Matches the server-side group id rules. */
const GROUP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
const GROUP_ID_MAX_LENGTH = 63;
const RESERVED_GROUP_IDS = new Set(["dashboard"]);
const GROUP_ORDER_STEP = 100;

export interface OrganizerGroup {
	id: string;
	isDefault: boolean;
	/**
	 * Admin-authored name (site data). Absent on a default group means the
	 * translated default label still applies.
	 */
	customLabel?: string;
	collapsedByDefault: boolean;
	/** Item ids in display order. */
	itemIds: string[];
}

export interface OrganizerDraft {
	groups: OrganizerGroup[];
	/** Item ids hidden from the sidebar, in stable order. */
	hiddenIds: string[];
}

/** itemId → its default group id, for delete-group and unhide targets. */
export type ItemDefaultGroups = ReadonlyMap<string, string>;

/**
 * Build the draft from a resolved model. Pass a model built with
 * `includeEmptyGroups: true` so every group is available as a move target.
 */
export function createOrganizerDraft(model: AdminNavModel): OrganizerDraft {
	return {
		groups: model.groups
			.filter((group) => group.id !== "dashboard")
			.map((group) => ({
				id: group.id,
				isDefault: DEFAULT_GROUP_IDS.has(group.id),
				// A default group with a string label was renamed by config;
				// descriptor labels are the translatable defaults.
				customLabel: typeof group.label === "string" ? group.label : undefined,
				collapsedByDefault: group.collapsedByDefault,
				itemIds: group.items.filter((item) => item.id !== "core:dashboard").map((item) => item.id),
			})),
		hiddenIds: model.hiddenItems.map((item) => item.id),
	};
}

export function buildItemDefaultGroups(model: AdminNavModel): ItemDefaultGroups {
	const map = new Map<string, string>();
	for (const group of model.groups) {
		for (const item of group.items) map.set(item.id, item.defaultGroupId);
	}
	for (const item of model.hiddenItems) map.set(item.id, item.defaultGroupId);
	return map;
}

/**
 * Derive a valid, unused group id from an admin-authored name. Non-Latin
 * names (which slugify to nothing) fall back to `group`, then uniquify.
 */
export function generateGroupId(label: string, takenIds: Iterable<string>): string {
	const taken = new Set(takenIds);
	for (const reserved of RESERVED_GROUP_IDS) taken.add(reserved);

	let base = label
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.slice(0, GROUP_ID_MAX_LENGTH);
	if (!GROUP_ID_PATTERN.test(base)) base = "group";

	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base.slice(0, GROUP_ID_MAX_LENGTH - String(n).length - 1)}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export function addOrganizerGroup(draft: OrganizerDraft, label: string): OrganizerDraft {
	const trimmed = label.trim();
	if (!trimmed) return draft;
	const id = generateGroupId(
		trimmed,
		draft.groups.map((group) => group.id),
	);
	return {
		...draft,
		groups: [
			...draft.groups,
			{ id, isDefault: false, customLabel: trimmed, collapsedByDefault: false, itemIds: [] },
		],
	};
}

export function renameOrganizerGroup(
	draft: OrganizerDraft,
	groupId: string,
	label: string,
): OrganizerDraft {
	const trimmed = label.trim();
	if (!trimmed) return draft;
	return {
		...draft,
		groups: draft.groups.map((group) =>
			group.id === groupId ? { ...group, customLabel: trimmed } : group,
		),
	};
}

/** Delete a custom group; its items return to their default groups. */
export function deleteOrganizerGroup(
	draft: OrganizerDraft,
	groupId: string,
	defaultGroups: ItemDefaultGroups,
): OrganizerDraft {
	const target = draft.groups.find((group) => group.id === groupId);
	if (!target || target.isDefault) return draft;

	const remaining = draft.groups.filter((group) => group.id !== groupId);
	const fallbackId = remaining[0]?.id;
	const additions = new Map<string, string[]>();
	for (const itemId of target.itemIds) {
		const homeId = defaultGroups.get(itemId) ?? "content";
		const resolved = remaining.some((group) => group.id === homeId) ? homeId : fallbackId;
		if (resolved === undefined) continue;
		additions.set(resolved, [...(additions.get(resolved) ?? []), itemId]);
	}
	return {
		...draft,
		groups: remaining.map((group) => {
			const added = additions.get(group.id);
			return added ? { ...group, itemIds: [...group.itemIds, ...added] } : group;
		}),
	};
}

export function moveOrganizerGroup(
	draft: OrganizerDraft,
	groupId: string,
	direction: -1 | 1,
): OrganizerDraft {
	const index = draft.groups.findIndex((group) => group.id === groupId);
	const target = index + direction;
	if (index === -1 || target < 0 || target >= draft.groups.length) return draft;
	const groups = [...draft.groups];
	const [moved] = groups.splice(index, 1);
	if (!moved) return draft;
	groups.splice(target, 0, moved);
	return { ...draft, groups };
}

export function setOrganizerGroupCollapsedByDefault(
	draft: OrganizerDraft,
	groupId: string,
	collapsedByDefault: boolean,
): OrganizerDraft {
	return {
		...draft,
		groups: draft.groups.map((group) =>
			group.id === groupId ? { ...group, collapsedByDefault } : group,
		),
	};
}

/** Move an item to the end of another group. */
export function moveOrganizerItem(
	draft: OrganizerDraft,
	itemId: string,
	targetGroupId: string,
): OrganizerDraft {
	const from = draft.groups.find((group) => group.itemIds.includes(itemId));
	if (!from || from.id === targetGroupId) return draft;
	if (!draft.groups.some((group) => group.id === targetGroupId)) return draft;
	return {
		...draft,
		groups: draft.groups.map((group) => {
			if (group.id === from.id) {
				return { ...group, itemIds: group.itemIds.filter((id) => id !== itemId) };
			}
			if (group.id === targetGroupId) {
				return { ...group, itemIds: [...group.itemIds, itemId] };
			}
			return group;
		}),
	};
}

/** Move an item one position up/down within its group. */
export function moveOrganizerItemInGroup(
	draft: OrganizerDraft,
	itemId: string,
	direction: -1 | 1,
): OrganizerDraft {
	const group = draft.groups.find((entry) => entry.itemIds.includes(itemId));
	if (!group) return draft;
	const index = group.itemIds.indexOf(itemId);
	const target = index + direction;
	if (target < 0 || target >= group.itemIds.length) return draft;
	const itemIds = [...group.itemIds];
	const swapped = itemIds[target];
	if (swapped === undefined) return draft;
	itemIds[target] = itemId;
	itemIds[index] = swapped;
	return {
		...draft,
		groups: draft.groups.map((entry) => (entry.id === group.id ? { ...entry, itemIds } : entry)),
	};
}

export function hideOrganizerItem(draft: OrganizerDraft, itemId: string): OrganizerDraft {
	if (draft.hiddenIds.includes(itemId)) return draft;
	return {
		groups: draft.groups.map((group) =>
			group.itemIds.includes(itemId)
				? { ...group, itemIds: group.itemIds.filter((id) => id !== itemId) }
				: group,
		),
		hiddenIds: [...draft.hiddenIds, itemId],
	};
}

/** Unhide an item; it returns to the end of its default group. */
export function showOrganizerItem(
	draft: OrganizerDraft,
	itemId: string,
	defaultGroups: ItemDefaultGroups,
): OrganizerDraft {
	if (!draft.hiddenIds.includes(itemId)) return draft;
	const homeId = defaultGroups.get(itemId) ?? "content";
	const hasHome = draft.groups.some((group) => group.id === homeId);
	const targetId = hasHome ? homeId : (draft.groups[0]?.id ?? homeId);
	return {
		groups: draft.groups.map((group) =>
			group.id === targetId ? { ...group, itemIds: [...group.itemIds, itemId] } : group,
		),
		hiddenIds: draft.hiddenIds.filter((id) => id !== itemId),
	};
}

/**
 * Serialize the draft to the stored config shape. Group orders are
 * assigned from on-screen position as (index + 1) × 100; a default group
 * matching its implicit slot with no rename/collapse override is omitted
 * entirely so future default changes keep applying.
 */
export function serializeOrganizerDraft(draft: OrganizerDraft): AdminNavigationConfig {
	const groups: AdminNavigationGroupConfig[] = [];
	draft.groups.forEach((group, index) => {
		const order = (index + 1) * GROUP_ORDER_STEP;
		const unchangedDefault =
			group.isDefault &&
			order === DEFAULT_GROUP_IMPLICIT_ORDER[group.id] &&
			group.customLabel === undefined &&
			!group.collapsedByDefault;
		if (unchangedDefault) return;

		const entry: AdminNavigationGroupConfig = { id: group.id, order };
		if (group.customLabel !== undefined) entry.label = group.customLabel;
		if (group.collapsedByDefault) entry.collapsedByDefault = true;
		groups.push(entry);
	});

	const items: AdminNavigationItemConfig[] = [];
	for (const group of draft.groups) {
		group.itemIds.forEach((id, index) => {
			items.push({ id, groupId: group.id, order: index });
		});
	}
	for (const id of draft.hiddenIds) {
		items.push({ id, hidden: true });
	}

	return { version: 1, groups, items };
}

/** Structural equality via the serialized form — used for dirty tracking. */
export function organizerDraftsEqual(a: OrganizerDraft, b: OrganizerDraft): boolean {
	return JSON.stringify(serializeOrganizerDraft(a)) === JSON.stringify(serializeOrganizerDraft(b));
}
