import { mergeAttributes, wrappingInputRule } from "@tiptap/core";
import { OrderedList } from "@tiptap/extension-list";
import { Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { Plugin, Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { canJoin, dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

import {
	deriveLegacyListId,
	normalizeListId,
	normalizeListStart,
} from "../content/converters/numbered-list.js";

const ORDERED_LIST_INPUT_REGEX = /^(\d+)\.\s$/;

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		orderedListContinuity: {
			continueOrderedList: () => ReturnType;
			restartOrderedList: () => ReturnType;
		};
	}
}

interface OrderedListDescriptor {
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

function createListId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	);
}

function createRepairId(sourceId: string, scope: string, attempt: number): string {
	const base = deriveLegacyListId(`repair:${sourceId}:${scope}`);
	const suffix = `:${attempt.toString(36)}`;
	return `${base.slice(0, 128 - suffix.length)}${suffix}`;
}

function collectOrderedLists(doc: ProseMirrorNode): OrderedListDescriptor[] {
	const lists: OrderedListDescriptor[] = [];
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
	const lists = collectOrderedLists(doc);
	const canonicalBySourceScope = new Map<string, string>();
	const assignedCanonicalIds = new Set<string>();
	const prepared = lists.map((list) => {
		const sourceId =
			normalizeListId(list.node.attrs.listId) ??
			deriveLegacyListId(`pm:${list.pos}:${list.depth}:${list.context}`);
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
	for (const list of prepared) {
		const listStart = normalizeListStart(list.node.attrs.listStart);
		if (listStart !== undefined && !bases.has(list.scopeKey)) {
			bases.set(list.scopeKey, listStart);
		}
	}
	for (const list of prepared) {
		if (!bases.has(list.scopeKey)) {
			bases.set(list.scopeKey, normalizeListStart(list.node.attrs.start) ?? 1);
		}
	}

	const counts = new Map<string, number>();
	const changes: OrderedListNormalization[] = [];
	for (const list of prepared) {
		const listStart = bases.get(list.scopeKey)!;
		const count = counts.get(list.scopeKey) ?? 0;
		const start = normalizeListStart(listStart + count) ?? 1;
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

function applyNormalization(state: EditorState): Transaction | null {
	const changes = normalizeOrderedListDocument(state.doc);
	if (changes.length === 0) {
		const lists = collectOrderedLists(state.doc);
		const hasJoin = lists.some((list, index) => {
			const next = lists[index + 1];
			return (
				next !== undefined &&
				next.pos === list.pos + list.node.nodeSize &&
				next.depth === list.depth &&
				next.context === list.context &&
				normalizeListId(next.node.attrs.listId) === normalizeListId(list.node.attrs.listId) &&
				normalizeListStart(next.node.attrs.listStart) ===
					normalizeListStart(list.node.attrs.listStart)
			);
		});
		if (!hasJoin) return null;
	}
	const transaction = state.tr;
	for (const change of changes) {
		transaction.setNodeMarkup(change.pos, undefined, change.attrs);
	}
	const normalizedLists = collectOrderedLists(transaction.doc);
	const joinPositions = normalizedLists.flatMap((list, index) => {
		const next = normalizedLists[index + 1];
		return next !== undefined &&
			next.pos === list.pos + list.node.nodeSize &&
			next.depth === list.depth &&
			next.context === list.context &&
			normalizeListId(next.node.attrs.listId) === normalizeListId(list.node.attrs.listId) &&
			normalizeListStart(next.node.attrs.listStart) ===
				normalizeListStart(list.node.attrs.listStart)
			? [next.pos]
			: [];
	});
	for (const pos of joinPositions.toReversed()) {
		if (canJoin(transaction.doc, pos)) transaction.join(pos);
	}
	if (!transaction.docChanged) return null;
	return transaction;
}

export function remapPastedSlice(slice: Slice): Slice {
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
			const sourceId = normalizeListId(node.attrs.listId) ?? `missing:${missingIndex++}`;
			const scope = JSON.stringify([sourceId, depth, parentContext]);
			let identity = identities.get(scope);
			if (!identity) {
				identity = {
					listId: createListId(),
					listStart:
						normalizeListStart(node.attrs.start) ?? normalizeListStart(node.attrs.listStart) ?? 1,
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
	const current = collectOrderedLists(state.doc).findLast(
		(list) =>
			state.selection.from >= list.pos && state.selection.from <= list.pos + list.node.nodeSize,
	);
	if (!current) return null;
	const listId = normalizeListId(current.node.attrs.listId);
	const start = normalizeListStart(current.node.attrs.start);
	if (!listId || start === undefined) return null;
	let precedingItems = 0;
	current.node.forEach((child, offset) => {
		if (current.pos + 1 + offset + child.nodeSize <= state.selection.from) precedingItems++;
	});
	return {
		listId,
		listStart: normalizeListStart(start + precedingItems) ?? 1,
	};
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
				node.type.name === "orderedList" && normalizeListId(node.attrs.listId) === sourceId
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

export function prepareCopiedSlice(slice: Slice, state: EditorState): Slice {
	const selected = displayedStartAtSelection(state);
	if (!selected) return slice;
	let updated = false;
	const mapFragment = (fragment: Fragment): Fragment => {
		const children: ProseMirrorNode[] = [];
		fragment.forEach((node) => {
			const isFirstSelectedList =
				!updated &&
				node.type.name === "orderedList" &&
				normalizeListId(node.attrs.listId) === selected.listId;
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

export function remapMovedSlice(slice: Slice, state: EditorState): Slice {
	const selected = displayedStartAtSelection(state);
	if (!selected) return slice;
	return rewriteSliceIdentity(slice, selected.listId, createListId(), selected.listStart);
}

function findCurrentList(state: EditorState): {
	current: OrderedListDescriptor;
	lists: OrderedListDescriptor[];
} | null {
	const lists = collectOrderedLists(state.doc);
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

function rewriteListTail(
	state: EditorState,
	dispatch: ((transaction: Transaction) => void) | undefined,
	mode: "continue" | "restart",
): boolean {
	const selected = findCurrentList(state);
	if (!selected) return false;
	const { current, lists } = selected;
	const currentId = normalizeListId(current.node.attrs.listId);
	if (!currentId) return false;
	const compatible = lists.filter(
		(list) => list.depth === current.depth && list.context === current.context,
	);
	const predecessor = compatible.findLast((list) => list.pos < current.pos);
	const predecessorId = predecessor ? normalizeListId(predecessor.node.attrs.listId) : undefined;
	if (mode === "continue" && (!predecessorId || predecessorId === currentId)) {
		return false;
	}
	if (!dispatch) return true;
	const listId = mode === "continue" ? predecessorId! : createListId();
	const listStart =
		mode === "continue" ? (normalizeListStart(predecessor!.node.attrs.listStart) ?? 1) : 1;
	const transaction = state.tr;
	for (const list of compatible) {
		if (list.pos < current.pos || normalizeListId(list.node.attrs.listId) !== currentId) continue;
		transaction.setNodeMarkup(list.pos, undefined, {
			...list.node.attrs,
			listId,
			listStart,
		});
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

function handleMovedListDrop(
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
		const dropped = buildDropTransaction(view.state, remapPastedSlice(slice), insertPos, false);
		if (!dropped) return false;
		const selectionPos = Math.min(dropped.to, dropped.transaction.doc.content.size);
		dropped.transaction.setSelection(
			Selection.near(dropped.transaction.doc.resolve(selectionPos), -1),
		);
		view.focus();
		view.dispatch(dropped.transaction.setMeta("uiEvent", "drop").scrollIntoView());
		return true;
	}
	const selected = findCurrentList(view.state);
	if (!selected) return false;
	const preview = buildDropTransaction(view.state, slice, insertPos, true);
	if (!preview) return false;
	const sourceContextPos = selected.current.contextPos;
	const mappedSourceContextPos =
		sourceContextPos === null ? null : preview.transaction.mapping.map(sourceContextPos, 1);
	const remainsInContext = collectOrderedLists(preview.transaction.doc).some(
		(list) =>
			list.pos < preview.to &&
			list.pos + list.node.nodeSize > preview.from &&
			list.depth === selected.current.depth &&
			list.contextPos === mappedSourceContextPos,
	);
	if (remainsInContext) return false;
	const remapped = remapMovedSlice(slice, view.state);
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
					normalizeListStart(Number(element.dataset.emdashListFirst)) ??
					normalizeListStart(Number(element.getAttribute("start"))) ??
					1,
			},
			listId: {
				default: null,
				parseHTML: (element) => normalizeListId(element.dataset.emdashListId) ?? null,
				rendered: false,
			},
			listStart: {
				default: null,
				parseHTML: (element) => normalizeListStart(Number(element.dataset.emdashListStart)) ?? null,
				rendered: false,
			},
		};
	},

	renderHTML({ HTMLAttributes, node }) {
		const { start: _start, ...attributesWithoutStart } = HTMLAttributes;
		const start = normalizeListStart(node.attrs.start) ?? 1;
		const continuityAttributes = {
			"data-emdash-list-id": normalizeListId(node.attrs.listId),
			"data-emdash-list-start": normalizeListStart(node.attrs.listStart),
			"data-emdash-list-first": start,
		};
		return start === 1
			? [
					"ol",
					mergeAttributes(
						this.options.HTMLAttributes,
						attributesWithoutStart,
						continuityAttributes,
					),
					0,
				]
			: [
					"ol",
					mergeAttributes(
						this.options.HTMLAttributes,
						{ ...attributesWithoutStart, start },
						continuityAttributes,
					),
					0,
				];
	},

	addCommands() {
		return {
			toggleOrderedList:
				() =>
				({ commands, chain }) => {
					if (this.editor.isActive(this.name)) {
						return commands.toggleList(
							this.name,
							this.options.itemTypeName,
							this.options.keepMarks,
						);
					}
					return chain()
						.toggleList(this.name, this.options.itemTypeName, this.options.keepMarks)
						.updateAttributes(this.name, {
							listId: createListId(),
							listStart: 1,
						})
						.run();
				},
			continueOrderedList:
				() =>
				({ state, dispatch }) =>
					rewriteListTail(state, dispatch, "continue"),
			restartOrderedList:
				() =>
				({ state, dispatch }) =>
					rewriteListTail(state, dispatch, "restart"),
		};
	},

	addInputRules() {
		return [
			wrappingInputRule({
				find: ORDERED_LIST_INPUT_REGEX,
				type: this.type,
				getAttributes: (match) => {
					const listStart = normalizeListStart(Number(match[1])) ?? 1;
					return { start: listStart, listStart, listId: createListId() };
				},
				joinPredicate: () => false,
			}),
		];
	},

	addProseMirrorPlugins() {
		return [
			new Plugin({
				appendTransaction: (_transactions, _oldState, newState) => applyNormalization(newState),
				props: {
					transformCopied: (slice, view) => prepareCopiedSlice(slice, view.state),
					handleDrop: handleMovedListDrop,
					handlePaste(view, _event, slice) {
						if (!sliceHasOrderedList(slice)) return false;
						view.dispatch(
							view.state.tr
								.replaceSelection(remapPastedSlice(slice))
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
