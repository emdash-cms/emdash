/**
 * Personal sidebar layout rules.
 *
 * Pure: no React, no I/O. Every write returns the same object when nothing
 * changes, so callers can skip a save by identity.
 */

import type { NavEntry } from "./sidebar-groups.js";

export type LayoutScope = "nav" | "editor";

/** One list's personal arrangement. `order` is flat: each sibling set sorts by relative position. */
export interface ListLayout {
	readonly order: readonly string[];
	readonly hidden: readonly string[];
}

/** Mirrors core's `adminLayoutSchema`; the server is the validation authority. */
export interface AdminLayout {
	readonly version: 1;
	readonly nav: ListLayout;
	readonly editor: ListLayout;
}

export const EMPTY_LIST_LAYOUT: ListLayout = Object.freeze({
	order: Object.freeze([]),
	hidden: Object.freeze([]),
});

export const EMPTY_ADMIN_LAYOUT: AdminLayout = Object.freeze({
	version: 1,
	nav: EMPTY_LIST_LAYOUT,
	editor: EMPTY_LIST_LAYOUT,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isIdList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
}

function parseList(raw: unknown): ListLayout | null {
	if (!isRecord(raw) || !isIdList(raw.order) || !isIdList(raw.hidden)) return null;
	return { order: [...new Set(raw.order)], hidden: [...new Set(raw.hidden)] };
}

/**
 * Read a layout from `/auth/me`. Missing, malformed, or wrong-version values
 * count as no layout; duplicate IDs are dropped, keeping the first.
 */
export function parseAdminLayout(raw: unknown): AdminLayout {
	if (!isRecord(raw) || raw.version !== 1) return EMPTY_ADMIN_LAYOUT;
	const nav = parseList(raw.nav);
	const editor = parseList(raw.editor);
	return nav && editor ? { version: 1, nav, editor } : EMPTY_ADMIN_LAYOUT;
}

export function isCustomized(list: ListLayout): boolean {
	return list.order.length > 0 || list.hidden.length > 0;
}

/** The value to send: `null` removes the stored key when both lists are back to default. */
export function toStoredAdminLayout(layout: AdminLayout): AdminLayout | null {
	return isCustomized(layout.nav) || isCustomized(layout.editor) ? layout : null;
}

/** `layout` with one list replaced, or `layout` itself when the list is unchanged. */
export function replaceList(
	layout: AdminLayout,
	scope: LayoutScope,
	list: ListLayout,
): AdminLayout {
	if (layout[scope] === list) return layout;
	return scope === "nav" ? { ...layout, nav: list } : { ...layout, editor: list };
}

const DASHBOARD_ID = "/";
const PUBLISH_ID = "publish";
const FOLDER_PREFIX = "folder:";
const QUERY_OR_HASH = /[?#]/;
const TRAILING_SLASHES = /\/+$/;

export function navPathId(path: string): string {
	const cut = path.search(QUERY_OR_HASH);
	const pathname = cut === -1 ? path : path.slice(0, cut);
	return pathname.replace(TRAILING_SLASHES, "") || DASHBOARD_ID;
}

/** A folder is identified by its label, so renaming a folder resets its position. */
function navFolderId(label: string): string {
	return `${FOLDER_PREFIX}${label}`;
}

const EDITOR_SECTIONS_BEFORE_PLUGINS = [
	"publish",
	"url-language",
	"ownership",
	"bylines",
	"translations",
	"taxonomies",
	"seo",
] as const;

const EDITOR_SECTIONS_AFTER_PLUGINS = ["outline", "revisions"] as const;

export type BuiltInEditorSectionId =
	| (typeof EDITOR_SECTIONS_BEFORE_PLUGINS)[number]
	| (typeof EDITOR_SECTIONS_AFTER_PLUGINS)[number];

export type PluginEditorSectionId =
	| `plugin:${string}:${string}`
	| `sandbox-plugin:${string}:${string}`;

/**
 * Every ID an editor section can carry. A new built-in section must be added
 * to the lists above, which fixes its default position, before it can render.
 */
export type EditorSectionId = BuiltInEditorSectionId | PluginEditorSectionId;

export const BUILT_IN_EDITOR_SECTION_IDS: readonly BuiltInEditorSectionId[] = [
	...EDITOR_SECTIONS_BEFORE_PLUGINS,
	...EDITOR_SECTIONS_AFTER_PLUGINS,
];

const PLUGIN_SECTION_PREFIXES = ["plugin:", "sandbox-plugin:"] as const;

function editorDefaultRank(id: string): number {
	const before = EDITOR_SECTIONS_BEFORE_PLUGINS.findIndex((sectionId) => sectionId === id);
	if (before !== -1) return before;
	const pluginSlot = EDITOR_SECTIONS_BEFORE_PLUGINS.length;
	if (PLUGIN_SECTION_PREFIXES.some((prefix) => id.startsWith(prefix))) return pluginSlot;
	const after = EDITOR_SECTIONS_AFTER_PLUGINS.findIndex((sectionId) => sectionId === id);
	if (after !== -1) return pluginSlot + 1 + after;
	return Number.MAX_SAFE_INTEGER;
}

function isPinned(scope: LayoutScope, id: string): boolean {
	return scope === "nav" && id === DASHBOARD_ID;
}

function canHide(scope: LayoutScope, id: string): boolean {
	if (scope === "nav") return id !== DASHBOARD_ID && !id.startsWith(FOLDER_PREFIX);
	return id !== PUBLISH_ID;
}

export interface ArrangedFlags {
	/** The user hid it, or (folders, groups) everything inside is hidden. */
	readonly hidden: boolean;
	readonly canMove: boolean;
	readonly canHide: boolean;
}

export interface ArrangedRow<T extends { id: string }> extends ArrangedFlags {
	readonly id: string;
	readonly item: T;
}

/** One navigation group as the builder produced it: entries in default order, folders formed. */
export interface LayoutNavGroup<T extends { id: string }> {
	readonly key: string;
	readonly label: string | null;
	readonly entries: readonly NavEntry<T>[];
}

export interface ArrangedNavFolder<T extends { id: string }> extends ArrangedFlags {
	readonly kind: "folder";
	readonly id: string;
	readonly label: string;
	readonly iconName?: string;
	readonly items: readonly ArrangedRow<T>[];
}

export type ArrangedNavEntry<T extends { id: string }> =
	| (ArrangedRow<T> & { readonly kind: "item" })
	| ArrangedNavFolder<T>;

export interface ArrangedNavGroup<T extends { id: string }> {
	readonly key: string;
	readonly label: string | null;
	/** Every entry is hidden: the navigation drops the group, heading included. */
	readonly hidden: boolean;
	readonly entries: readonly ArrangedNavEntry<T>[];
}

interface ListIndex {
	readonly scope: LayoutScope;
	readonly position: ReadonlyMap<string, number>;
	readonly hidden: ReadonlySet<string>;
}

function indexList(scope: LayoutScope, list: ListLayout): ListIndex {
	const position = new Map<string, number>();
	list.order.forEach((id, index) => {
		if (!position.has(id)) position.set(id, index);
	});
	return { scope, position, hidden: new Set(list.hidden) };
}

/**
 * Stable sort of one sibling set: pinned IDs first, then IDs listed in
 * `order` by their first position, then the rest by default rank and input
 * position. Nothing is dropped, even when two items share an ID.
 */
function orderSiblings<T>(
	index: ListIndex,
	items: readonly T[],
	idOf: (item: T) => string,
	defaultRank: (item: T, inputPosition: number) => number,
): T[] {
	return items
		.map((item, inputPosition) => {
			const id = idOf(item);
			const saved = isPinned(index.scope, id)
				? -1
				: (index.position.get(id) ?? Number.MAX_SAFE_INTEGER);
			return { item, inputPosition, saved, fallback: defaultRank(item, inputPosition) };
		})
		.toSorted(
			(a, b) => a.saved - b.saved || a.fallback - b.fallback || a.inputPosition - b.inputPosition,
		)
		.map((entry) => entry.item);
}

function arrangeRow<T extends { id: string }>(index: ListIndex, item: T): ArrangedRow<T> {
	const hideable = canHide(index.scope, item.id);
	return {
		id: item.id,
		item,
		hidden: hideable && index.hidden.has(item.id),
		canMove: !isPinned(index.scope, item.id),
		canHide: hideable,
	};
}

const byInputPosition = (_item: unknown, inputPosition: number) => inputPosition;

/**
 * The editor sections in resolved order with their flags. Built-ins take
 * their default position from this module whatever order they arrive in;
 * plugin panels must arrive in their declared order.
 */
export function arrangeEditor<T extends { id: string }>(
	sections: readonly T[],
	list: ListLayout,
): ArrangedRow<T>[] {
	const index = indexList("editor", list);
	return orderSiblings(
		index,
		sections,
		(section) => section.id,
		(section) => editorDefaultRank(section.id),
	).map((section) => arrangeRow(index, section));
}

export function resolveEditor<T extends { id: string }>(
	sections: readonly T[],
	list: ListLayout,
): T[] {
	return arrangeEditor(sections, list)
		.filter((row) => !row.hidden)
		.map((row) => row.item);
}

function navEntryId<T extends { id: string }>(entry: NavEntry<T>): string {
	return entry.kind === "item" ? entry.item.id : navFolderId(entry.label);
}

function arrangeNavEntry<T extends { id: string }>(
	index: ListIndex,
	entry: NavEntry<T>,
): ArrangedNavEntry<T> {
	if (entry.kind === "item") return { kind: "item", ...arrangeRow(index, entry.item) };
	const items = orderSiblings(index, entry.items, (item) => item.id, byInputPosition).map((item) =>
		arrangeRow(index, item),
	);
	return {
		kind: "folder",
		id: navFolderId(entry.label),
		label: entry.label,
		iconName: entry.iconName,
		items,
		hidden: items.every((item) => item.hidden),
		canMove: true,
		canHide: false,
	};
}

/**
 * The navigation in resolved order with flags, hidden rows included. Order
 * applies per sibling set: a group's top-level entries, and each folder's
 * members. The builder's order (`groupNavItems` included) is only the default.
 */
export function arrangeNav<T extends { id: string }>(
	groups: readonly LayoutNavGroup<T>[],
	list: ListLayout,
): ArrangedNavGroup<T>[] {
	const index = indexList("nav", list);
	return groups.map((group) => {
		const entries = orderSiblings(index, group.entries, navEntryId, byInputPosition).map((entry) =>
			arrangeNavEntry(index, entry),
		);
		return {
			key: group.key,
			label: group.label,
			hidden: entries.every((entry) => entry.hidden),
			entries,
		};
	});
}

/** The navigation to render: hidden entries, emptied folders, and emptied groups removed. */
export function resolveNav<T extends { id: string }>(
	groups: readonly LayoutNavGroup<T>[],
	list: ListLayout,
): LayoutNavGroup<T>[] {
	return arrangeNav(groups, list)
		.filter((group) => !group.hidden)
		.map((group) => ({
			key: group.key,
			label: group.label,
			entries: group.entries
				.filter((entry) => !entry.hidden)
				.map(
					(entry): NavEntry<T> =>
						entry.kind === "item"
							? { kind: "item", item: entry.item }
							: {
									kind: "folder",
									label: entry.label,
									iconName: entry.iconName,
									items: entry.items.filter((item) => !item.hidden).map((item) => item.item),
								},
				),
		}));
}

/**
 * Show or hide one row. Only `hidden` changes; IDs this page can't match
 * stay, so an entry hidden before its plugin was disabled is still hidden
 * when the plugin returns. A row that can't be hidden is left alone.
 */
export function setHidden(
	scope: LayoutScope,
	list: ListLayout,
	id: string,
	hidden: boolean,
): ListLayout {
	if (!canHide(scope, id) || list.hidden.includes(id) === hidden) return list;
	return {
		order: list.order,
		hidden: hidden ? [...list.hidden, id] : list.hidden.filter((hiddenId) => hiddenId !== id),
	};
}

/** `ids` with `activeId` moved to `overId`'s index, or `null` when either is absent or they match. */
function moveWithin(ids: readonly string[], activeId: string, overId: string): string[] | null {
	const from = ids.indexOf(activeId);
	const to = ids.indexOf(overId);
	if (from === -1 || to === -1 || from === to) return null;
	const moved = ids.toSpliced(from, 1);
	moved.splice(to, 0, activeId);
	return moved;
}

/**
 * Move one editor section onto another's position and write the order of
 * every section the list shows, hidden ones included, which drops IDs it
 * can't match. Returns `list` itself for a no-op move.
 */
export function moveEditorSection<T extends { id: string }>(
	sections: readonly T[],
	list: ListLayout,
	activeId: string,
	overId: string,
): ListLayout {
	const ids = arrangeEditor(sections, list)
		.filter((row) => row.canMove)
		.map((row) => row.id);
	const order = moveWithin(ids, activeId, overId);
	return order ? { order, hidden: list.hidden } : list;
}

function movableIds(rows: readonly { id: string; canMove: boolean }[]): string[] {
	return rows.filter((row) => row.canMove).map((row) => row.id);
}

/**
 * Move one navigation entry within its sibling set (its group's top level,
 * or its folder) and write the order of every movable entry the Navigation
 * list shows, hidden ones included. Moves across sibling sets, onto or of a
 * pinned entry, and onto itself return `list` itself.
 */
export function moveNavEntry<T extends { id: string }>(
	groups: readonly LayoutNavGroup<T>[],
	list: ListLayout,
	activeId: string,
	overId: string,
): ListLayout {
	let moved = false;
	const order: string[] = [];
	const writeSet = (ids: string[]): string[] => {
		const next = moveWithin(ids, activeId, overId);
		if (!next) return ids;
		moved = true;
		return next;
	};

	for (const group of arrangeNav(groups, list)) {
		const folders = new Map<string, ArrangedNavFolder<T>>();
		for (const entry of group.entries) if (entry.kind === "folder") folders.set(entry.id, entry);
		for (const id of writeSet(movableIds(group.entries))) {
			order.push(id);
			const folder = folders.get(id);
			if (folder) order.push(...writeSet(movableIds(folder.items)));
		}
	}

	return moved ? { order, hidden: list.hidden } : list;
}
