import { Editor, Node, type JSONContent } from "@tiptap/core";
import { createTable } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap, handlePaste as handleTablePaste } from "@tiptap/pm/tables";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTableCellSafety } from "../../src/components/editor/TableCellSafety";
import {
	EmDashTable,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
	TableIdentity,
} from "../../src/components/editor/TableExtensions";
import { MAX_TABLE_COLUMN_WIDTH, MAX_TABLE_PASTE_TEXT_BYTES } from "../../src/portable-text-table";

const atom = (name: string) =>
	Node.create({
		name,
		group: "block",
		atom: true,
		parseHTML: () => [{ tag: `div[data-${name}]` }],
		renderHTML: () => ["div", { [`data-${name}`]: "" }],
	});

const atomNames = ["image", "gallery", "htmlBlock", "pluginBlock"] as const;
const editors: Editor[] = [];

function createEditor(onRejected = vi.fn(), content?: JSONContent) {
	const editor = new Editor({
		extensions: [
			StarterKit,
			TextAlign.configure({ types: ["paragraph", "heading"] }),
			...atomNames.map(atom),
			EmDashTable,
			EmDashTableRow,
			EmDashTableHeader,
			EmDashTableCell,
			TableIdentity,
			createTableCellSafety(onRejected),
		],
		content: content ?? {
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
									content: [{ type: "paragraph", content: [{ type: "text", text: "Cell" }] }],
								},
							],
						},
					],
				},
			],
		},
	});
	editors.push(editor);
	return { editor, onRejected };
}

function selectCellText(editor: Editor) {
	let from = -1;
	editor.state.doc.descendants((node, position) => {
		if (node.isText && node.text === "Cell") from = position;
	});
	expect(from).toBeGreaterThan(0);
	editor.commands.setTextSelection({ from, to: from + 4 });
}

function selectCell(editor: Editor) {
	let position = -1;
	editor.state.doc.descendants((node, nodePosition) => {
		if (
			(node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") &&
			position === -1
		) {
			position = nodePosition;
		}
	});
	expect(position).toBeGreaterThan(0);
	editor.view.dispatch(
		editor.state.tr.setSelection(CellSelection.create(editor.state.doc, position)),
	);
}

function handlePaste(editor: Editor, slice: Slice) {
	const plugin = editor.state.plugins.find(({ key }) => key.startsWith("tableCellSafety$"));
	expect(plugin?.props.handlePaste).toBeTypeOf("function");
	return plugin!.props.handlePaste!(editor.view, new ClipboardEvent("paste"), slice);
}

function activeCell(editor: Editor) {
	let cell = editor.state.doc.firstChild?.firstChild?.firstChild;
	if (cell?.type.spec.tableRole === "header_cell") return cell;
	return cell?.type.spec.tableRole === "cell" ? cell : null;
}

function firstCellPosition(editor: Editor, role?: "cell" | "header_cell") {
	let position = -1;
	editor.state.doc.descendants((node, nodePosition) => {
		if (
			position === -1 &&
			(node.type.spec.tableRole === role ||
				(role === undefined &&
					(node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell")))
		) {
			position = nodePosition;
		}
	});
	expect(position).toBeGreaterThan(0);
	return position;
}

function tableWithCellAttrs(editor: Editor, attrs: Record<string, unknown>) {
	const table = createTable(editor.schema, 1, 1, false);
	const row = table.firstChild!;
	const cell = row.firstChild!;
	return table.type.create(table.attrs, [
		row.type.create(row.attrs, [cell.type.create({ ...cell.attrs, ...attrs }, cell.content)]),
	]);
}

function tableWithCellContent(editor: Editor, content: ProseMirrorNode[]) {
	const table = createTable(editor.schema, 1, 1, false);
	const row = table.firstChild!;
	const cell = row.firstChild!;
	const changedCell = cell.type.create(cell.attrs, content);
	const changedRow = row.type.create(row.attrs, [changedCell]);
	return {
		cell: changedCell,
		row: changedRow,
		table: table.type.create(table.attrs, [changedRow]),
	};
}

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

describe("table cell paste safety", () => {
	it("flattens text blocks into one paragraph with marks and hard-break boundaries", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const { schema } = editor;
		const bold = schema.marks.bold.create();
		const link = schema.marks.link.create({ href: "https://example.com" });
		const paragraph = schema.nodes.paragraph;
		const listItem = schema.nodes.listItem;
		const slice = new Slice(
			Fragment.fromArray([
				schema.nodes.heading.create({ level: 2 }, schema.text("Heading", [bold])),
				schema.nodes.bulletList.create(null, [
					listItem.create(null, paragraph.create(null, schema.text("Item", [link]))),
				]),
				schema.nodes.codeBlock.create(null, schema.text("code\nline")),
			]),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).not.toHaveBeenCalled();
		const cell = activeCell(editor)!;
		expect(cell.childCount).toBe(1);
		const children = [...cell.firstChild!.content.content];
		expect(children.map((node) => (node.isText ? node.text : node.type.name))).toEqual([
			"Heading",
			"hardBreak",
			"Item",
			"hardBreak",
			"code",
			"hardBreak",
			"line",
		]);
		expect(children[0]!.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
		expect(children[2]!.marks.map((mark) => mark.type.name)).toEqual(["link"]);
	});

	it.each(atomNames)("rejects %s atoms without changing the document", (name) => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const slice = new Slice(Fragment.from(editor.schema.nodes[name].create()), 0, 0);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("unsupported-content");
		expect(editor.getJSON()).toEqual(before);
	});

	it.each(["image", "pluginBlock"])(
		"rejects %s atoms for a CellSelection without changing the document",
		(name) => {
			const { editor, onRejected } = createEditor();
			selectCell(editor);
			const before = editor.getJSON();
			const slice = new Slice(Fragment.from(editor.schema.nodes[name].create()), 0, 0);

			expect(handlePaste(editor, slice)).toBe(true);
			expect(onRejected).toHaveBeenCalledWith("unsupported-content");
			expect(editor.getJSON()).toEqual(before);
		},
	);

	it("replaces selected cell content without changing its structure or attributes", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableHeader",
									attrs: {
										colspan: 2,
										rowspan: 1,
										colwidth: [128, 144],
										textAlign: "right",
										emdashKey: "stable-header",
										emdashData: { future: "kept" },
									},
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "Cell" }],
										},
									],
								},
							],
						},
					],
				},
			],
		});
		selectCell(editor);
		const before = activeCell(editor)!;
		const beforeAttrs = before.attrs;
		const beforeType = before.type;
		let documentTransactions = 0;
		editor.on("transaction", ({ transaction }) => {
			if (transaction.docChanged) documentTransactions++;
		});
		const bold = editor.schema.marks.bold.create();
		const heading = editor.schema.nodes.heading.create(
			null,
			editor.schema.text("Replacement", [bold]),
		);

		expect(handlePaste(editor, new Slice(Fragment.from(heading), 0, 0))).toBe(true);
		expect(onRejected).not.toHaveBeenCalled();
		const changedCell = activeCell(editor)!;
		const paragraph = changedCell.firstChild!;
		expect(changedCell.type).toBe(beforeType);
		expect(changedCell.attrs).toEqual(beforeAttrs);
		expect(paragraph.textContent).toBe("Replacement");
		expect(paragraph.firstChild!.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
		expect(documentTransactions).toBe(1);
		expect(editor.commands.undo()).toBe(true);
		expect(activeCell(editor)?.textContent).toBe("Cell");
		expect(editor.commands.redo()).toBe(true);
		expect(activeCell(editor)?.textContent).toBe("Replacement");
	});

	it("rejects a nested table without changing the document", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const nested = editor.schema.nodes.blockquote.create(
			null,
			createTable(editor.schema, 1, 1, false),
		);

		expect(handlePaste(editor, new Slice(Fragment.from(nested), 0, 0))).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("table-must-be-top-level");
		expect(editor.getJSON()).toEqual(before);
	});

	it("classifies mixed table and atom content as unsupported", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const slice = new Slice(
			Fragment.fromArray([
				createTable(editor.schema, 1, 1, false),
				editor.schema.nodes.image.create(),
			]),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("unsupported-content");
		expect(editor.getJSON()).toEqual(before);
	});

	it("delegates mixed block content outside a table cell", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Outside" }],
				},
			],
		});
		const slice = new Slice(
			Fragment.fromArray([
				createTable(editor.schema, 1, 1, false),
				editor.schema.nodes.image.create(),
			]),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(false);
		expect(onRejected).not.toHaveBeenCalled();
	});

	it.each(["forward", "backward"] as const)(
		"delegates normal document paste for a %s selection crossing a table boundary",
		(direction) => {
			const { editor, onRejected } = createEditor(vi.fn(), {
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
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Cell" }],
											},
										],
									},
								],
							},
						],
					},
					{ type: "paragraph", content: [{ type: "text", text: "After" }] },
				],
			});
			let cell = -1;
			let after = -1;
			editor.state.doc.descendants((node, position) => {
				if (node.isText && node.text === "Cell") cell = position;
				if (node.isText && node.text === "After") after = position + node.nodeSize;
			});
			editor.view.dispatch(
				editor.state.tr.setSelection(
					TextSelection.create(
						editor.state.doc,
						direction === "forward" ? cell : after,
						direction === "forward" ? after : cell,
					),
				),
			);

			expect(
				handlePaste(editor, new Slice(Fragment.from(editor.schema.nodes.image.create()), 0, 0)),
			).toBe(false);
			expect(onRejected).not.toHaveBeenCalled();
		},
	);

	it("rejects an unsafe table inside mixed block content outside a cell", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Outside" }] }],
		});
		const malformed = tableWithCellAttrs(editor, { colspan: 101, colwidth: [144] });
		const slice = new Slice(
			Fragment.fromArray([
				malformed,
				editor.schema.nodes.paragraph.create(null, editor.schema.text("Following")),
			]),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("invalid-table");
	});

	it("applies paste limits across every table in one mixed payload", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Outside" }] }],
		});
		const slice = new Slice(
			Fragment.fromArray([
				createTable(editor.schema, 51, 100, false),
				editor.schema.nodes.paragraph.create(null, editor.schema.text("Between")),
				createTable(editor.schema, 51, 100, false),
			]),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("too-large");
	});

	it("counts paragraph boundaries across every table in one paste", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Outside" }] }],
		});
		const paragraph = editor.schema.nodes.paragraph;
		const half = Math.floor(MAX_TABLE_PASTE_TEXT_BYTES / 2);
		const first = tableWithCellContent(editor, [
			paragraph.create(null, editor.schema.text("a".repeat(half))),
			paragraph.create(),
		]);
		const second = tableWithCellContent(editor, [
			paragraph.create(null, editor.schema.text("b".repeat(half))),
			paragraph.create(),
		]);
		const slice = new Slice(Fragment.fromArray([first.table, second.table]), 0, 0);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("too-large");
	});

	it("preflights a table nested inside a supported document block", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Outside" }] }],
		});
		const malformed = tableWithCellAttrs(editor, { colspan: 101, colwidth: [144] });
		const slice = new Slice(
			Fragment.from(editor.schema.nodes.blockquote.create(null, malformed)),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("invalid-table");
	});

	it("rejects a supported table nested in a block the serializer cannot preserve", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Outside" }] }],
		});
		editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
		const before = editor.getJSON();
		const slice = new Slice(
			Fragment.from(
				editor.schema.nodes.blockquote.create(null, createTable(editor.schema, 1, 1, false)),
			),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("table-must-be-top-level");
		expect(editor.getJSON()).toEqual(before);
	});

	it("rejects table paste when the target is inside a quote", () => {
		const { editor, onRejected } = createEditor(vi.fn(), {
			type: "doc",
			content: [
				{
					type: "blockquote",
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "Quote" }],
						},
					],
				},
			],
		});
		let position = -1;
		editor.state.doc.descendants((node, nodePosition) => {
			if (node.isText && node.text === "Quote") position = nodePosition;
		});
		editor.commands.setTextSelection(position);
		const before = editor.getJSON();

		expect(
			handlePaste(editor, new Slice(Fragment.from(createTable(editor.schema, 1, 1, false)), 0, 0)),
		).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("table-must-be-top-level");
		expect(editor.getJSON()).toEqual(before);
	});

	it("delegates a bounded outer table to ProseMirror Tables", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const table = createTable(editor.schema, 2, 2, true);

		expect(handlePaste(editor, new Slice(Fragment.from(table), 0, 0))).toBe(false);
		expect(onRejected).not.toHaveBeenCalled();
	});

	it("delegates every bounded ProseMirror table slice shape", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const table = createTable(editor.schema, 2, 2, true);
		const row = table.firstChild!;
		const header = row.firstChild!;
		const bodyCell = table.lastChild!.firstChild!;

		for (const slice of [
			new Slice(Fragment.from(table), 0, 0),
			new Slice(Fragment.from(row), 1, 1),
			new Slice(Fragment.from(bodyCell), 0, 0),
			new Slice(Fragment.from(header), 0, 0),
		]) {
			expect(handlePaste(editor, slice)).toBe(false);
		}
		expect(onRejected).not.toHaveBeenCalled();
	});

	it.each(["table", "row", "cell"] as const)(
		"rejects unsupported cell blocks in a direct %s slice",
		(shape) => {
			const { editor, onRejected } = createEditor();
			selectCellText(editor);
			const before = editor.getJSON();
			const invalid = tableWithCellContent(editor, [
				editor.schema.nodes.heading.create({ level: 2 }, editor.schema.text("Unsupported heading")),
			]);
			const node = invalid[shape];

			expect(handlePaste(editor, new Slice(Fragment.from(node), 0, 0))).toBe(true);
			expect(onRejected).toHaveBeenCalledWith("unsupported-content");
			expect(editor.getJSON()).toEqual(before);
		},
	);

	it("rejects an unsupported atom inside a direct table slice", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const invalid = tableWithCellContent(editor, [editor.schema.nodes.image.create()]);

		expect(handlePaste(editor, new Slice(Fragment.from(invalid.table), 0, 0))).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("unsupported-content");
		expect(editor.getJSON()).toEqual(before);
	});

	it("rejects paragraph alignment that would diverge from the cell attribute", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const invalid = tableWithCellContent(editor, [
			editor.schema.nodes.paragraph.create({ textAlign: "center" }, editor.schema.text("Centered")),
		]);

		expect(handlePaste(editor, new Slice(Fragment.from(invalid.table), 0, 0))).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("invalid-table");
		expect(editor.getJSON()).toEqual(before);
	});

	it("preserves attributes from a real partial CellSelection slice", () => {
		const sourceContent: JSONContent = {
			type: "doc",
			content: [
				{
					type: "table",
					content: [
						{
							type: "tableRow",
							content: [
								{
									type: "tableHeader",
									attrs: {
										colspan: 1,
										rowspan: 1,
										colwidth: [144],
										textAlign: "center",
										emdashKey: "incoming-header",
										emdashData: { future: "kept" },
									},
									content: [
										{
											type: "paragraph",
											content: [{ type: "text", text: "Heading", marks: [{ type: "bold" }] }],
										},
									],
								},
							],
						},
						{
							type: "tableRow",
							content: [
								{
									type: "tableCell",
									content: [{ type: "paragraph" }],
								},
							],
						},
					],
				},
			],
		};
		const { editor: source } = createEditor(vi.fn(), sourceContent);
		const sourcePosition = firstCellPosition(source, "header_cell");
		source.view.dispatch(
			source.state.tr.setSelection(CellSelection.create(source.state.doc, sourcePosition)),
		);
		const copied = source.state.selection.content();
		expect(copied.openStart).toBe(1);

		const { editor: target, onRejected } = createEditor();
		const targetSlice = Slice.fromJSON(target.schema, copied.toJSON());
		selectCellText(target);
		expect(handlePaste(target, targetSlice)).toBe(false);
		expect(handleTablePaste(target.view, new ClipboardEvent("paste"), targetSlice)).toBe(true);

		const pasted = activeCell(target)!;
		expect(pasted.type.spec.tableRole).toBe("header_cell");
		expect(pasted.attrs).toMatchObject({
			colspan: 1,
			rowspan: 1,
			colwidth: [144],
			textAlign: "center",
			emdashKey: "incoming-header",
			emdashData: { future: "kept" },
		});
		expect(pasted.textContent).toBe("Heading");
		expect(pasted.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
		expect(onRejected).not.toHaveBeenCalled();
	});

	it.each([
		[0, 1],
		[1, 0],
	] as const)(
		"repairs the pasted duplicate when copying cell %s to cell %s",
		(sourceIndex, targetIndex) => {
			const { editor, onRejected } = createEditor();
			selectCellText(editor);
			expect(editor.commands.addColumnAfter()).toBe(true);
			const positions: number[] = [];
			editor.state.doc.descendants((node, position) => {
				if (node.type.spec.tableRole === "cell") positions.push(position);
			});
			const sourcePosition = positions[sourceIndex]!;
			const targetPosition = positions[targetIndex]!;
			editor.view.dispatch(
				editor.state.tr.setNodeMarkup(sourcePosition, undefined, {
					...editor.state.doc.nodeAt(sourcePosition)!.attrs,
					emdashKey: "copied-cell",
				}),
			);
			editor.view.dispatch(
				editor.state.tr.setSelection(CellSelection.create(editor.state.doc, sourcePosition)),
			);
			const copied = editor.state.selection.content();
			editor.commands.setTextSelection(targetPosition + 2);

			expect(handlePaste(editor, copied)).toBe(false);
			expect(handleTablePaste(editor.view, new ClipboardEvent("paste"), copied)).toBe(true);

			const row = editor.state.doc.firstChild!.firstChild!;
			const keys = Array.from({ length: row.childCount }, (_, index) =>
				String(row.child(index).attrs.emdashKey),
			);
			expect(keys).toContain("copied-cell");
			expect(new Set(keys).size).toBe(keys.length);
			expect(keys[sourceIndex]).toBe("copied-cell");
			expect(keys[targetIndex]).not.toBe("copied-cell");
			expect(onRejected).not.toHaveBeenCalled();
		},
	);

	it.each(["before", "after"] as const)(
		"repairs a whole-table duplicate inserted %s its source",
		(placement) => {
			const { editor } = createEditor(vi.fn(), {
				type: "doc",
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "Before" }] },
					{
						type: "table",
						attrs: { emdashKey: "source-table" },
						content: [
							{
								type: "tableRow",
								attrs: { emdashKey: "source-row" },
								content: [
									{
										type: "tableCell",
										attrs: { emdashKey: "source-cell" },
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Source" }],
											},
										],
									},
								],
							},
						],
					},
					{ type: "paragraph", content: [{ type: "text", text: "After" }] },
				],
			});
			let sourcePosition = -1;
			let source: ProseMirrorNode | null = null;
			editor.state.doc.descendants((node, position) => {
				if (node.type.spec.tableRole === "table" && source === null) {
					source = node;
					sourcePosition = position;
					return false;
				}
			});
			expect(source).toBeTruthy();
			const insertPosition =
				placement === "before" ? sourcePosition : sourcePosition + source!.nodeSize;
			editor.view.dispatch(editor.state.tr.insert(insertPosition, source!));

			const tableKeys: string[] = [];
			editor.state.doc.forEach((node) => {
				if (node.type.spec.tableRole === "table") tableKeys.push(node.attrs.emdashKey);
			});
			expect(tableKeys).toHaveLength(2);
			const sourceIndex = placement === "before" ? 1 : 0;
			expect(tableKeys[sourceIndex]).toBe("source-table");
			expect(tableKeys[1 - sourceIndex]).not.toBe("source-table");
			expect(new Set(tableKeys).size).toBe(2);
		},
	);

	it("retries a generated table key that collides with another top-level table", () => {
		const table = (key: string, text: string): JSONContent => ({
			type: "table",
			attrs: { emdashKey: key },
			content: [
				{
					type: "tableRow",
					attrs: { emdashKey: `${key}-row` },
					content: [
						{
							type: "tableCell",
							attrs: { emdashKey: `${key}-cell` },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text }],
								},
							],
						},
					],
				},
			],
		});
		const { editor } = createEditor(vi.fn(), {
			type: "doc",
			content: [table("aaaaaaaaaaaa", "Existing"), table("source-table", "Source")],
		});
		const source = editor.state.doc.child(1);
		const randomUUID = vi
			.spyOn(globalThis.crypto, "randomUUID")
			.mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
			.mockReturnValueOnce("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

		editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, source));

		const tableKeys: string[] = [];
		editor.state.doc.forEach((node) => {
			if (node.type.spec.tableRole === "table") tableKeys.push(node.attrs.emdashKey);
		});
		expect(tableKeys).toEqual(["aaaaaaaaaaaa", "source-table", "bbbbbbbbbbbb"]);
		randomUUID.mockRestore();
	});

	it("rejects an oversized outer table without changing the document", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const table = createTable(editor.schema, 1, 101, false);

		expect(handlePaste(editor, new Slice(Fragment.from(table), 0, 0))).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("too-large");
		expect(editor.getJSON()).toEqual(before);
	});

	it("rejects oversized plain text without changing the document or selection", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const selection = editor.state.selection.toJSON();
		const text = "x".repeat(MAX_TABLE_PASTE_TEXT_BYTES + 1);

		expect(handlePaste(editor, new Slice(Fragment.from(editor.schema.text(text)), 0, 0))).toBe(
			true,
		);
		expect(onRejected).toHaveBeenCalledWith("too-large");
		expect(editor.getJSON()).toEqual(before);
		expect(editor.state.selection.toJSON()).toEqual(selection);
	});

	it("rejects malformed table attributes before allocating a TableMap", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const selection = editor.state.selection.toJSON();
		const getTableMap = vi.spyOn(TableMap, "get");
		const malformed = tableWithCellAttrs(editor, { colspan: 101, colwidth: [144] });

		expect(handlePaste(editor, new Slice(Fragment.from(malformed), 0, 0))).toBe(true);
		expect(getTableMap).not.toHaveBeenCalled();
		expect(onRejected).toHaveBeenCalledWith("invalid-table");
		expect(editor.getJSON()).toEqual(before);
		expect(editor.state.selection.toJSON()).toEqual(selection);
		getTableMap.mockRestore();
	});

	it.each([
		["zero colspan", { colspan: 0 }],
		["negative rowspan", { rowspan: -1 }],
		["fractional span", { colspan: 1.5 }],
		["negative width", { colwidth: [-1] }],
		["fractional width", { colwidth: [12.5] }],
		["non-finite width", { colwidth: [Number.NaN] }],
		["oversized width", { colwidth: [MAX_TABLE_COLUMN_WIDTH + 1] }],
		["mismatched widths", { colspan: 2, colwidth: [144] }],
	])("rejects %s", (_label, attrs) => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const malformed = tableWithCellAttrs(editor, attrs);

		expect(handlePaste(editor, new Slice(Fragment.from(malformed), 0, 0))).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("invalid-table");
		expect(editor.getJSON()).toEqual(before);
	});

	it("accepts ProseMirror's automatic zero-width sentinel", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const table = tableWithCellAttrs(editor, { colwidth: [0] });

		expect(handlePaste(editor, new Slice(Fragment.from(table), 0, 0))).toBe(false);
		expect(onRejected).not.toHaveBeenCalled();
	});

	it("counts the hard break inserted between flattened blocks toward the byte limit", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const paragraph = editor.schema.nodes.paragraph;
		const slice = new Slice(
			Fragment.fromArray([
				paragraph.create(null, editor.schema.text("x".repeat(MAX_TABLE_PASTE_TEXT_BYTES - 1))),
				paragraph.create(null, editor.schema.text("x")),
			]),
			0,
			0,
		);

		expect(handlePaste(editor, slice)).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("too-large");
		expect(editor.getJSON()).toEqual(before);
	});

	it("counts table-cell paragraph boundaries toward the byte limit", () => {
		const { editor, onRejected } = createEditor();
		selectCellText(editor);
		const before = editor.getJSON();
		const paragraph = editor.schema.nodes.paragraph;
		const invalid = tableWithCellContent(editor, [
			paragraph.create(null, editor.schema.text("x".repeat(MAX_TABLE_PASTE_TEXT_BYTES))),
			paragraph.create(),
		]);

		expect(handlePaste(editor, new Slice(Fragment.from(invalid.table), 0, 0))).toBe(true);
		expect(onRejected).toHaveBeenCalledWith("too-large");
		expect(editor.getJSON()).toEqual(before);
	});

	it("accepts an empty row covered by a copied rowspan", () => {
		const sourceContent: JSONContent = {
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
									attrs: { colspan: 1, rowspan: 2, colwidth: [144] },
									content: [{ type: "paragraph", content: [{ type: "text", text: "Span" }] }],
								},
							],
						},
						{ type: "tableRow", content: [] },
					],
				},
			],
		};
		const { editor: source } = createEditor(vi.fn(), sourceContent);
		const sourcePosition = firstCellPosition(source);
		source.view.dispatch(
			source.state.tr.setSelection(CellSelection.create(source.state.doc, sourcePosition)),
		);
		const { editor: target, onRejected } = createEditor();
		const copied = Slice.fromJSON(target.schema, source.state.selection.content().toJSON());

		expect(handlePaste(target, copied)).toBe(false);
		expect(onRejected).not.toHaveBeenCalled();
	});
});
