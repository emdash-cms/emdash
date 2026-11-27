import { arrayMove } from "@dnd-kit/sortable";

import type { MenuItem, ReorderMenuItemsInput } from "../../lib/api";

/** Levels a menu can have: top level plus two nested levels. */
export const MAX_DEPTH = 3;

/** Inline indent per nesting level, in pixels. */
export const INDENT_WIDTH = 24;

/** A menu item with its place in the tree, in parent-then-children display order. */
export interface FlatMenuItem {
	id: string;
	parentId: string | null;
	depth: number;
	item: MenuItem;
}

function groupByParent(items: readonly MenuItem[]): Map<string | null, MenuItem[]> {
	const childrenByParent = new Map<string | null, MenuItem[]>();
	for (const item of items) {
		const siblings = childrenByParent.get(item.parentId) ?? [];
		siblings.push(item);
		childrenByParent.set(item.parentId, siblings);
	}
	return childrenByParent;
}

/**
 * Flattens items into parent-then-children display order. Siblings keep their
 * order in `items`. A visited set guards against cyclic parentId data from
 * older API writes.
 */
export function flattenMenu(items: readonly MenuItem[]): FlatMenuItem[] {
	const childrenByParent = groupByParent(items);
	const result: FlatMenuItem[] = [];
	const visited = new Set<string>();
	function visit(parentId: string | null, depth: number) {
		for (const item of childrenByParent.get(parentId) ?? []) {
			if (visited.has(item.id)) continue;
			visited.add(item.id);
			result.push({ id: item.id, parentId: item.parentId, depth, item });
			visit(item.id, depth + 1);
		}
	}
	visit(null, 0);
	return result;
}

/** IDs of everything nested under `rootId`, not including it. */
export function getDescendantIds(items: readonly MenuItem[], rootId: string): Set<string> {
	const childrenByParent = groupByParent(items);
	const ids = new Set<string>();
	function visit(parentId: string) {
		for (const child of childrenByParent.get(parentId) ?? []) {
			if (ids.has(child.id) || child.id === rootId) continue;
			ids.add(child.id);
			visit(child.id);
		}
	}
	visit(rootId);
	return ids;
}

/** Levels below `id` in its subtree: 0 for a leaf, 1 when it has children only, and so on. */
function subtreeHeight(flat: readonly FlatMenuItem[], id: string): number {
	const index = flat.findIndex((entry) => entry.id === id);
	const root = flat[index];
	if (!root) return 0;
	let height = 0;
	for (let i = index + 1; i < flat.length; i++) {
		const entry = flat[i]!;
		if (entry.depth <= root.depth) break;
		height = Math.max(height, entry.depth - root.depth);
	}
	return height;
}

/** The deepest depth `id` can sit at so its own subtree stays inside `MAX_DEPTH`. */
export function deepestAllowedDepth(flat: readonly FlatMenuItem[], id: string): number {
	return MAX_DEPTH - 1 - subtreeHeight(flat, id);
}

/** Removes the items nested under any of `ids`, so a dragged parent carries its children. */
export function removeChildrenOf(
	flat: readonly FlatMenuItem[],
	ids: readonly string[],
): FlatMenuItem[] {
	const excluded = new Set(ids);
	return flat.filter((entry) => {
		if (entry.parentId !== null && excluded.has(entry.parentId)) {
			excluded.add(entry.id);
			return false;
		}
		return true;
	});
}

export interface Projection {
	depth: number;
	minDepth: number;
	maxDepth: number;
	parentId: string | null;
}

/**
 * Where a dragged item lands: the depth its horizontal offset asks for,
 * clamped to what its neighbours at the drop position allow and to
 * `maxAllowedDepth`, plus the parent that depth implies. Null when the item
 * can't go there, because the row below it would have to nest under it
 * deeper than `maxAllowedDepth` allows.
 */
export function getProjection(
	flat: readonly FlatMenuItem[],
	activeId: string,
	overId: string,
	depthOffset: number,
	maxAllowedDepth: number,
): Projection | null {
	const overIndex = flat.findIndex((entry) => entry.id === overId);
	const activeIndex = flat.findIndex((entry) => entry.id === activeId);
	const active = flat[activeIndex];
	if (!active || overIndex === -1) return null;

	const moved = arrayMove([...flat], activeIndex, overIndex);
	const previous = moved[overIndex - 1];
	const next = moved[overIndex + 1];
	const maxDepth = Math.max(0, Math.min(previous ? previous.depth + 1 : 0, maxAllowedDepth));
	const minDepth = next ? next.depth : 0;
	if (minDepth > maxDepth) return null;
	const depth = Math.min(Math.max(active.depth + depthOffset, minDepth), maxDepth);

	let parentId: string | null = null;
	if (depth > 0 && previous) {
		if (depth === previous.depth) parentId = previous.parentId;
		else if (depth > previous.depth) parentId = previous.id;
		else {
			parentId =
				moved
					.slice(0, overIndex)
					.toReversed()
					.find((entry) => entry.depth === depth)?.parentId ?? null;
		}
	}
	return { depth, minDepth, maxDepth, parentId };
}

/**
 * Items in display order with `parentId` and `sortOrder` rewritten from a
 * flat arrangement, where sibling order is the order in `flat`.
 */
function itemsFromFlat(flat: readonly { item: MenuItem; parentId: string | null }[]) {
	const counters = new Map<string | null, number>();
	return flat.map(({ item, parentId }) => {
		const sortOrder = counters.get(parentId) ?? 0;
		counters.set(parentId, sortOrder + 1);
		return { ...item, parentId, sortOrder };
	});
}

/** The flat display order after moving `activeId` to `overId`'s place with a new parent. */
export function applyDrop(
	items: readonly MenuItem[],
	activeId: string,
	overId: string,
	parentId: string | null,
): MenuItem[] {
	const flat = flattenMenu(items);
	const activeIndex = flat.findIndex((entry) => entry.id === activeId);
	const overIndex = flat.findIndex((entry) => entry.id === overId);
	const active = flat[activeIndex];
	if (!active || overIndex === -1) return [...items];
	const updated = [...flat];
	updated[activeIndex] = { ...active, parentId };
	return itemsFromFlat(flattenMenu(itemsFromFlat(arrayMove(updated, activeIndex, overIndex))));
}

/** Every item's place, for one atomic reorder request. */
export function toReorderInput(items: readonly MenuItem[]): ReorderMenuItemsInput {
	return {
		items: itemsFromFlat(flattenMenu(items)).map(({ id, parentId, sortOrder }) => ({
			id,
			parentId,
			sortOrder,
		})),
	};
}

export type MenuMove = "up" | "down" | "indent" | "outdent";

/** What the row menu's move actions can do for `id` right now. */
export function availableMoves(items: readonly MenuItem[], id: string): Record<MenuMove, boolean> {
	const flat = flattenMenu(items);
	const entry = flat.find((candidate) => candidate.id === id);
	if (!entry) return { up: false, down: false, indent: false, outdent: false };
	const siblings = flat.filter((candidate) => candidate.parentId === entry.parentId);
	const index = siblings.findIndex((candidate) => candidate.id === id);
	return {
		up: index > 0,
		down: index < siblings.length - 1,
		indent: index > 0 && entry.depth + 1 <= deepestAllowedDepth(flat, id),
		outdent: entry.depth > 0,
	};
}

/** Applies a row-menu move and returns the new display order, or null when it isn't possible. */
export function applyMove(
	items: readonly MenuItem[],
	id: string,
	move: MenuMove,
): MenuItem[] | null {
	if (!availableMoves(items, id)[move]) return null;
	const flat = flattenMenu(items);
	const entry = flat.find((candidate) => candidate.id === id)!;
	const siblings = flat.filter((candidate) => candidate.parentId === entry.parentId);
	const siblingIndex = siblings.findIndex((candidate) => candidate.id === id);
	const order = flat.map((candidate) => ({ item: candidate.item, parentId: candidate.parentId }));
	const position = (itemId: string) => order.findIndex((candidate) => candidate.item.id === itemId);

	switch (move) {
		case "up":
		case "down": {
			const other = siblings[siblingIndex + (move === "up" ? -1 : 1)]!;
			const from = position(id);
			const to = position(other.id);
			[order[from], order[to]] = [order[to]!, order[from]!];
			break;
		}
		case "indent": {
			const newParent = siblings[siblingIndex - 1]!;
			const [moved] = order.splice(position(id), 1);
			order.push({ item: moved!.item, parentId: newParent.id });
			break;
		}
		case "outdent": {
			const parent = flat.find((candidate) => candidate.id === entry.parentId)!;
			const [moved] = order.splice(position(id), 1);
			order.splice(position(parent.id) + 1, 0, { item: moved!.item, parentId: parent.parentId });
			break;
		}
	}
	return itemsFromFlat(flattenMenu(itemsFromFlat(order)));
}
