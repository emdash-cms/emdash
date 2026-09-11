import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

import * as tableSpec from "../../portable-text-table.js";
import { selectionIsContainedInTableCells } from "./TableExtensions.js";

const TEXT_BLOCKS = new Set(["paragraph", "heading", "codeBlock"]);
const TEXT_CONTAINERS = new Set(["blockquote", "bulletList", "orderedList", "listItem"]);
const MARKS = new Set("bold italic underline strike subscript superscript code link".split(" "));

export type TablePasteRejection =
	| "unsupported-content"
	| "invalid-table"
	| "invalid-tsv"
	| "too-large"
	| "table-must-be-top-level";

type TableSliceRows =
	| { kind: "not-table" }
	| { kind: "unsupported-content" }
	| { kind: "invalid-table" }
	| { kind: "rows"; rows: readonly (readonly ProseMirrorNode[])[] };

function rowsFromTableSlice(slice: Slice): TableSliceRows {
	const nodes = slice.content.content;
	if (nodes.length === 0) return { kind: "not-table" };
	if (nodes.length === 1 && nodes[0]!.type.spec.tableRole === "table") {
		const rows = nodes[0]!.content.content;
		if (!rows.every((row) => row.type.spec.tableRole === "row")) {
			return { kind: "invalid-table" };
		}
		return { kind: "rows", rows: rows.map((row) => row.content.content) };
	}
	if (nodes.every((node) => node.type.spec.tableRole === "row")) {
		return { kind: "rows", rows: nodes.map((row) => row.content.content) };
	}
	if (
		nodes.every(
			(node) => node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell",
		)
	) {
		return { kind: "rows", rows: [nodes] };
	}
	return nodes.some((node) => node.type.spec.tableRole)
		? { kind: "unsupported-content" }
		: { kind: "not-table" };
}

function utf8BytesWithin(value: string, remaining: number): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
		if (bytes > remaining) return -1;
	}
	return bytes;
}

function textWithinBounds(slice: Slice, countBlockSeparators = false): boolean {
	let remaining = tableSpec.MAX_TABLE_PASTE_TEXT_BYTES;
	let valid = true;
	let textBlocks = 0;
	const visit = (node: ProseMirrorNode) => {
		if (!valid) return;
		if (countBlockSeparators && node.isTextblock) {
			if (textBlocks > 0) remaining--;
			textBlocks++;
			if (remaining < 0) {
				valid = false;
				return;
			}
		}
		if (node.isText) {
			const bytes = utf8BytesWithin(node.text ?? "", remaining);
			if (bytes < 0) valid = false;
			else remaining -= bytes;
			return;
		}
		if (node.type.name === "hardBreak") {
			remaining--;
			if (remaining < 0) valid = false;
			return;
		}
		node.forEach(visit);
	};
	slice.content.forEach(visit);
	return valid;
}

function validSpan(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= tableSpec.MAX_TABLE_SPAN
	);
}

function validColumnWidths(value: unknown, colspan: number): boolean {
	if (value === null || value === undefined) return true;
	return (
		Array.isArray(value) &&
		value.length === colspan &&
		value.every(
			(width) =>
				typeof width === "number" &&
				Number.isInteger(width) &&
				width >= 0 &&
				width <= tableSpec.MAX_TABLE_COLUMN_WIDTH,
		)
	);
}

function cellContentStatus(cell: ProseMirrorNode): "valid" | TablePasteRejection {
	if (cell.childCount === 0) return "unsupported-content";
	for (const paragraph of cell.content.content) {
		if (paragraph.type.name !== "paragraph") return "unsupported-content";
		if (paragraph.attrs.textAlign !== null && paragraph.attrs.textAlign !== undefined) {
			return "invalid-table";
		}
		if (
			!paragraph.content.content.every(
				(node) =>
					(node.isText && node.marks.every((mark) => MARKS.has(mark.type.name))) ||
					node.type.name === "hardBreak",
			)
		) {
			return "unsupported-content";
		}
	}
	return "valid";
}

function preflightTableSlice(
	slice: Slice,
	budget?: { rows: number; cells: number },
): "not-table" | "valid" | TablePasteRejection {
	const tableSlice = rowsFromTableSlice(slice);
	if (tableSlice.kind !== "rows") return tableSlice.kind;
	if (!textWithinBounds(slice, true)) return "too-large";
	if (tableSlice.rows.length === 0 || tableSlice.rows.length > tableSpec.MAX_TABLE_PASTE_ROWS) {
		return tableSlice.rows.length === 0 ? "invalid-table" : "too-large";
	}

	const occupiedUntil: number[] = [];
	let cellCount = 0;
	let height = tableSlice.rows.length;
	let width = 0;
	for (let rowIndex = 0; rowIndex < tableSlice.rows.length; rowIndex++) {
		const row = tableSlice.rows[rowIndex]!;
		if (row.length === 0) {
			if (!occupiedUntil.some((end) => end > rowIndex)) return "invalid-table";
			continue;
		}
		let column = 0;
		for (const cell of row) {
			if (cell.type.spec.tableRole !== "cell" && cell.type.spec.tableRole !== "header_cell") {
				return "invalid-table";
			}
			const contentStatus = cellContentStatus(cell);
			if (contentStatus !== "valid") return contentStatus;
			cellCount++;
			if (cellCount > tableSpec.MAX_TABLE_PASTE_CELLS) return "too-large";
			const { colspan, rowspan, colwidth } = cell.attrs;
			if (!validSpan(colspan) || !validSpan(rowspan)) return "invalid-table";
			if (!validColumnWidths(colwidth, colspan)) return "invalid-table";
			height = Math.max(height, rowIndex + rowspan);
			if (height > tableSpec.MAX_TABLE_PASTE_ROWS) return "too-large";

			let start = column;
			for (;;) {
				if (start + colspan > tableSpec.MAX_TABLE_PASTE_COLUMNS) return "too-large";
				let conflict = -1;
				for (let candidate = start; candidate < start + colspan; candidate++) {
					if ((occupiedUntil[candidate] ?? 0) > rowIndex) {
						conflict = candidate;
						break;
					}
				}
				if (conflict < 0) break;
				start = conflict + 1;
			}
			column = start + colspan;
			width = Math.max(width, column);
			for (let occupied = start; occupied < column; occupied++) {
				occupiedUntil[occupied] = Math.max(occupiedUntil[occupied] ?? 0, rowIndex + rowspan);
			}
		}
	}
	const slots = width * height;
	if (slots > tableSpec.MAX_TABLE_PASTE_CELLS) return "too-large";
	if (budget) {
		if (
			budget.rows + height > tableSpec.MAX_TABLE_PASTE_ROWS ||
			budget.cells + slots > tableSpec.MAX_TABLE_PASTE_CELLS
		) {
			return "too-large";
		}
		budget.rows += height;
		budget.cells += slots;
	}
	return "valid";
}

function tableSafetyInSlice(slice: Slice): {
	containsTable: boolean;
	rejection: TablePasteRejection | null;
} {
	const budget = { rows: 0, cells: 0 };
	let foundTable = false;
	let rejection: TablePasteRejection | null = null;
	const visit = (node: ProseMirrorNode, topLevel: boolean) => {
		if (rejection) return;
		if (node.type.spec.tableRole === "table") {
			foundTable = true;
			const status = preflightTableSlice(new Slice(Fragment.from(node), 0, 0), budget);
			if (status !== "valid") {
				rejection = status === "not-table" ? "invalid-table" : status;
				return;
			}
			if (!topLevel) {
				rejection = "table-must-be-top-level";
				return;
			}
		}
		node.forEach((child) => visit(child, false));
	};
	slice.content.forEach((node) => visit(node, true));
	if (!rejection && foundTable && !textWithinBounds(slice, true)) rejection = "too-large";
	return { containsTable: foundTable, rejection };
}

function tablePasteTargetIsTopLevel(state: EditorState): boolean {
	for (const position of [state.selection.$from, state.selection.$to]) {
		for (let depth = position.depth; depth > 0; depth--) {
			const name = position.node(depth).type.name;
			if (name === "blockquote" || name === "listItem") return false;
		}
	}
	return true;
}

function appendText(node: ProseMirrorNode, target: ProseMirrorNode[], schema: Schema) {
	const parts = (node.text ?? "").split("\n");
	for (let index = 0; index < parts.length; index++) {
		if (parts[index]) target.push(schema.text(parts[index]!, node.marks));
		if (index < parts.length - 1) target.push(schema.nodes.hardBreak!.create());
	}
}

function flattenBlock(node: ProseMirrorNode, blocks: ProseMirrorNode[][], schema: Schema): boolean {
	if (node.type.spec.tableRole) return false;
	if (node.isTextblock) {
		if (!TEXT_BLOCKS.has(node.type.name)) return false;
		const inline: ProseMirrorNode[] = [];
		let valid = true;
		node.forEach((child) => {
			if (child.isText && child.marks.every((mark) => MARKS.has(mark.type.name))) {
				appendText(child, inline, schema);
			} else if (child.type.name === "hardBreak") {
				inline.push(child);
			} else {
				valid = false;
			}
		});
		if (valid) blocks.push(inline);
		return valid;
	}
	if (!TEXT_CONTAINERS.has(node.type.name)) return false;
	return node.content.content.every((child) => flattenBlock(child, blocks, schema));
}

function flattenSlice(slice: Slice, schema: Schema): ProseMirrorNode[] | null {
	const blocks: ProseMirrorNode[][] = [];
	if (!slice.content.content.every((node) => flattenBlock(node, blocks, schema)) || !blocks.length)
		return null;
	const hardBreak = schema.nodes.hardBreak!;
	return blocks.flatMap((block, index) => (index === 0 ? block : [hardBreak.create(), ...block]));
}

export function createTableCellSafety(onRejected: (reason: TablePasteRejection) => void) {
	return Extension.create({
		name: "tableCellSafety",
		priority: 1_100,
		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: new PluginKey("tableCellSafety"),
					props: {
						handlePaste: (view, event, slice) => {
							const inTable = selectionIsContainedInTableCells(view.state);
							const tableSafety = tableSafetyInSlice(slice);
							if (tableSafety.rejection) {
								onRejected(tableSafety.rejection);
								return true;
							}
							if (
								tableSafety.containsTable &&
								!inTable &&
								!tablePasteTargetIsTopLevel(view.state)
							) {
								onRejected("table-must-be-top-level");
								return true;
							}
							const tableStatus = preflightTableSlice(slice);
							if (tableStatus === "valid") {
								if (!inTable && !tablePasteTargetIsTopLevel(view.state)) {
									onRejected("table-must-be-top-level");
									return true;
								}
								return false;
							}
							if (tableStatus === "unsupported-content" && !inTable) return false;
							if (tableStatus !== "not-table") {
								onRejected(tableStatus);
								return true;
							}
							if (!inTable) return false;
							if (!textWithinBounds(slice, true)) {
								onRejected("too-large");
								return true;
							}
							const content = flattenSlice(slice, view.state.schema);
							if (!content?.length) {
								onRejected("unsupported-content");
								return true;
							}
							if (
								event.clipboardData?.getData("text/plain").includes("\t") ||
								[...(event.clipboardData?.types ?? [])].includes("text/tab-separated-values")
							) {
								return false;
							}
							if (view.state.selection instanceof CellSelection) {
								const paragraph = view.state.schema.nodes.paragraph!.create(null, content);
								const positions: number[] = [];
								view.state.selection.forEachCell((_cell, position) => positions.push(position));
								const transaction = view.state.tr;
								for (const position of positions) {
									const mapped = transaction.mapping.map(position);
									const cell = transaction.doc.nodeAt(mapped);
									if (cell) {
										transaction.replaceWith(mapped + 1, mapped + cell.nodeSize - 1, paragraph);
									}
								}
								view.dispatch(transaction.scrollIntoView());
								return true;
							}
							if (!view.state.selection.$from.parent.isTextblock) return false;
							view.dispatch(
								view.state.tr
									.replaceSelection(new Slice(Fragment.fromArray(content), 0, 0))
									.scrollIntoView(),
							);
							return true;
						},
					},
				}),
			];
		},
	});
}
