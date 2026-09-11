import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type EditorState } from "@tiptap/pm/state";
import {
	CellSelection,
	TableMap,
	cellAround,
	columnIsHeader,
	mergeCells,
	rowIsHeader,
	selectedRect,
	tableNodeTypes,
	type TableRect,
} from "@tiptap/pm/tables";

import {
	MAX_TABLE_COLUMN_WIDTH,
	MAX_TABLE_SPAN,
	TABLE_CELL_MIN_WIDTH,
	TABLE_COLUMN_WIDTH_STEP,
} from "../../portable-text-table.js";
import { selectionIsContainedInTableCells } from "./TableExtensions.js";

type Axis = "row" | "column";
type SelectionAxis = Axis | "table";
type TableChain = ReturnType<Editor["chain"]>;
type Context = { editor: Editor; rect: TableRect; widths: number[]; raw: number[] };

const SELECTIONS = {
	"select-row": "row",
	"select-column": "column",
	"select-table": "table",
} as const;
const COMMANDS = {
	"add-row-before": (value: TableChain) => value.addRowBefore(),
	"add-row-after": (value: TableChain) => value.addRowAfter(),
	"delete-row": (value: TableChain) => value.deleteRow(),
	"add-column-before": (value: TableChain) => value.addColumnBefore(),
	"add-column-after": (value: TableChain) => value.addColumnAfter(),
	"delete-column": (value: TableChain) => value.deleteColumn(),
	"delete-table": (value: TableChain) => value.deleteTable(),
} as const;
const ACTION_IDS = [
	"select-row",
	"select-column",
	"select-table",
	"add-row-before",
	"add-row-after",
	"delete-row",
	"add-column-before",
	"add-column-after",
	"delete-column",
	"delete-table",
	"header-row",
	"header-column",
	"merge",
	"split",
	"decrease-width",
	"increase-width",
	"distribute-widths",
	"reset-widths",
	"paragraph-before",
	"paragraph-after",
] as const;
export type TableActionId = (typeof ACTION_IDS)[number];
const hasOwn = <T extends object>(value: T, key: PropertyKey): key is keyof T =>
	Object.hasOwn(value, key);

function tableRect(state: EditorState): TableRect | null {
	const current = state.selection;
	if (current instanceof NodeSelection && current.node.type.spec.tableRole === "table") {
		const map = TableMap.get(current.node);
		return {
			left: 0,
			top: 0,
			right: map.width,
			bottom: map.height,
			table: current.node,
			map,
			tableStart: current.from + 1,
		};
	}
	if (!selectionIsContainedInTableCells(state)) return null;
	try {
		return selectedRect(state);
	} catch {
		return null;
	}
}

function createContext(editor: Editor): Context | null {
	const rect = tableRect(editor.state);
	if (!rect) return null;
	const raw = Array.from({ length: rect.map.width }, (_, column) => {
		const position = rect.map.map[column]!;
		return rect.table.nodeAt(position)!.attrs.colwidth?.[column - rect.map.colCount(position)] ?? 0;
	});
	return {
		editor,
		rect,
		raw,
		widths: raw.map((width) =>
			width > 0 ? Math.max(TABLE_CELL_MIN_WIDTH, width) : TABLE_CELL_MIN_WIDTH,
		),
	};
}

const axisBounds = ({ map }: TableRect, axis: Axis) =>
	axis === "row"
		? { left: 0, top: 0, right: map.width, bottom: 1 }
		: { left: 0, top: 0, right: 1, bottom: map.height };
const header = (rect: TableRect, position: number) =>
	rect.table.nodeAt(position)?.type.spec.tableRole === "header_cell";

function headerState(rect: TableRect, axis: Axis): boolean | "mixed" {
	if (axis === "column" && rect.map.width === 1 && rect.map.height === 1) return false;
	if (
		axis === "row" ? rowIsHeader(rect.map, rect.table, 0) : columnIsHeader(rect.map, rect.table, 0)
	)
		return true;
	const cells = headerTargets(rect, axis);
	const count = cells.filter((position) => header(rect, position)).length;
	return count > 0 ? "mixed" : false;
}

function headerTargets(rect: TableRect, axis: Axis) {
	if (axis === "column" && rect.map.width === 1 && rect.map.height === 1) return [];
	const cells = rect.map.cellsInRect(axisBounds(rect, axis));
	const perpendicular =
		axis === "row"
			? !(rect.map.width === 1 && rect.map.height === 1) && columnIsHeader(rect.map, rect.table, 0)
			: rowIsHeader(rect.map, rect.table, 0);
	return perpendicular ? cells.filter((position) => position !== rect.map.map[0]) : cells;
}

function canHeader(rect: TableRect, axis: Axis) {
	const edge = rect.map.cellsInRect(axisBounds(rect, axis));
	const cells = headerTargets(rect, axis);
	return (
		cells.length > 0 &&
		edge.every((position) => {
			const cell = rect.table.nodeAt(position);
			return Boolean(
				cell && (axis === "row" ? cell.attrs.rowspan === 1 : cell.attrs.colspan === 1),
			);
		})
	);
}

function selection({ editor, rect }: Context, axis: SelectionAxis) {
	const indexes =
		axis === "row"
			? [rect.top * rect.map.width, (rect.bottom - 1) * rect.map.width + rect.map.width - 1]
			: axis === "column"
				? [rect.left, (rect.map.height - 1) * rect.map.width + rect.right - 1]
				: [0, rect.map.map.length - 1];
	const resolve = (index: number) =>
		editor.state.doc.resolve(rect.tableStart + rect.map.map[index]!);
	const [anchor, head] = [resolve(indexes[0]!), resolve(indexes[1]!)];
	return axis === "row"
		? CellSelection.rowSelection(anchor, head)
		: axis === "column"
			? CellSelection.colSelection(anchor, head)
			: new CellSelection(anchor, head);
}

function canSelect({ editor, rect }: Context, axis: SelectionAxis) {
	if (!(editor.state.selection instanceof CellSelection)) return true;
	return axis === "row"
		? rect.left > 0 || rect.right < rect.map.width
		: axis === "column"
			? rect.top > 0 || rect.bottom < rect.map.height
			: rect.left > 0 ||
				rect.top > 0 ||
				rect.right < rect.map.width ||
				rect.bottom < rect.map.height;
}

function chain(context: Context, apply: (value: TableChain) => TableChain, check: boolean) {
	const { editor } = context;
	let value = check ? editor.can().chain() : editor.chain().focus();
	if (editor.state.selection instanceof NodeSelection)
		value = value.command(({ tr }) => {
			tr.setSelection(selection(context, "table"));
			return true;
		});
	return apply(value).run();
}

const allCells = ({ rect }: Context) =>
	rect.map.cellsInRect({ left: 0, top: 0, right: rect.map.width, bottom: rect.map.height });

function writeWidths(context: Context, next: number[] | null, changed?: Set<number>) {
	const { editor, rect } = context;
	const tr = editor.state.tr;
	for (const position of allCells(context)) {
		const cell = rect.table.nodeAt(position)!;
		const start = rect.map.colCount(position);
		let colwidth: number[] | null = null;
		if (next) {
			const candidate = cell.attrs.colwidth?.slice() ?? Array(cell.attrs.colspan).fill(0);
			for (let offset = 0; offset < cell.attrs.colspan; offset++)
				if (!changed || changed.has(start + offset)) candidate[offset] = next[start + offset]!;
			if (candidate.some((width: number) => width > 0)) colwidth = candidate;
		}
		if (cell.attrs.colwidth === null && colwidth === null) continue;
		if (
			Array.isArray(cell.attrs.colwidth) &&
			Array.isArray(colwidth) &&
			cell.attrs.colwidth.every((width: number, index: number) => width === colwidth[index])
		)
			continue;
		tr.setNodeMarkup(rect.tableStart + position, undefined, { ...cell.attrs, colwidth });
	}
	if (!tr.docChanged) return false;
	editor.view.dispatch(tr.scrollIntoView());
	editor.view.focus();
	return true;
}

function distributedWidth({ editor, rect }: Context) {
	const dom = editor.view.nodeDOM(rect.tableStart - 1);
	const table =
		dom instanceof HTMLTableElement
			? dom
			: dom instanceof HTMLElement
				? dom.querySelector("table")
				: null;
	return Math.min(
		MAX_TABLE_COLUMN_WIDTH,
		Math.round(
			Math.max(table?.getBoundingClientRect().width ?? 0, rect.map.width * TABLE_CELL_MIN_WIDTH) /
				rect.map.width,
		),
	);
}

function runWidth(context: Context, id: TableActionId) {
	if (id === "reset-widths") return writeWidths(context, null);
	const next = [...context.raw];
	if (id === "distribute-widths") next.fill(distributedWidth(context));
	else {
		const changed = new Set<number>();
		const delta = id === "increase-width" ? TABLE_COLUMN_WIDTH_STEP : -TABLE_COLUMN_WIDTH_STEP;
		for (let column = context.rect.left; column < context.rect.right; column++) {
			next[column] = Math.max(
				TABLE_CELL_MIN_WIDTH,
				Math.min(MAX_TABLE_COLUMN_WIDTH, context.widths[column]! + delta),
			);
			changed.add(column);
		}
		return writeWidths(context, next, changed);
	}
	return writeWidths(context, next);
}

function canMerge({ editor, rect }: Context) {
	if (rect.right - rect.left > MAX_TABLE_SPAN || rect.bottom - rect.top > MAX_TABLE_SPAN)
		return false;
	if (!(editor.state.selection instanceof CellSelection) || !mergeCells(editor.state)) return false;
	const cells = rect.map.cellsInRect(rect).map((position) => rect.table.nodeAt(position)!);
	const alignment = cells[0]?.attrs.textAlign;
	return (
		cells.length > 1 &&
		cells.every(
			(cell, index) =>
				cell.type.spec.tableRole === "cell" &&
				cell.attrs.textAlign === alignment &&
				(index === 0 || !cell.attrs.emdashData || Object.keys(cell.attrs.emdashData).length === 0),
		)
	);
}

function merge(context: Context) {
	const { editor, rect } = context;
	const selectedWidths = context.raw.slice(rect.left, rect.right);
	return editor
		.chain()
		.focus()
		.mergeCells()
		.command(({ tr }) => {
			const resolved = cellAround(tr.selection.$from);
			if (!resolved?.nodeAfter) return false;
			const cell = resolved.nodeAfter;
			const inline: ProseMirrorNode[] = [];
			cell.forEach((node, _offset, index) => {
				if (index > 0) inline.push(tr.doc.type.schema.nodes.hardBreak!.create());
				inline.push(...node.content.content);
			});
			tr.setNodeMarkup(resolved.pos, undefined, { ...cell.attrs, colwidth: selectedWidths });
			tr.replaceWith(
				resolved.pos + 1,
				resolved.pos + cell.nodeSize - 1,
				tr.doc.type.schema.nodes.paragraph!.create(null, Fragment.from(inline)),
			);
			return true;
		})
		.run();
}

function split({ editor, rect }: Context) {
	return editor
		.chain()
		.focus()
		.splitCell()
		.command(({ tr }) => {
			const table = tr.doc.nodeAt(rect.tableStart - 1);
			if (!table) return false;
			const map = TableMap.get(table);
			const survivor = rect.tableStart + map.map[rect.top * map.width + rect.left]!;
			for (const relative of map.cellsInRect(rect)) {
				const position = rect.tableStart + relative;
				const cell = tr.doc.nodeAt(position);
				if (cell && position !== survivor)
					tr.setNodeMarkup(position, undefined, {
						...cell.attrs,
						emdashKey: null,
						emdashData: null,
					});
			}
			return true;
		})
		.run();
}

function toggleHeader({ editor, rect }: Context, axis: Axis) {
	const tr = editor.state.tr;
	const types = tableNodeTypes(editor.schema);
	const type = headerState(rect, axis) === true ? types.cell : types.header_cell;
	for (const position of headerTargets(rect, axis)) {
		const cell = rect.table.nodeAt(position);
		if (cell && cell.type !== type) tr.setNodeMarkup(rect.tableStart + position, type, cell.attrs);
	}
	if (!tr.docChanged) return false;
	editor.view.dispatch(tr.scrollIntoView());
	editor.view.focus();
	return true;
}

function adjacentParagraph({ editor, rect }: Context, before: boolean) {
	const tr = editor.state.tr;
	const tablePosition = rect.tableStart - 1;
	const boundary = before ? tablePosition : tablePosition + rect.table.nodeSize;
	const adjacent = before ? tr.doc.resolve(boundary).nodeBefore : tr.doc.nodeAt(boundary);
	let position = before ? boundary - (adjacent?.nodeSize ?? 0) + 1 : boundary + 1;
	if (adjacent?.type.name !== "paragraph" || adjacent.content.size > 0) {
		tr.insert(boundary, tr.doc.type.schema.nodes.paragraph!.create());
		position = boundary + 1;
	}
	tr.setSelection(TextSelection.create(tr.doc, position));
	editor.view.dispatch(tr.scrollIntoView());
	editor.view.focus();
	return true;
}

function canRun(context: Context, id: TableActionId): boolean {
	if (hasOwn(SELECTIONS, id)) return canSelect(context, SELECTIONS[id]);
	if (id === "delete-row")
		return context.rect.top > 0 || context.rect.bottom < context.rect.map.height;
	if (id === "delete-column")
		return context.rect.left > 0 || context.rect.right < context.rect.map.width;
	if (hasOwn(COMMANDS, id)) return chain(context, COMMANDS[id], true);
	if (id === "header-row" || id === "header-column")
		return canHeader(context.rect, id === "header-row" ? "row" : "column");
	if (id === "merge") return canMerge(context);
	if (id === "split") return context.editor.can().splitCell();
	if (id === "decrease-width")
		return context.widths
			.slice(context.rect.left, context.rect.right)
			.some((width) => width > TABLE_CELL_MIN_WIDTH);
	if (id === "increase-width")
		return context.widths
			.slice(context.rect.left, context.rect.right)
			.some((width) => width < MAX_TABLE_COLUMN_WIDTH);
	if (id === "distribute-widths") {
		const target = distributedWidth(context);
		return allCells(context).some((position) => {
			const cell = context.rect.table.nodeAt(position)!;
			return Array.from(
				{ length: cell.attrs.colspan },
				(_value, offset) => cell.attrs.colwidth?.[offset] !== target,
			).some(Boolean);
		});
	}
	if (id === "reset-widths")
		return allCells(context).some((position) =>
			Boolean(context.rect.table.nodeAt(position)?.attrs.colwidth),
		);
	return true;
}

function run(context: Context, id: TableActionId): boolean {
	if (hasOwn(SELECTIONS, id)) {
		context.editor.view.dispatch(
			context.editor.state.tr.setSelection(selection(context, SELECTIONS[id])).scrollIntoView(),
		);
		context.editor.view.focus();
		return true;
	}
	if (hasOwn(COMMANDS, id)) return chain(context, COMMANDS[id], false);
	if (id === "header-row" || id === "header-column")
		return toggleHeader(context, id === "header-row" ? "row" : "column");
	if (id === "merge") return merge(context);
	if (id === "split") return split(context);
	if (id === "paragraph-before" || id === "paragraph-after")
		return adjacentParagraph(context, id === "paragraph-before");
	return runWidth(context, id);
}

export function getTableControlState(editor: Editor) {
	const context = createContext(editor);
	if (!context) return null;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ids are exhaustive and assigned below
	const can = Object.fromEntries(ACTION_IDS.map((id) => [id, canRun(context, id)])) as Record<
		TableActionId,
		boolean
	>;
	return {
		rows: context.rect.bottom - context.rect.top,
		columns: context.rect.right - context.rect.left,
		headerRow: headerState(context.rect, "row"),
		headerColumn: headerState(context.rect, "column"),
		can,
	};
}

export function runTableAction(editor: Editor, id: TableActionId): boolean {
	const context = createContext(editor);
	return Boolean(context && canRun(context, id) && run(context, id));
}
