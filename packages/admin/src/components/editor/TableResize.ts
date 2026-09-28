import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
	CellSelection,
	TableMap,
	TableView,
	cellAround,
	pointsAtCell,
	updateColumnsOnResize,
} from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import * as tableSpec from "../../portable-text-table.js";

const resizeKey = new PluginKey<number>("emdashTableResize");

const direction = (view: EditorView) =>
	getComputedStyle(view.dom).direction === "rtl" ? "rtl" : "ltr";
const clampWidth = (value: number) =>
	Math.min(
		tableSpec.MAX_TABLE_COLUMN_WIDTH,
		Math.max(tableSpec.TABLE_CELL_MIN_WIDTH, Math.round(value)),
	);

function tableColumn(node: ProseMirrorNode, column: number, minimum: number): number {
	const map = TableMap.get(node);
	const position = map.map[column];
	if (position === undefined) return minimum;
	const width = node.nodeAt(position)?.attrs.colwidth?.[column - map.colCount(position)];
	return typeof width === "number" && width > 0 ? Math.max(minimum, width) : minimum;
}

function clampRenderedColumns(
	node: ProseMirrorNode,
	table: HTMLTableElement,
	minimum: number,
	overrideColumn: number,
) {
	const row = node.firstChild;
	if (!row) return;
	const columns = table.querySelectorAll("col");
	let column = 0;
	for (const cell of row.content.content) {
		for (let offset = 0; offset < cell.attrs.colspan; offset++, column++) {
			const width = cell.attrs.colwidth?.[offset];
			const element = columns[column];
			if (
				column !== overrideColumn &&
				typeof width === "number" &&
				width > 0 &&
				width < minimum &&
				element
			) {
				element.style.width = `${minimum}px`;
			}
		}
	}
}

function currentColumnWidth(view: EditorView, cellPosition: number): number {
	const resolved = view.state.doc.resolve(cellPosition);
	if (!pointsAtCell(resolved)) return tableSpec.TABLE_CELL_MIN_WIDTH;
	const cell = resolved.nodeAfter!;
	const table = resolved.node(-1);
	const map = TableMap.get(table);
	const column = map.colCount(cellPosition - resolved.start(-1)) + cell.attrs.colspan - 1;
	const segment = column - map.colCount(cellPosition - resolved.start(-1));
	const explicit = cell.attrs.colwidth?.[segment];
	if (typeof explicit === "number" && explicit > 0) return clampWidth(explicit);

	const element = view.nodeDOM(cellPosition);
	if (!(element instanceof HTMLElement)) {
		return tableColumn(table, column, tableSpec.TABLE_CELL_MIN_WIDTH);
	}
	let remainingWidth = element.offsetWidth;
	let automaticSegments = cell.attrs.colspan;
	if (Array.isArray(cell.attrs.colwidth)) {
		for (const width of cell.attrs.colwidth) {
			if (typeof width === "number" && width > 0) {
				remainingWidth -= Math.max(tableSpec.TABLE_CELL_MIN_WIDTH, width);
				automaticSegments--;
			}
		}
	}
	return clampWidth(remainingWidth / Math.max(1, automaticSegments));
}

function applyResponsiveWidth(
	node: ProseMirrorNode,
	table: HTMLTableElement,
	minimum: number,
	overrideColumn = -1,
	overrideWidth = minimum,
) {
	const map = TableMap.get(node);
	let minWidth = 0;
	for (let column = 0; column < map.width; column++) {
		minWidth += column === overrideColumn ? overrideWidth : tableColumn(node, column, minimum);
	}
	table.style.width = "100%";
	table.style.minWidth = `${minWidth}px`;
	clampRenderedColumns(node, table, minimum, overrideColumn);
}

export class ResponsiveTableView extends TableView {
	constructor(node: ProseMirrorNode, minimum: number) {
		super(node, minimum);
		applyResponsiveWidth(node, this.table, minimum);
	}

	override update(node: ProseMirrorNode) {
		const updated = super.update(node);
		if (updated) applyResponsiveWidth(node, this.table, this.defaultCellMinWidth);
		return updated;
	}
}

function cellAtInlineEnd(view: EditorView, event: MouseEvent, handleWidth: number): number {
	let target = event.target instanceof HTMLElement ? event.target : null;
	const handle = target?.closest<HTMLElement>("[data-emdash-resize-cell]");
	if (handle) {
		const cellPosition = Number(handle.dataset.emdashResizeCell);
		if (
			Number.isInteger(cellPosition) &&
			cellPosition >= 0 &&
			cellPosition <= view.state.doc.content.size &&
			pointsAtCell(view.state.doc.resolve(cellPosition))
		) {
			return cellPosition;
		}
		return -1;
	}
	while (target && target !== view.dom && target.tagName !== "TD" && target.tagName !== "TH") {
		target = target.parentElement;
	}
	if (!target || target === view.dom) return -1;
	const rect = target.getBoundingClientRect();
	const distance =
		direction(view) === "rtl" ? event.clientX - rect.left : rect.right - event.clientX;
	if (distance < 0 || distance > handleWidth) return -1;
	const position = view.posAtDOM(target, 0);
	const direct = position > 0 ? view.state.doc.nodeAt(position - 1) : null;
	if (direct?.type.spec.tableRole === "cell" || direct?.type.spec.tableRole === "header_cell") {
		return position - 1;
	}
	return cellAround(view.state.doc.resolve(position))?.pos ?? -1;
}

function activeCellPosition(view: EditorView): number {
	const { selection } = view.state;
	const cell =
		selection instanceof CellSelection ? selection.$headCell : cellAround(selection.$head);
	return cell?.pos ?? -1;
}

function tableElement(view: EditorView, tableStart: number): HTMLTableElement | null {
	const node = view.domAtPos(tableStart).node;
	return (node instanceof Element ? node : node.parentElement)?.closest("table") ?? null;
}

function resizeColumn(view: EditorView, cellPosition: number, width: number, preview: boolean) {
	if (cellPosition < 0 || cellPosition > view.state.doc.content.size) return;
	const cellPositionResolved = view.state.doc.resolve(cellPosition);
	if (!pointsAtCell(cellPositionResolved)) return;
	const cell = cellPositionResolved.nodeAfter!;
	const table = cellPositionResolved.node(-1);
	const tableStart = cellPositionResolved.start(-1);
	const map = TableMap.get(table);
	const column = map.colCount(cellPosition - tableStart) + cell.attrs.colspan - 1;
	if (preview) {
		const element = tableElement(view, tableStart);
		if (!element) return;
		const colgroup = element.querySelector("colgroup");
		if (!colgroup) return;
		updateColumnsOnResize(table, colgroup, element, tableSpec.TABLE_CELL_MIN_WIDTH, column, width);
		applyResponsiveWidth(table, element, tableSpec.TABLE_CELL_MIN_WIDTH, column, width);
		return;
	}
	const transaction = view.state.tr;
	const seen = new Set<number>();
	for (let row = 0; row < map.height; row++) {
		const position = map.map[row * map.width + column];
		if (position === undefined || seen.has(position)) continue;
		seen.add(position);
		const target = table.nodeAt(position);
		if (!target) continue;
		const index = column - map.colCount(position);
		if (target.attrs.colwidth?.[index] === width) continue;
		const colwidth = target.attrs.colwidth?.slice() ?? Array(target.attrs.colspan).fill(0);
		colwidth[index] = width;
		transaction.setNodeMarkup(tableStart + position, undefined, { ...target.attrs, colwidth });
	}
	if (transaction.docChanged) view.dispatch(transaction.setMeta(resizeKey, -1));
}

function restoreResponsiveWidth(view: EditorView, cellPosition: number) {
	if (cellPosition < 0 || cellPosition > view.state.doc.content.size) return;
	const resolved = view.state.doc.resolve(cellPosition);
	if (!pointsAtCell(resolved)) return;
	const table = resolved.node(-1);
	const element = tableElement(view, resolved.start(-1));
	const colgroup = element?.querySelector("colgroup");
	if (!element || !colgroup) return;
	updateColumnsOnResize(table, colgroup, element, tableSpec.TABLE_CELL_MIN_WIDTH);
	applyResponsiveWidth(table, element, tableSpec.TABLE_CELL_MIN_WIDTH);
}

function createHandle(cellPosition: number, side: ReturnType<typeof direction>) {
	const handle = document.createElement("div");
	handle.className = "column-resize-handle";
	handle.dataset.emdashResizeCell = String(cellPosition);
	handle.style.right = side === "rtl" ? "auto" : "0px";
	handle.style.left = side === "rtl" ? "0px" : "auto";
	return handle;
}

function createResizePlugin(onResized?: () => void) {
	let activeDirection: ReturnType<typeof direction> = "ltr";
	let dragSession: { cancel: () => void; destroy: () => void } | null = null;
	return new Plugin<number>({
		key: resizeKey,
		state: {
			init: () => -1,
			apply(transaction, active) {
				const requested = transaction.getMeta(resizeKey);
				if (typeof requested === "number") return requested;
				if (active < 0 || !transaction.docChanged) return active;
				const mapped = transaction.mapping.map(active, -1);
				return mapped >= 0 && pointsAtCell(transaction.doc.resolve(mapped)) ? mapped : -1;
			},
		},
		props: {
			attributes(state): Record<string, string> {
				return (resizeKey.getState(state) ?? -1) >= 0 ? { class: "resize-cursor" } : {};
			},
			nodeViews: {
				table: (node) => new ResponsiveTableView(node, tableSpec.TABLE_CELL_MIN_WIDTH),
			},
			decorations(state) {
				const active = resizeKey.getState(state) ?? -1;
				if (active < 0) return null;
				const resolved = state.doc.resolve(active);
				if (!pointsAtCell(resolved)) return null;
				const cell = resolved.nodeAfter!;
				const table = resolved.node(-1);
				const start = resolved.start(-1);
				const map = TableMap.get(table);
				const column = map.colCount(active - start) + cell.attrs.colspan - 1;
				const widgets: Decoration[] = [];
				const seen = new Set<number>();
				for (let row = 0; row < map.height; row++) {
					const index = row * map.width + column;
					const position = map.map[index];
					const node = position === undefined ? null : table.nodeAt(position);
					if (position === undefined || !node || seen.has(position)) continue;
					if (column < map.width - 1 && position === map.map[index + 1]) continue;
					seen.add(position);
					widgets.push(
						Decoration.widget(start + position + node.nodeSize - 1, () =>
							createHandle(start + position, activeDirection),
						),
					);
				}
				return DecorationSet.create(state.doc, widgets);
			},
			handleDOMEvents: {
				mousemove(view, event) {
					if (!view.editable || dragSession) return false;
					activeDirection = direction(view);
					const active = cellAtInlineEnd(view, event, tableSpec.TABLE_RESIZE_TARGET_WIDTH);
					if (active !== resizeKey.getState(view.state))
						view.dispatch(view.state.tr.setMeta(resizeKey, active));
					return false;
				},
				mousedown(view, event) {
					if (!view.editable || dragSession || event.button !== 0) return false;
					const target =
						event.target instanceof HTMLElement
							? event.target.closest<HTMLElement>("[data-emdash-resize-cell]")
							: null;
					const cellPosition = Number(target?.dataset.emdashResizeCell);
					if (!target || !Number.isInteger(cellPosition)) return false;
					const side = direction(view);
					const startX = event.clientX;
					const resolved = view.state.doc.resolve(cellPosition);
					if (!pointsAtCell(resolved)) return false;
					const startWidth = currentColumnWidth(view, cellPosition);
					const ownerWindow = view.dom.ownerDocument.defaultView ?? window;
					const widthAt = (next: MouseEvent) =>
						clampWidth(
							startWidth + (side === "rtl" ? startX - next.clientX : next.clientX - startX),
						);
					const move = (next: MouseEvent) => {
						if (!view.editable || (next.buttons & 1) === 0) {
							dragSession?.cancel();
							return;
						}
						resizeColumn(view, cellPosition, widthAt(next), true);
					};
					let complete = false;
					let session: { cancel: () => void; destroy: () => void };
					const clearActive = () => {
						if ((resizeKey.getState(view.state) ?? -1) >= 0) {
							view.dispatch(view.state.tr.setMeta(resizeKey, -1));
						}
					};
					const cleanup = () => {
						if (complete) return;
						complete = true;
						ownerWindow.removeEventListener("mousemove", move);
						ownerWindow.removeEventListener("mouseup", finish);
						ownerWindow.removeEventListener("blur", cancel);
						ownerWindow.removeEventListener("pointercancel", cancel);
						view.dom.classList.remove("table-resize-dragging");
						if (dragSession === session) dragSession = null;
					};
					const restore = () => restoreResponsiveWidth(view, cellPosition);
					const cancel = () => {
						if (complete) return;
						restore();
						cleanup();
						clearActive();
					};
					const finish = (next: MouseEvent) => {
						if (complete || next.button !== 0) return;
						const width = widthAt(next);
						if (!view.editable) {
							cancel();
							return;
						}
						resizeColumn(view, cellPosition, width, true);
						cleanup();
						if (width !== startWidth) {
							resizeColumn(view, cellPosition, width, false);
							onResized?.();
						} else {
							restore();
						}
						clearActive();
					};
					session = {
						cancel,
						destroy: cleanup,
					};
					dragSession = session;
					view.dom.classList.add("table-resize-dragging");
					ownerWindow.addEventListener("mousemove", move);
					ownerWindow.addEventListener("mouseup", finish);
					ownerWindow.addEventListener("blur", cancel);
					ownerWindow.addEventListener("pointercancel", cancel);
					event.preventDefault();
					return true;
				},
				mouseleave(view) {
					if (!dragSession && (resizeKey.getState(view.state) ?? -1) >= 0) {
						view.dispatch(view.state.tr.setMeta(resizeKey, -1));
					}
					return false;
				},
			},
		},
		view(initialView) {
			let visibleCell = activeCellPosition(initialView);
			const revealCell = (view: EditorView) => {
				if (!view.editable) {
					if (dragSession) dragSession.cancel();
					else if ((resizeKey.getState(view.state) ?? -1) >= 0) {
						view.dispatch(view.state.tr.setMeta(resizeKey, -1));
					}
					visibleCell = activeCellPosition(view);
					return;
				}
				const cellPosition = activeCellPosition(view);
				if (cellPosition < 0) visibleCell = -1;
				if (cellPosition < 0 || cellPosition === visibleCell) return;
				visibleCell = cellPosition;
				if (!view.hasFocus()) return;
				const cell = view.nodeDOM(cellPosition);
				if (cell instanceof HTMLElement)
					cell.scrollIntoView({ block: "nearest", inline: "nearest" });
			};
			revealCell(initialView);
			return {
				update: revealCell,
				destroy: () => dragSession?.destroy(),
			};
		},
	});
}

export function createTableResize(onResized?: () => void) {
	return Extension.create({
		name: "tableResize",
		addProseMirrorPlugins() {
			return [createResizePlugin(onResized)];
		},
	});
}
