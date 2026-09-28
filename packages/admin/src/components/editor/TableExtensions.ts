import { Extension, type Command } from "@tiptap/core";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { closeHistory } from "@tiptap/pm/history";
import type { ResolvedPos } from "@tiptap/pm/model";
import { Plugin, Selection, TextSelection, type EditorState } from "@tiptap/pm/state";
import {
	CellSelection,
	cellAround,
	deleteColumn,
	deleteRow,
	nextCell,
	selectedRect,
} from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

import { MAX_TABLE_REPAIRED_SLOTS, MAX_TABLE_SPAN } from "../../portable-text-table.js";

const TABLE_NODE_ROLES = new Set(["table", "row", "cell", "header_cell"]);
const TABLE_ALIGNMENTS = new Set(["left", "center", "right", "justify"]);

function hiddenAttribute(defaultValue: unknown = null) {
	return {
		default: defaultValue,
		parseHTML: () => null,
		rendered: false,
	};
}

function tableAttributes(parent: Record<string, unknown>) {
	return {
		...parent,
		emdashKey: hiddenAttribute(),
		emdashData: hiddenAttribute(),
	};
}

function cellAttributes(parent: Record<string, unknown>) {
	return {
		...tableAttributes(parent),
		textAlign: {
			default: null,
			parseHTML: (element: HTMLElement) => {
				const value = element.style.textAlign;
				return TABLE_ALIGNMENTS.has(value) ? value : null;
			},
			renderHTML: (attributes: Record<string, unknown>) => {
				const value = attributes.textAlign;
				return typeof value === "string" && TABLE_ALIGNMENTS.has(value)
					? { style: `text-align: ${value}` }
					: {};
			},
		},
	};
}

function createTableKey(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	return uuid ? uuid.replaceAll("-", "").slice(0, 12) : Math.random().toString(36).slice(2, 14);
}

function containsTableStructure(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsTableStructure);
	if (typeof value !== "object" || value === null) return false;
	const type = "type" in value ? value.type : undefined;
	if (
		typeof type === "string" &&
		["table", "tableRow", "tableCell", "tableHeader"].includes(type)
	) {
		return true;
	}
	return Object.values(value).some(containsTableStructure);
}

export function selectionTouchesTable(state: EditorState): boolean {
	const { selection } = state;
	for (const position of [selection.$from, selection.$to]) {
		for (let depth = position.depth; depth > 0; depth--) {
			if (position.node(depth).type.spec.tableRole === "table") return true;
		}
	}
	let found = false;
	state.doc.nodesBetween(selection.from, selection.to, (node) => {
		if (node.type.spec.tableRole === "table") found = true;
		return !found;
	});
	return found;
}

function tableCellPosition(position: ResolvedPos): number | null {
	for (let depth = position.depth; depth > 0; depth--) {
		const role = position.node(depth).type.spec.tableRole;
		if (role === "cell" || role === "header_cell") return position.before(depth);
	}
	return null;
}

export function selectionIsContainedInTableCells(state: EditorState): boolean {
	if (state.selection instanceof CellSelection) return true;
	const from = tableCellPosition(state.selection.$from);
	return from !== null && from === tableCellPosition(state.selection.$to);
}

function boundedInsertion(command: Command, axis: "row" | "column", before: boolean): Command {
	return (props) => {
		if (!selectionIsContainedInTableCells(props.state)) return false;
		const rect = selectedRect(props.state);
		const { map, table } = rect;
		const row = axis === "row";
		const extent = row ? map.height : map.width;
		const cross = row ? map.width : map.height;
		if ((extent + 1) * cross > MAX_TABLE_REPAIRED_SLOTS) return false;
		const boundary = row ? (before ? rect.top : rect.bottom) : before ? rect.left : rect.right;
		if (boundary > 0 && boundary < extent) {
			for (let index = 0; index < cross; index++) {
				const slot = row ? boundary * map.width + index : index * map.width + boundary;
				const position = map.map[slot]!;
				if (
					position === map.map[slot - (row ? map.width : 1)] &&
					table.nodeAt(position)!.attrs[row ? "rowspan" : "colspan"] >= MAX_TABLE_SPAN
				)
					return false;
			}
		}
		return command(props);
	};
}

function rtlCellEntry(view: EditorView, cell: ResolvedPos, direction: 1 | -1): ResolvedPos {
	const boundary = Selection.near(
		direction > 0 ? cell : view.state.doc.resolve(cell.pos + cell.nodeAfter!.nodeSize),
		direction,
	).$head;
	const element = view.nodeDOM(cell.pos);
	if (element instanceof HTMLElement) {
		element.scrollIntoView({ block: "nearest", inline: "nearest" });
		const start = view.coordsAtPos(boundary.start(), 1);
		const end = view.coordsAtPos(boundary.end(), -1);
		if (start.top === end.top)
			return view.state.doc.resolve(
				start.left > end.left === direction > 0 ? boundary.start() : boundary.end(),
			);
		const paragraph = element.querySelector(direction > 0 ? "p" : "p:last-of-type");
		if (paragraph) {
			const bounds = paragraph.getBoundingClientRect();
			const hit = view.posAtCoords({
				left: direction > 0 ? bounds.right - 1 : bounds.left + 1,
				top: direction > 0 ? (start.top + start.bottom) / 2 : (end.top + end.bottom) / 2,
			});
			if (hit && hit.pos > cell.pos && hit.pos < cell.pos + cell.nodeAfter!.nodeSize)
				return view.state.doc.resolve(hit.pos);
		}
	}
	return boundary;
}

function deleteSelectedTableAxis(view: EditorView, event: KeyboardEvent): boolean {
	if (
		!view.editable ||
		view.composing ||
		event.isComposing ||
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		(event.key !== "Backspace" && event.key !== "Delete")
	)
		return false;
	const { selection } = view.state;
	if (!(selection instanceof CellSelection)) return false;
	const row = selection.isRowSelection();
	if (row === selection.isColSelection()) return false;
	const rect = selectedRect(view.state);
	const command = row ? deleteRow : deleteColumn;
	const handled = command(view.state, (transaction) => {
		view.dispatch(
			closeHistory(transaction).setMeta(
				row ? "emdashDeletedTableRows" : "emdashDeletedTableColumns",
				row ? rect.bottom - rect.top : rect.right - rect.left,
			),
		);
	});
	if (handled) event.preventDefault();
	return handled;
}

function handleRtlTableKey(view: EditorView, event: KeyboardEvent): boolean {
	if (
		!view.editable ||
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.isComposing ||
		(event.key !== "ArrowLeft" && event.key !== "ArrowRight")
	)
		return false;
	const { selection } = view.state;
	if (!(selection instanceof CellSelection) && !(selection instanceof TextSelection)) return false;
	const cell =
		selection instanceof CellSelection ? selection.$headCell : cellAround(selection.$head);
	const element = cell ? view.nodeDOM(cell.pos) : null;
	const table = element instanceof Element ? element.closest("table") : null;
	if (!cell || !table || getComputedStyle(table).direction !== "rtl") return false;
	const direction = event.key === "ArrowLeft" ? 1 : -1;
	if (selection instanceof TextSelection) {
		// Skipping the upstream key handler leaves native bidi character movement intact.
		if (!event.shiftKey && !selection.empty) return true;
		const paragraph = selection.$head.index(cell.depth + 1);
		const backward = selection.$head.parent.content.size
			? selection.$head.parentOffset === 0
			: direction < 0;
		if (
			!view.endOfTextblock(event.key === "ArrowLeft" ? "left" : "right") ||
			paragraph !== (backward ? 0 : cell.nodeAfter!.childCount - 1)
		)
			return true;
	}
	const next =
		selection instanceof CellSelection && !event.shiftKey
			? cell
			: nextCell(cell, "horiz", direction);
	if (!next && !event.shiftKey) return true;
	if (next) {
		const anchor = selection instanceof CellSelection ? selection.$anchorCell : cell;
		view.dispatch(
			view.state.tr
				.setSelection(
					event.shiftKey
						? new CellSelection(anchor, next)
						: Selection.near(rtlCellEntry(view, next, direction), direction),
				)
				.scrollIntoView(),
		);
	}
	event.preventDefault();
	return true;
}

export const EmDashTable = Table.extend({
	addProseMirrorPlugins() {
		return [
			new Plugin({
				props: {
					handleDOMEvents: {
						keydown: (view, event) =>
							deleteSelectedTableAxis(view, event) || handleRtlTableKey(view, event),
					},
				},
			}),
			...this.parent!(),
		];
	},
	addCommands() {
		const parent = this.parent!();
		return {
			...parent,
			addRowBefore: () => boundedInsertion(parent.addRowBefore!(), "row", true),
			addRowAfter: () => boundedInsertion(parent.addRowAfter!(), "row", false),
			addColumnBefore: () => boundedInsertion(parent.addColumnBefore!(), "column", true),
			addColumnAfter: () => boundedInsertion(parent.addColumnAfter!(), "column", false),
		};
	},
	addAttributes() {
		return tableAttributes(this.parent?.() ?? {});
	},
});

export const EmDashTableRow = TableRow.extend({
	addAttributes() {
		return tableAttributes(this.parent?.() ?? {});
	},
});

export const EmDashTableCell = TableCell.extend({
	content: "paragraph+",
	addAttributes() {
		return cellAttributes(this.parent?.() ?? {});
	},
});

export const EmDashTableHeader = TableHeader.extend({
	content: "paragraph+",
	addAttributes() {
		return cellAttributes(this.parent?.() ?? {});
	},
});

export const TableIdentity = Extension.create({
	name: "tableIdentity",

	addProseMirrorPlugins() {
		return [
			new Plugin({
				appendTransaction(transactions, oldState, newState) {
					const addsTableStructure = transactions.some((transaction) =>
						transaction.steps.some((step) => containsTableStructure(step.toJSON())),
					);
					if (!addsTableStructure) return null;
					const survivingPositions = new Map<string, Set<number>>();
					oldState.doc.descendants((node, position) => {
						const key = node.attrs.emdashKey;
						if (
							typeof node.type.spec.tableRole !== "string" ||
							!TABLE_NODE_ROLES.has(node.type.spec.tableRole) ||
							typeof key !== "string" ||
							key.length === 0
						) {
							return;
						}
						let mapped = position;
						for (const transaction of transactions) {
							const result = transaction.mapping.mapResult(mapped, 1);
							if (result.deleted) return false;
							mapped = result.pos;
						}
						const surviving = newState.doc.nodeAt(mapped);
						if (
							surviving?.type.spec.tableRole === node.type.spec.tableRole &&
							surviving.attrs.emdashKey === key
						) {
							const positions = survivingPositions.get(key) ?? new Set<number>();
							positions.add(mapped);
							survivingPositions.set(key, positions);
						}
						return;
					});
					const topLevelSurvivorKeys = new Set<string>();
					for (const [key, positions] of survivingPositions) {
						for (const position of positions) {
							if (
								newState.doc.resolve(position).depth === 0 &&
								newState.doc.nodeAt(position)?.type.spec.tableRole === "table"
							) {
								topLevelSurvivorKeys.add(key);
								break;
							}
						}
					}
					const seenTopLevelTableKeys = new Set<string>();

					const repairs: Array<{
						position: number;
						attributes: Record<string, unknown>;
					}> = [];

					newState.doc.descendants((node, position) => {
						if (node.type.spec.tableRole !== "table") return;
						const isTopLevelTable = newState.doc.resolve(position).depth === 0;

						const entries = [{ node, position }];
						node.descendants((descendant, relativePosition) => {
							const role = descendant.type.spec.tableRole;
							if (typeof role === "string" && TABLE_NODE_ROLES.has(role)) {
								entries.push({
									node: descendant,
									position: position + relativePosition + 1,
								});
							}
						});
						const reserved = new Set(
							entries
								.map((entry) => entry.node.attrs.emdashKey)
								.filter((key): key is string => typeof key === "string" && key.length > 0),
						);
						const seen = new Set<string>();
						const survivingKeys = new Set<string>();
						for (const entry of entries) {
							const key = entry.node.attrs.emdashKey;
							if (typeof key === "string" && survivingPositions.get(key)?.has(entry.position)) {
								survivingKeys.add(key);
							}
						}

						for (const entry of entries) {
							const currentKey =
								typeof entry.node.attrs.emdashKey === "string" &&
								entry.node.attrs.emdashKey.length > 0
									? entry.node.attrs.emdashKey
									: null;
							const duplicate =
								currentKey !== null &&
								(seen.has(currentKey) ||
									(survivingKeys.has(currentKey) &&
										!survivingPositions.get(currentKey)?.has(entry.position)) ||
									(isTopLevelTable &&
										entry.position === position &&
										(seenTopLevelTableKeys.has(currentKey) ||
											(topLevelSurvivorKeys.has(currentKey) &&
												!survivingPositions.get(currentKey)?.has(entry.position)))));
							let emdashKey = currentKey;
							const isTopLevelEntry = isTopLevelTable && entry.position === position;
							if (!emdashKey || duplicate) {
								for (;;) {
									emdashKey = createTableKey();
									if (
										!reserved.has(emdashKey) &&
										!seen.has(emdashKey) &&
										(!isTopLevelEntry ||
											(!seenTopLevelTableKeys.has(emdashKey) &&
												!topLevelSurvivorKeys.has(emdashKey)))
									) {
										break;
									}
								}
							}
							seen.add(emdashKey);
							if (isTopLevelEntry) {
								seenTopLevelTableKeys.add(emdashKey);
							}
							if (!currentKey || duplicate) {
								repairs.push({
									position: entry.position,
									attributes: { ...entry.node.attrs, emdashKey },
								});
							}
						}
						return false;
					});

					if (repairs.length === 0) return null;

					const transaction = newState.tr;
					for (const repair of repairs) {
						transaction.setNodeMarkup(repair.position, undefined, repair.attributes);
					}
					return transaction.setMeta("addToHistory", false);
				},
			}),
		];
	},
});
