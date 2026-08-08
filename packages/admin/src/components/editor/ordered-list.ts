import { mergeAttributes, wrappingInputRule } from "@tiptap/core";
import { OrderedList } from "@tiptap/extension-list";
import { Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { Plugin, Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { canJoin, dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

const ORDERED_LIST_INPUT_REGEX = /^(\d+)\.\s$/;

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		orderedListContinuity: {
			continueOrderedList: () => ReturnType;
			restartOrderedList: () => ReturnType;
		};
	}
}

const MAX_START = 2_147_483_647;
const normalizeId = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	return id.length > 0 && id.length <= 128 ? id : undefined;
};
const normalizeStart = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_START
		? value
		: undefined;
const legacyId = (seed: string): string => {
	const readable = `legacy:${seed}`;
	if (readable.length <= 128) return readable;
	let hash = 2_166_136_261;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16_777_619);
	}
	return `legacy:${seed.slice(0, 96)}:${(hash >>> 0).toString(36)}:${seed.length.toString(36)}`;
};
const createId = (): string =>
	globalThis.crypto?.randomUUID?.() ??
	`list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const createRepairId = (sourceId: string, scope: string, attempt: number): string => {
	const base = legacyId(`repair:${sourceId}:${scope}`);
	const suffix = `:${attempt.toString(36)}`;
	return `${base.slice(0, 128 - suffix.length)}${suffix}`;
};

interface ListDescriptor {
	node: ProseMirrorNode;
	pos: number;
	depth: number;
	context: string;
	contextPos: number | null;
}

export interface OrderedListNormalization {
	pos: number;
	attrs: Record<string, unknown>;
}

function collectLists(doc: ProseMirrorNode): ListDescriptor[] {
	const lists: ListDescriptor[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name !== "orderedList") return;
		const resolved = doc.resolve(pos);
		let context = "root";
		let contextPos: number | null = null;
		for (let depth = resolved.depth; depth > 0; depth--) {
			if (resolved.node(depth).type.name === "listItem") {
				contextPos = resolved.before(depth);
				context = `listItem:${contextPos}`;
				break;
			}
		}
		if (contextPos === null && resolved.depth > 0) {
			contextPos = resolved.before(resolved.depth);
			context = `${resolved.node(resolved.depth).type.name}:${contextPos}`;
		}
		lists.push({ node, pos, depth: resolved.depth, context, contextPos });
	});
	return lists;
}

export function normalizeOrderedListDocument(doc: ProseMirrorNode): OrderedListNormalization[] {
	const canonicalBySourceScope = new Map<string, string>();
	const assignedCanonicalIds = new Set<string>();
	const lists = collectLists(doc).map((list) => {
		const sourceId =
			normalizeId(list.node.attrs.listId) ??
			legacyId(`pm:${list.pos}:${list.depth}:${list.context}`);
		const scope = JSON.stringify([list.depth, list.context]);
		const sourceScope = JSON.stringify([sourceId, scope]);
		let listId = canonicalBySourceScope.get(sourceScope);
		if (!listId) {
			if (!assignedCanonicalIds.has(sourceId)) {
				listId = sourceId;
			} else {
				let attempt = 0;
				do {
					listId = createRepairId(sourceId, scope, attempt++);
				} while (assignedCanonicalIds.has(listId));
			}
			canonicalBySourceScope.set(sourceScope, listId);
			assignedCanonicalIds.add(listId);
		}
		return {
			...list,
			listId,
			scopeKey: JSON.stringify([listId, list.depth, list.context]),
		};
	});
	const bases = new Map<string, number>();
	for (const list of lists) {
		const start = normalizeStart(list.node.attrs.listStart);
		if (start !== undefined && !bases.has(list.scopeKey)) bases.set(list.scopeKey, start);
	}
	for (const list of lists) {
		if (!bases.has(list.scopeKey))
			bases.set(list.scopeKey, normalizeStart(list.node.attrs.start) ?? 1);
	}
	const counts = new Map<string, number>();
	const changes: OrderedListNormalization[] = [];
	for (const list of lists) {
		const listStart = bases.get(list.scopeKey)!;
		const count = counts.get(list.scopeKey) ?? 0;
		const start = normalizeStart(listStart + count) ?? 1;
		counts.set(list.scopeKey, count + list.node.childCount);
		if (
			list.node.attrs.listId !== list.listId ||
			list.node.attrs.listStart !== listStart ||
			list.node.attrs.start !== start
		) {
			changes.push({
				pos: list.pos,
				attrs: { ...list.node.attrs, listId: list.listId, listStart, start },
			});
		}
	}
	return changes;
}

function normalizeTransaction(state: EditorState): Transaction | null {
	const changes = normalizeOrderedListDocument(state.doc);
	if (changes.length === 0) {
		const lists = collectLists(state.doc);
		const hasJoin = lists.some((list, index) => {
			const next = lists[index + 1];
			return (
				next !== undefined &&
				next.pos === list.pos + list.node.nodeSize &&
				next.depth === list.depth &&
				next.context === list.context &&
				normalizeId(next.node.attrs.listId) === normalizeId(list.node.attrs.listId) &&
				normalizeStart(next.node.attrs.listStart) === normalizeStart(list.node.attrs.listStart)
			);
		});
		if (!hasJoin) return null;
	}
	const transaction = state.tr;
	for (const change of changes) transaction.setNodeMarkup(change.pos, undefined, change.attrs);
	const normalizedLists = collectLists(transaction.doc);
	const joinPositions = normalizedLists.flatMap((list, index) => {
		const next = normalizedLists[index + 1];
		return next !== undefined &&
			next.pos === list.pos + list.node.nodeSize &&
			next.depth === list.depth &&
			next.context === list.context &&
			normalizeId(next.node.attrs.listId) === normalizeId(list.node.attrs.listId) &&
			normalizeStart(next.node.attrs.listStart) === normalizeStart(list.node.attrs.listStart)
			? [next.pos]
			: [];
	});
	for (const pos of joinPositions.toReversed()) {
		if (canJoin(transaction.doc, pos)) transaction.join(pos);
	}
	if (!transaction.docChanged) return null;
	return transaction;
}

function remapPaste(slice: Slice): Slice {
	const identities = new Map<string, { listId: string; listStart: number }>();
	let missingIndex = 0;
	const mapFragment = (fragment: Fragment, depth: number, parentContext: string): Fragment => {
		const children: ProseMirrorNode[] = [];
		fragment.forEach((node, _offset, index) => {
			const childContext =
				node.type.name === "listItem" ? `${parentContext}/listItem:${index}` : parentContext;
			const content = mapFragment(node.content, depth + 1, childContext);
			if (node.type.name !== "orderedList") {
				children.push(node.copy(content));
				return;
			}
			const sourceId = normalizeId(node.attrs.listId) ?? `missing:${missingIndex++}`;
			const scope = JSON.stringify([sourceId, depth, parentContext]);
			let identity = identities.get(scope);
			if (!identity) {
				identity = {
					listId: createId(),
					listStart: normalizeStart(node.attrs.start) ?? normalizeStart(node.attrs.listStart) ?? 1,
				};
				identities.set(scope, identity);
			}
			children.push(
				node.type.create(
					{ ...node.attrs, ...identity, start: identity.listStart },
					content,
					node.marks,
				),
			);
		});
		return Fragment.fromArray(children);
	};
	return new Slice(mapFragment(slice.content, 0, "root"), slice.openStart, slice.openEnd);
}

function sliceHasOrderedList(slice: Slice): boolean {
	let found = false;
	slice.content.descendants((node) => {
		if (node.type.name !== "orderedList") return true;
		found = true;
		return false;
	});
	return found;
}

function displayedStartAtSelection(
	state: EditorState,
): { listId: string; listStart: number } | null {
	const current = collectLists(state.doc).findLast(
		(list) =>
			state.selection.from >= list.pos && state.selection.from <= list.pos + list.node.nodeSize,
	);
	if (!current) return null;
	const listId = normalizeId(current.node.attrs.listId);
	const start = normalizeStart(current.node.attrs.start);
	if (!listId || start === undefined) return null;
	let precedingItems = 0;
	current.node.forEach((child, offset) => {
		if (current.pos + 1 + offset + child.nodeSize <= state.selection.from) precedingItems++;
	});
	return { listId, listStart: normalizeStart(start + precedingItems) ?? 1 };
}

function rewriteSliceIdentity(
	slice: Slice,
	sourceId: string,
	listId: string,
	listStart: number,
): Slice {
	const mapFragment = (fragment: Fragment): Fragment => {
		const children: ProseMirrorNode[] = [];
		fragment.forEach((node) => {
			const content = mapFragment(node.content);
			children.push(
				node.type.name === "orderedList" && normalizeId(node.attrs.listId) === sourceId
					? node.type.create(
							{ ...node.attrs, listId, listStart, start: listStart },
							content,
							node.marks,
						)
					: node.copy(content),
			);
		});
		return Fragment.fromArray(children);
	};
	return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
}

function prepareCopy(slice: Slice, state: EditorState): Slice {
	const selected = displayedStartAtSelection(state);
	if (!selected) return slice;
	let updated = false;
	const mapFragment = (fragment: Fragment): Fragment => {
		const children: ProseMirrorNode[] = [];
		fragment.forEach((node) => {
			const isFirstSelectedList =
				!updated &&
				node.type.name === "orderedList" &&
				normalizeId(node.attrs.listId) === selected.listId;
			if (isFirstSelectedList) updated = true;
			const content = mapFragment(node.content);
			if (isFirstSelectedList) {
				children.push(
					node.type.create({ ...node.attrs, start: selected.listStart }, content, node.marks),
				);
			} else {
				children.push(node.copy(content));
			}
		});
		return Fragment.fromArray(children);
	};
	return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
}

function remapMove(slice: Slice, state: EditorState): Slice {
	const selected = displayedStartAtSelection(state);
	if (!selected) return slice;
	return rewriteSliceIdentity(slice, selected.listId, createId(), selected.listStart);
}

function selectedList(
	state: EditorState,
): { current: ListDescriptor; lists: ListDescriptor[] } | null {
	const lists = collectLists(state.doc);
	const current = lists.findLast(
		(list) =>
			state.selection.from >= list.pos && state.selection.to <= list.pos + list.node.nodeSize,
	);
	if (!current) return null;
	const intersecting = lists.filter(
		(list) =>
			list.depth === current.depth &&
			list.context === current.context &&
			state.selection.from < list.pos + list.node.nodeSize &&
			state.selection.to > list.pos,
	);
	return intersecting.length === 1 ? { current, lists } : null;
}

function rewriteTail(
	state: EditorState,
	dispatch: ((transaction: Transaction) => void) | undefined,
	mode: "continue" | "restart",
): boolean {
	const selected = selectedList(state);
	if (!selected) return false;
	const { current, lists } = selected;
	const currentId = normalizeId(current.node.attrs.listId);
	if (!currentId) return false;
	const compatible = lists.filter(
		(list) => list.depth === current.depth && list.context === current.context,
	);
	const predecessor = compatible.findLast((list) => list.pos < current.pos);
	const predecessorId = predecessor ? normalizeId(predecessor.node.attrs.listId) : undefined;
	if (mode === "continue" && (!predecessorId || predecessorId === currentId)) return false;
	if (!dispatch) return true;
	const listId = mode === "continue" ? predecessorId! : createId();
	const listStart =
		mode === "continue" ? (normalizeStart(predecessor!.node.attrs.listStart) ?? 1) : 1;
	const transaction = state.tr;
	for (const list of compatible) {
		if (list.pos < current.pos || normalizeId(list.node.attrs.listId) !== currentId) continue;
		transaction.setNodeMarkup(list.pos, undefined, { ...list.node.attrs, listId, listStart });
	}
	dispatch(transaction);
	return true;
}

function buildDropTransaction(
	state: EditorState,
	slice: Slice,
	insertPos: number,
	deleteSource: boolean,
): { transaction: Transaction; from: number; to: number } | null {
	const transaction = state.tr;
	if (deleteSource) transaction.deleteSelection();
	const from = transaction.mapping.map(insertPos);
	const beforeInsert = transaction.doc;
	transaction.replaceRange(from, from, slice);
	if (transaction.doc.eq(beforeInsert)) return null;
	let to = from;
	transaction.mapping.maps.at(-1)?.forEach((_oldFrom, _oldTo, _newFrom, newTo) => {
		to = Math.max(to, newTo);
	});
	return { transaction, from, to };
}

function handleMovedDrop(
	view: EditorView,
	event: DragEvent,
	slice: Slice,
	moved: boolean,
): boolean {
	if (!sliceHasOrderedList(slice)) return false;
	const eventPos = view.posAtCoords({ left: event.clientX, top: event.clientY });
	if (!eventPos) return false;
	const insertPos = dropPoint(view.state.doc, eventPos.pos, slice) ?? eventPos.pos;
	if (!moved) {
		const dropped = buildDropTransaction(view.state, remapPaste(slice), insertPos, false);
		if (!dropped) return false;
		const selectionPos = Math.min(dropped.to, dropped.transaction.doc.content.size);
		dropped.transaction.setSelection(
			Selection.near(dropped.transaction.doc.resolve(selectionPos), -1),
		);
		view.focus();
		view.dispatch(dropped.transaction.setMeta("uiEvent", "drop").scrollIntoView());
		return true;
	}
	const selected = selectedList(view.state);
	if (!selected) return false;
	const preview = buildDropTransaction(view.state, slice, insertPos, true);
	if (!preview) return false;
	const sourceContextPos = selected.current.contextPos;
	const mappedSourceContextPos =
		sourceContextPos === null ? null : preview.transaction.mapping.map(sourceContextPos, 1);
	const remainsInContext = collectLists(preview.transaction.doc).some(
		(list) =>
			list.pos < preview.to &&
			list.pos + list.node.nodeSize > preview.from &&
			list.depth === selected.current.depth &&
			list.contextPos === mappedSourceContextPos,
	);
	if (remainsInContext) return false;
	const remapped = remapMove(slice, view.state);
	if (remapped === slice) return false;
	const dropped = buildDropTransaction(view.state, remapped, insertPos, true);
	if (!dropped) return false;
	const selectionPos = Math.min(dropped.to, dropped.transaction.doc.content.size);
	dropped.transaction.setSelection(
		Selection.near(dropped.transaction.doc.resolve(selectionPos), -1),
	);
	view.focus();
	view.dispatch(dropped.transaction.setMeta("uiEvent", "drop").scrollIntoView());
	return true;
}

export const EmDashOrderedList = OrderedList.extend({
	addAttributes() {
		const parent = this.parent?.() ?? {};
		return {
			...parent,
			start: {
				...parent.start,
				parseHTML: (element) =>
					normalizeStart(Number(element.dataset.emdashListFirst)) ??
					normalizeStart(Number(element.getAttribute("start"))) ??
					1,
			},
			listId: {
				default: null,
				parseHTML: (element) => normalizeId(element.dataset.emdashListId) ?? null,
				rendered: false,
			},
			listStart: {
				default: null,
				parseHTML: (element) => normalizeStart(Number(element.dataset.emdashListStart)) ?? null,
				rendered: false,
			},
		};
	},
	renderHTML({ HTMLAttributes, node }) {
		const { start: _start, ...withoutStart } = HTMLAttributes;
		const start = normalizeStart(node.attrs.start) ?? 1;
		const continuity = {
			"data-emdash-list-id": normalizeId(node.attrs.listId),
			"data-emdash-list-start": normalizeStart(node.attrs.listStart),
			"data-emdash-list-first": start,
		};
		return start === 1
			? ["ol", mergeAttributes(this.options.HTMLAttributes, withoutStart, continuity), 0]
			: [
					"ol",
					mergeAttributes(this.options.HTMLAttributes, { ...withoutStart, start }, continuity),
					0,
				];
	},
	addCommands() {
		return {
			toggleOrderedList:
				() =>
				({ commands, chain }) =>
					this.editor.isActive(this.name)
						? commands.toggleList(this.name, this.options.itemTypeName, this.options.keepMarks)
						: chain()
								.toggleList(this.name, this.options.itemTypeName, this.options.keepMarks)
								.updateAttributes(this.name, { listId: createId(), listStart: 1 })
								.run(),
			continueOrderedList:
				() =>
				({ state, dispatch }) =>
					rewriteTail(state, dispatch, "continue"),
			restartOrderedList:
				() =>
				({ state, dispatch }) =>
					rewriteTail(state, dispatch, "restart"),
		};
	},
	addInputRules() {
		return [
			wrappingInputRule({
				find: ORDERED_LIST_INPUT_REGEX,
				type: this.type,
				getAttributes: (match) => {
					const listStart = normalizeStart(Number(match[1])) ?? 1;
					return { start: listStart, listStart, listId: createId() };
				},
				joinPredicate: () => false,
			}),
		];
	},
	addProseMirrorPlugins() {
		return [
			new Plugin({
				appendTransaction: (_transactions, _oldState, newState) => normalizeTransaction(newState),
				props: {
					transformCopied: (slice, view) => prepareCopy(slice, view.state),
					handleDrop: handleMovedDrop,
					handlePaste(view, _event, slice) {
						if (!sliceHasOrderedList(slice)) return false;
						view.dispatch(
							view.state.tr
								.replaceSelection(remapPaste(slice))
								.setMeta("paste", true)
								.setMeta("uiEvent", "paste")
								.scrollIntoView(),
						);
						return true;
					},
				},
			}),
		];
	},
});
