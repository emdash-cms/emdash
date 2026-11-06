import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import {
	CellSelection,
	TableMap,
	__pastedCells,
	handlePaste as handleTablePaste,
	selectedRect,
	tableNodeTypes,
} from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

import {
	MAX_TABLE_PASTE_CELLS,
	MAX_TABLE_PASTE_COLUMNS,
	MAX_TABLE_PASTE_ROWS,
	MAX_TABLE_PASTE_TEXT_BYTES,
	MAX_TABLE_REPAIRED_SLOTS,
} from "../../portable-text-table.js";
import type { TablePasteRejection } from "./TableCellSafety.js";
import { selectionIsContainedInTableCells } from "./TableExtensions.js";

const LINE_BREAK_REGEX = /\r?\n/;
const TERMINAL_LINE_BREAK_REGEX = /[\r\n]$/;
const TSV_ESCAPE_REGEX = /[\t\r\n"]/;

export type TableTsvParseResult =
	| { ok: true; rows: string[][] }
	| { ok: false; reason: "invalid-tsv" | "too-large" };

export function parseTableTsv(text: string): TableTsvParseResult {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let afterQuote = false;
	let bytes = 0;
	let width = 0;
	const finishField = () => {
		row.push(field);
		field = "";
		afterQuote = false;
		return row.length <= MAX_TABLE_PASTE_COLUMNS;
	};
	const finishRow = () => {
		if (!finishField()) return false;
		rows.push(row);
		width = Math.max(width, row.length);
		row = [];
		return rows.length <= MAX_TABLE_PASTE_ROWS && rows.length * width <= MAX_TABLE_PASTE_CELLS;
	};
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		const code = text.charCodeAt(index);
		if (code <= 0x7f) bytes++;
		else if (code <= 0x7ff) bytes += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			index + 1 < text.length &&
			text.charCodeAt(index + 1) >= 0xdc00 &&
			text.charCodeAt(index + 1) <= 0xdfff
		)
			bytes += 1;
		else bytes += 3;
		if (bytes > MAX_TABLE_PASTE_TEXT_BYTES) return { ok: false, reason: "too-large" };
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				field += '"';
				if (++bytes > MAX_TABLE_PASTE_TEXT_BYTES) return { ok: false, reason: "too-large" };
				index++;
			} else if (character === '"') {
				quoted = false;
				afterQuote = true;
			} else field += character;
			continue;
		}
		if (afterQuote && character !== "\t" && character !== "\n" && character !== "\r")
			return { ok: false, reason: "invalid-tsv" };
		if (character === '"' && field === "" && !afterQuote) quoted = true;
		else if (character === "\t") {
			if (!finishField()) return { ok: false, reason: "too-large" };
		} else if (character === "\n" || character === "\r") {
			if (character === "\r" && text[index + 1] === "\n") {
				if (++bytes > MAX_TABLE_PASTE_TEXT_BYTES) return { ok: false, reason: "too-large" };
				index++;
			}
			if (!finishRow()) return { ok: false, reason: "too-large" };
		} else field += character;
	}
	if (quoted) return { ok: false, reason: "invalid-tsv" };
	if (row.length > 0 || field !== "" || !TERMINAL_LINE_BREAK_REGEX.test(text)) {
		if (!finishRow()) return { ok: false, reason: "too-large" };
	}
	if (!rows.length) return { ok: false, reason: "invalid-tsv" };
	return {
		ok: true,
		rows: rows.map((entry) => [...entry, ...Array(width - entry.length).fill("")]),
	};
}

function fieldContent(schema: Schema, value: string) {
	const content: ProseMirrorNode[] = [];
	for (const [index, part] of value.split(LINE_BREAK_REGEX).entries()) {
		if (index > 0) content.push(schema.nodes.hardBreak!.create());
		if (part) content.push(schema.text(part));
	}
	return schema.nodes.paragraph!.create(null, content);
}

function tableSlice(schema: Schema, rows: string[][]) {
	const types = tableNodeTypes(schema);
	return new Slice(
		Fragment.from(
			types.table.create(
				null,
				rows.map((row) =>
					types.row.create(
						null,
						row.map((value) => types.cell.create(null, fieldContent(schema, value))),
					),
				),
			),
		),
		0,
		0,
	);
}

function escapeField(value: string) {
	return TSV_ESCAPE_REGEX.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function serializeCellSelectionToTsv(state: EditorState): string | null {
	if (!(state.selection instanceof CellSelection)) return null;
	const rect = selectedRect(state);
	const seen = new Set<number>();
	const rows: string[] = [];
	for (let row = rect.top; row < rect.bottom; row++) {
		const fields: string[] = [];
		for (let column = rect.left; column < rect.right; column++) {
			const position = rect.map.map[row * rect.map.width + column]!;
			const cell = rect.table.nodeAt(position)!;
			fields.push(
				seen.has(position) ? "" : escapeField(cell.textBetween(0, cell.content.size, "\n", "\n")),
			);
			seen.add(position);
		}
		rows.push(fields.join("\t"));
	}
	return rows.join("\n");
}

function pasteAnchor(state: EditorState) {
	const rect = selectedRect(state);
	return { rect, position: rect.tableStart + rect.map.map[rect.top * rect.map.width + rect.left]! };
}

function pasteGrid(
	view: EditorView,
	event: ClipboardEvent,
	slice: Slice,
	preserveTargets: boolean,
	onRejected: (reason: TablePasteRejection) => void,
	onPasted?: (rows: number, columns: number) => void,
) {
	const original = view.state.selection;
	const { rect, position } = pasteAnchor(view.state);
	const cells = __pastedCells(slice);
	if (!cells) return false;
	if (
		Math.max(rect.map.height, rect.top + cells.height) *
			Math.max(rect.map.width, rect.left + cells.width) >
		MAX_TABLE_REPAIRED_SLOTS
	) {
		onRejected("too-large");
		return true;
	}
	const headerRow = rect.map
		.cellsInRect({ left: 0, top: 0, right: rect.map.width, bottom: 1 })
		.every((cell) => rect.table.nodeAt(cell)?.type.spec.tableRole === "header_cell");
	const headerColumn = rect.map
		.cellsInRect({ left: 0, top: 0, right: 1, bottom: rect.map.height })
		.every((cell) => rect.table.nodeAt(cell)?.type.spec.tableRole === "header_cell");
	const preserved = preserveTargets
		? Array.from({ length: Math.max(cells.height, rect.bottom - rect.top) }, (_, row) =>
				Array.from({ length: Math.max(cells.width, rect.right - rect.left) }, (_value, column) => {
					if (rect.top + row >= rect.map.height || rect.left + column >= rect.map.width)
						return null;
					const preservedPosition =
						rect.map.map[(rect.top + row) * rect.map.width + rect.left + column]!;
					const cellRect = rect.map.findCell(preservedPosition);
					const cell = rect.table.nodeAt(preservedPosition);
					if (!cell) return null;
					const anchor = cellRect.top === rect.top + row && cellRect.left === rect.left + column;
					const segment = rect.left + column - cellRect.left;
					return {
						type: cell.type,
						textAlign: cell.attrs.textAlign,
						width: cell.attrs.colwidth?.[segment] ?? 0,
						hasWidths: Array.isArray(cell.attrs.colwidth),
						emdashKey: anchor ? cell.attrs.emdashKey : null,
						emdashData: anchor ? cell.attrs.emdashData : null,
					};
				}),
			)
		: [];
	view.dispatch(
		view.state.tr
			.setSelection(TextSelection.near(view.state.doc.resolve(position + 1), 1))
			.setMeta("addToHistory", false),
	);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ProseMirror's paste helper reads only state and dispatch
	const proxy = {
		state: view.state,
		dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
			if (preserveTargets) {
				const table = transaction.doc.nodeAt(rect.tableStart - 1);
				if (table) {
					const map = TableMap.get(table);
					const types = tableNodeTypes(transaction.doc.type.schema);
					const seen = new Set<number>();
					for (let row = 0; row < preserved.length; row++)
						for (let column = 0; column < preserved[row]!.length; column++) {
							const target = preserved[row]![column];
							const cellPosition = map.map[(rect.top + row) * map.width + rect.left + column];
							if (cellPosition === undefined || seen.has(cellPosition)) continue;
							seen.add(cellPosition);
							const cell = table.nodeAt(cellPosition);
							if (!cell) continue;
							const cellRect = map.findCell(cellPosition);
							const segments = Array.from(
								{ length: cell.attrs.colspan },
								(_value, offset) =>
									preserved[cellRect.top - rect.top]?.[cellRect.left - rect.left + offset],
							);
							const attrs = target
								? {
										...cell.attrs,
										emdashKey: target.emdashKey,
										emdashData: target.emdashData,
										textAlign: target.textAlign,
										colwidth: segments.some((entry) => entry?.hasWidths)
											? segments.map((entry) => entry?.width ?? 0)
											: null,
									}
								: { ...cell.attrs, emdashKey: null, emdashData: null };
							const roleHeader =
								(headerRow && rect.top + row === 0) || (headerColumn && rect.left + column === 0);
							transaction.setNodeMarkup(
								rect.tableStart + cellPosition,
								target?.type ?? (roleHeader ? types.header_cell : types.cell),
								attrs,
							);
						}
				}
			}
			view.dispatch(transaction);
		},
	} as EditorView;
	try {
		if (handleTablePaste(proxy, event, slice)) {
			onPasted?.(cells.height, cells.width);
			return true;
		}
	} catch {
		// The original selection is restored below.
	}
	view.dispatch(view.state.tr.setSelection(original).setMeta("addToHistory", false));
	onRejected("invalid-table");
	return true;
}

export function createTableClipboard(
	onRejected: (reason: TablePasteRejection) => void,
	onPasted?: (rows: number, columns: number) => void,
) {
	return Extension.create({
		name: "tableClipboard",
		priority: 1_050,
		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: new PluginKey("tableClipboard"),
					props: {
						// A falsy result delegates ordinary selections to TipTap's text serializer.
						clipboardTextSerializer: (_slice, view) =>
							serializeCellSelectionToTsv(view.state) ?? "",
						handlePaste: (view, event, slice) => {
							if (!selectionIsContainedInTableCells(view.state)) return false;
							const semanticTable = __pastedCells(slice);
							if (semanticTable) {
								return pasteGrid(view, event, slice, false, onRejected, onPasted);
							}
							const types = [...(event.clipboardData?.types ?? [])];
							const explicit = event.clipboardData?.getData("text/tab-separated-values") ?? "";
							const text = explicit || event.clipboardData?.getData("text/plain") || "";
							if (!text.includes("\t") && !types.includes("text/tab-separated-values"))
								return false;
							const parsed = parseTableTsv(text);
							if (!parsed.ok) {
								onRejected(parsed.reason);
								return true;
							}
							return pasteGrid(
								view,
								event,
								tableSlice(view.state.schema, parsed.rows),
								true,
								onRejected,
								onPasted,
							);
						},
					},
				}),
			];
		},
	});
}
