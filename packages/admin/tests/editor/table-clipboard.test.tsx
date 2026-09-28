import { Editor, type JSONContent } from "@tiptap/core";
import { createTable } from "@tiptap/extension-table";
import { Fragment, Slice } from "@tiptap/pm/model";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createTableClipboard,
	parseTableTsv,
	serializeCellSelectionToTsv,
} from "../../src/components/editor/TableClipboard";
import {
	EmDashTable,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
	TableIdentity,
} from "../../src/components/editor/TableExtensions";
import { MAX_TABLE_PASTE_TEXT_BYTES } from "../../src/portable-text-table";

const editors: Editor[] = [];

function content(rows = 2, columns = 2): JSONContent {
	return {
		type: "doc",
		content: [
			{
				type: "table",
				attrs: { emdashKey: "table" },
				content: Array.from({ length: rows }, (_rowValue, row) => ({
					type: "tableRow",
					attrs: { emdashKey: `row-${row}` },
					content: Array.from({ length: columns }, (_columnValue, column) => ({
						type: row === 0 ? "tableHeader" : "tableCell",
						attrs: {
							emdashKey: `cell-${row}-${column}`,
							emdashData: { source: `${row}:${column}` },
							colwidth: [128 + column * 16],
							textAlign: "center",
						},
						content: [{ type: "paragraph", content: [{ type: "text", text: `${row}:${column}` }] }],
					})),
				})),
			},
		],
	};
}

function createEditor(value = content(), onPasted = vi.fn(), onRejected = vi.fn()) {
	const editor = new Editor({
		extensions: [
			StarterKit,
			EmDashTable.configure({ resizable: false }),
			EmDashTableRow,
			EmDashTableHeader,
			EmDashTableCell,
			TableIdentity,
			createTableClipboard(onRejected, onPasted),
		],
		content: value,
	});
	editors.push(editor);
	return editor;
}

function positions(editor: Editor) {
	const result: number[] = [];
	editor.state.doc.descendants((node, position) => {
		if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") {
			result.push(position);
		}
	});
	return result;
}

function paste(
	editor: Editor,
	text: string,
	slice = new Slice(Fragment.from(editor.schema.nodes.paragraph.create()), 0, 0),
	explicitTsv = false,
) {
	const plugin = editor.state.plugins.find(({ key }) => key.startsWith("tableClipboard$"))!;
	const event = new ClipboardEvent("paste");
	Object.defineProperty(event, "clipboardData", {
		value: {
			types: explicitTsv ? ["text/tab-separated-values"] : ["text/plain"],
			getData: (type: string) =>
				type === "text/plain" || (explicitTsv && type === "text/tab-separated-values") ? text : "",
		},
	});
	return plugin.props.handlePaste!(editor.view, event, slice);
}

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

describe("table clipboard", () => {
	it("preserves hard breaks when copying ordinary text", () => {
		const editor = createEditor();
		editor.commands.setContent("<p>one<br>two</p>");
		editor.commands.setTextSelection({ from: 1, to: 8 });
		expect(editor.view.serializeForClipboard(editor.state.selection.content()).text).toBe(
			"one\ntwo",
		);
	});

	it.each([
		["A\r", [["A"]]],
		[
			"A\tB\r\nC\tD",
			[
				["A", "B"],
				["C", "D"],
			],
		],
		[
			'"A\tB"\t"C""D"\n"line\none"\tمرحبا',
			[
				["A\tB", 'C"D'],
				["line\none", "مرحبا"],
			],
		],
		[
			"A\t\n\tB\n",
			[
				["A", ""],
				["", "B"],
			],
		],
	] as Array<[string, string[][]]>)("parses bounded TSV %#", (text, expected) => {
		expect(parseTableTsv(text)).toEqual({ ok: true, rows: expected });
	});

	it("rejects malformed quoted TSV", () => {
		expect(parseTableTsv('"unfinished\tvalue')).toEqual({ ok: false, reason: "invalid-tsv" });
		expect(parseTableTsv('"done"suffix\tvalue')).toEqual({
			ok: false,
			reason: "invalid-tsv",
		});
	});

	it("counts every raw byte in escaped quoted input before allocating the grid", () => {
		const oversized = `"${'""'.repeat(MAX_TABLE_PASTE_TEXT_BYTES / 2)}"`;
		expect(parseTableTsv(oversized)).toEqual({ ok: false, reason: "too-large" });
	});

	it("pastes a rectangular selection once while preserving destination attributes", () => {
		const onPasted = vi.fn();
		const editor = createEditor(content(), onPasted);
		const cells = positions(editor);
		editor.view.dispatch(
			editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[3]!, cells[0]!)),
		);
		const before = editor.getJSON();

		expect(paste(editor, "A\tB\nC\tD")).toBe(true);

		const table = editor.state.doc.firstChild!;
		expect(
			table.content.content.flatMap((row) => row.content.content.map((cell) => cell.textContent)),
		).toEqual(["A", "B", "C", "D"]);
		expect(table.firstChild?.firstChild?.type.spec.tableRole).toBe("header_cell");
		expect(table.firstChild?.firstChild?.attrs).toMatchObject({
			emdashKey: "cell-0-0",
			emdashData: { source: "0:0" },
			colwidth: [128],
			textAlign: "center",
		});
		expect(editor.commands.undo()).toBe(true);
		expect(editor.getJSON()).toEqual(before);
		expect(editor.commands.redo()).toBe(true);
		expect(onPasted).toHaveBeenCalledWith(2, 2);
	});

	it("grows only the required trailing rows and columns", () => {
		const editor = createEditor(content(1, 1));
		const [cell] = positions(editor);
		editor.commands.setTextSelection(cell! + 2);

		expect(paste(editor, "A\tB\tC\nD\tE\tF")).toBe(true);
		const table = editor.state.doc.firstChild!;
		expect(TableMap.get(table)).toMatchObject({ width: 3, height: 2 });
		expect(
			table.firstChild?.content.content.every(
				(entry) => entry.type.spec.tableRole === "header_cell",
			),
		).toBe(true);
	});

	it.each([false, true])("rejects growth beyond the saved table limit (HTML: %s)", (html) => {
		const value = content(101, 1);
		const rows = value.content![0]!.content!;
		for (const row of rows) row.content![0]!.attrs = { colspan: 100 };
		rows.at(-1)!.content = content(1, 100).content![0]!.content![0]!.content;
		const onRejected = vi.fn();
		const editor = createEditor(value, vi.fn(), onRejected);
		editor.commands.setTextSelection(positions(editor).at(-1)! + 2);
		const before = editor.getJSON();
		const selection = editor.state.selection;
		const source = html
			? new Slice(Fragment.from(createTable(editor.schema, 1, 100, false)), 0, 0)
			: undefined;
		expect(paste(editor, Array(100).fill("X").join("\t"), source)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("too-large");
		expect(editor.getJSON()).toEqual(before);
		expect(editor.state.selection.eq(selection)).toBe(true);
	});

	it("pastes a smaller HTML table once at the top-start selected cell", () => {
		const editor = createEditor();
		const cells = positions(editor);
		editor.view.dispatch(
			editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[3]!, cells[0]!)),
		);
		const source = createTable(editor.schema, 1, 2, false);
		const bold = editor.schema.marks.bold.create();
		const row = source.firstChild!;
		const table = source.copy(
			Fragment.from(
				row.copy(
					Fragment.fromArray([
						row
							.child(0)
							.copy(
								Fragment.from(
									editor.schema.nodes.paragraph.create(null, editor.schema.text("A", [bold])),
								),
							),
						row
							.child(1)
							.copy(
								Fragment.from(editor.schema.nodes.paragraph.create(null, editor.schema.text("B"))),
							),
					]),
				),
			),
		);

		expect(paste(editor, "A\tB", new Slice(Fragment.from(table), 0, 0))).toBe(true);

		expect(
			editor.state.doc.firstChild!.content.content.flatMap((rowNode) =>
				rowNode.content.content.map((entry) => entry.textContent),
			),
		).toEqual(["A", "B", "1:0", "1:1"]);
		expect(
			editor.state.doc.firstChild?.firstChild?.firstChild?.firstChild?.firstChild?.marks,
		).toHaveLength(1);
	});

	it("pastes and announces semantic HTML from an ordinary cell caret", () => {
		const onPasted = vi.fn();
		const editor = createEditor(content(1, 1), onPasted);
		editor.commands.setTextSelection(4);
		const source = createTable(editor.schema, 1, 2, false);

		expect(paste(editor, "A\tB", new Slice(Fragment.from(source), 0, 0))).toBe(true);
		expect(TableMap.get(editor.state.doc.firstChild!)).toMatchObject({ width: 2, height: 1 });
		expect(onPasted).toHaveBeenCalledWith(1, 2);
	});

	it("preserves merged geometry while clearing copied metadata on isolated cells", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									attrs: {
										colspan: 2,
										rowspan: 1,
										colwidth: [128, 144],
										textAlign: "center",
										emdashKey: "merged",
										emdashData: { future: "anchor" },
									},
									content: [{ type: "paragraph", content: [{ type: "text", text: "Merged" }] }],
								},
							],
						},
					],
				},
			],
		});
		editor.commands.setTextSelection(4);

		expect(paste(editor, "A\tB")).toBe(true);

		const table = editor.state.doc.firstChild!;
		expect(TableMap.get(table)).toMatchObject({ width: 2, height: 1, problems: null });
		expect(table.firstChild?.childCount).toBe(2);
		expect(table.firstChild?.child(0).attrs).toMatchObject({
			colspan: 1,
			colwidth: [128],
			textAlign: "center",
			emdashKey: "merged",
			emdashData: { future: "anchor" },
		});
		expect(table.firstChild?.child(1).attrs).toMatchObject({
			colwidth: [144],
			textAlign: "center",
			emdashData: null,
		});
		expect(table.firstChild?.child(1).attrs.emdashKey).not.toBe("merged");

		const partial = createEditor(content(1, 1));
		partial.commands.setTextSelection(4);
		const partialTable = partial.state.doc.firstChild!;
		const merged = partialTable.firstChild!.firstChild!;
		partial.view.dispatch(
			partial.state.tr.setNodeMarkup(2, undefined, {
				...merged.attrs,
				colspan: 2,
				colwidth: [128, 144],
				emdashData: { future: "anchor" },
			}),
		);
		expect(paste(partial, "Only", undefined, true)).toBe(true);
		const isolated = partial.state.doc.firstChild!.firstChild!;
		expect(isolated.child(1).attrs.emdashData).toBeNull();
		expect(isolated.child(1).attrs.colwidth).toEqual([144]);
	});

	it("honors explicit one-column TSV without changing ordinary multiline paste routing", () => {
		const editor = createEditor(content(1, 1));
		editor.commands.setTextSelection(4);
		expect(paste(editor, "A\nB", undefined, true)).toBe(true);
		expect(TableMap.get(editor.state.doc.firstChild!)).toMatchObject({ width: 1, height: 2 });

		const ordinary = createEditor(content(1, 1));
		ordinary.commands.setTextSelection(4);
		expect(paste(ordinary, "A\nB")).toBe(false);
	});

	it("serializes a selection as escaped logical-row TSV", () => {
		const editor = createEditor({
			...content(1, 2),
			content: [
				{
					...content(1, 2).content![0]!,
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [
										{
											type: "paragraph",
											content: [
												{ type: "text", text: "A" },
												{ type: "hardBreak" },
												{ type: "text", text: 'B"C' },
											],
										},
									],
								},
								{
									type: "tableCell",
									content: [{ type: "paragraph", content: [{ type: "text", text: "مرحبا" }] }],
								},
							],
						},
					],
				},
			],
		});
		const cells = positions(editor);
		editor.view.dispatch(
			editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0]!, cells[1]!)),
		);

		expect(serializeCellSelectionToTsv(editor.state)).toBe('"A\nB""C"\tمرحبا');
	});

	it("keeps native clipboard HTML semantic without exposing hidden attributes", () => {
		const editor = createEditor();
		const cells = positions(editor);
		editor.view.dispatch(
			editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0]!, cells[3]!)),
		);

		const clipboard = editor.view.serializeForClipboard(editor.state.selection.content());
		const container = document.createElement("div");
		container.append(clipboard.dom.cloneNode(true));

		expect(container.querySelector("table")).toBeTruthy();
		expect(container.querySelectorAll("th, td")).toHaveLength(4);
		expect(container.innerHTML).not.toContain("emdashKey");
		expect(container.innerHTML).not.toContain("emdashData");
		expect(clipboard.text).toBe("0:0\t0:1\n1:0\t1:1");
	});
});
