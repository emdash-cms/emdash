import {
	deriveLegacyListId,
	normalizeListId,
	normalizeListStart,
} from "./converters/numbered-list.js";

type ListNestingMode = "html" | "direct";
type PortableTextNode = Record<string, unknown>;

interface PortableTextListBlock extends PortableTextNode {
	_type: "block";
	children: unknown[];
	level?: number;
	listId?: unknown;
	listItem: string;
	listStart?: unknown;
}

export interface PortableTextListNode extends PortableTextNode {
	_type: "@list";
	_key: string;
	children: PortableTextNode[];
	level: number;
	listItem: string;
	mode: ListNestingMode;
	start?: number;
}

interface ListDescriptor {
	node: PortableTextListNode;
	directItems: Array<{
		original: PortableTextListBlock;
		rendered: PortableTextListBlock;
	}>;
	level: number;
	parentContext: string;
	sourceId: string | undefined;
	segment: number;
}

interface ParentItem {
	context: string;
	list: ListDescriptor;
	rendered: PortableTextListBlock;
}

function isListBlock(node: PortableTextNode): node is PortableTextListBlock {
	return (
		node._type === "block" && typeof node.listItem === "string" && Array.isArray(node.children)
	);
}

function readLevel(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function findParentItem(items: Map<number, ParentItem>, level: number): ParentItem | undefined {
	let nearestLevel = 0;
	let nearest: ParentItem | undefined;
	for (const [candidate, item] of items) {
		if (candidate < level && candidate > nearestLevel) {
			nearestLevel = candidate;
			nearest = item;
		}
	}
	return nearest;
}

function matchesList(
	descriptor: ListDescriptor | undefined,
	listItem: string,
	sourceId: string | undefined,
	parentContext: string,
): descriptor is ListDescriptor {
	return (
		descriptor !== undefined &&
		descriptor.node.listItem === listItem &&
		descriptor.parentContext === parentContext &&
		(listItem !== "number" || descriptor.sourceId === sourceId)
	);
}

function buildListTree(
	blocks: PortableTextNode[],
	mode: ListNestingMode,
): { tree: PortableTextNode[]; descriptors: ListDescriptor[] } {
	const tree: PortableTextNode[] = [];
	const descriptors: ListDescriptor[] = [];
	const activeLists = new Map<number, ListDescriptor>();
	const lastItems = new Map<number, ParentItem>();
	let segment = 0;

	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!isListBlock(block)) {
			tree.push(block);
			activeLists.clear();
			lastItems.clear();
			continue;
		}

		const level = readLevel(block.level);
		for (const activeLevel of activeLists.keys()) {
			if (activeLevel > level) activeLists.delete(activeLevel);
		}
		for (const itemLevel of lastItems.keys()) {
			if (itemLevel > level) lastItems.delete(itemLevel);
		}

		const parent = findParentItem(lastItems, level);
		const parentContext = parent?.context ?? "root";
		const sourceId = block.listItem === "number" ? normalizeListId(block.listId) : undefined;
		let descriptor = activeLists.get(level);
		if (!matchesList(descriptor, block.listItem, sourceId, parentContext)) {
			const node: PortableTextListNode = {
				_type: "@list",
				_key: `${typeof block._key === "string" ? block._key : index}-parent`,
				children: [],
				level,
				listItem: block.listItem,
				mode,
			};
			descriptor = {
				node,
				directItems: [],
				level,
				parentContext,
				sourceId,
				segment: segment++,
			};
			descriptors.push(descriptor);
			activeLists.set(level, descriptor);
			if (!parent) {
				tree.push(node);
			} else if (mode === "direct") {
				parent.list.node.children.push(node);
			} else {
				parent.rendered.children.push(node);
			}
		}

		const rendered = { ...block, children: [...block.children] };
		descriptor.node.children.push(rendered);
		descriptor.directItems.push({ original: block, rendered });
		lastItems.set(level, {
			context: `${parentContext}/item:${index}`,
			list: descriptor,
			rendered,
		});
	}

	return { tree, descriptors };
}

function applyNumbering(descriptors: ListDescriptor[]): void {
	const bases = new Map<string, number>();
	const scopeKeys = new Map<ListDescriptor, string>();
	for (const descriptor of descriptors) {
		if (descriptor.node.listItem !== "number") continue;
		const identity =
			descriptor.sourceId ??
			deriveLegacyListId(
				`render:${descriptor.segment}:${descriptor.level}:${descriptor.parentContext}`,
			);
		const scope = JSON.stringify([identity, descriptor.level, descriptor.parentContext]);
		scopeKeys.set(descriptor, scope);
		if (!descriptor.sourceId || bases.has(scope)) continue;
		for (const { original } of descriptor.directItems) {
			const base = normalizeListStart(original.listStart);
			if (base === undefined) continue;
			bases.set(scope, base);
			break;
		}
	}

	const counts = new Map<string, number>();
	for (const descriptor of descriptors) {
		if (descriptor.node.listItem !== "number") continue;
		const scope = scopeKeys.get(descriptor)!;
		const base = bases.get(scope) ?? 1;
		const count = counts.get(scope) ?? 0;
		descriptor.node.start = normalizeListStart(base + count) ?? 1;
		counts.set(scope, count + descriptor.directItems.length);
	}
}

function preprocessLists(
	blocks: PortableTextNode[],
	mode: ListNestingMode,
): { tree: PortableTextNode[]; descriptors: ListDescriptor[] } {
	const result = buildListTree(blocks, mode);
	applyNumbering(result.descriptors);
	return result;
}

export function clonePortableTextValue<T>(value: T): T {
	return structuredClone(value);
}

export function buildPortableTextListTree(
	blocks: PortableTextNode[],
	mode: ListNestingMode = "html",
): PortableTextNode[] {
	return preprocessLists(blocks, mode).tree;
}
