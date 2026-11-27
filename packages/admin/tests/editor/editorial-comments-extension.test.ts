import { Editor, Extension, Node } from "@tiptap/core";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { undoDepth } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorialCommentsBridge } from "../../src/components/editor/EditorialCommentsExtension";
import {
	anchorForRange,
	anchorForSelection,
	createEditorialCommentsExtension,
	getEditorialHighlights,
	getEditorialPending,
	locateAnchor,
	setEditorialHighlights,
} from "../../src/components/editor/EditorialCommentsExtension";
import { PORTABLE_TEXT_KEY_ATTR } from "../../src/components/editor/portableTextIdentity";
import {
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
} from "../../src/components/editor/TableExtensions";
import type { EditorialTextAnchor } from "../../src/editorial-anchors";
import { PortableTextTable } from "../../src/portable-text/schema";

const KeyAttribute = Extension.create({
	name: "testPortableTextKey",
	addGlobalAttributes() {
		return [
			{
				types: ["paragraph", "codeBlock"],
				attributes: { [PORTABLE_TEXT_KEY_ATTR]: { default: null, rendered: false } },
			},
		];
	},
});

const InlineAtom = Node.create({
	name: "testInlineAtom",
	group: "inline",
	inline: true,
	atom: true,
	renderHTML: () => ["span"],
});

let editor: Editor | null = null;

function createEditor(
	paragraphs: Array<{ key: string | null; content: unknown[] }>,
	bridge: EditorialCommentsBridge = {},
) {
	editor = new Editor({
		element: document.createElement("div"),
		extensions: [
			StarterKit,
			KeyAttribute,
			InlineAtom,
			createEditorialCommentsExtension({ current: bridge }),
		],
		content: {
			type: "doc",
			content: paragraphs.map((paragraph) => ({
				type: "paragraph",
				attrs: { [PORTABLE_TEXT_KEY_ATTR]: paragraph.key },
				content: paragraph.content,
			})),
		},
	});
	return editor;
}

afterEach(() => {
	editor?.destroy();
	editor = null;
});

const text = (value: string, marks?: unknown[]) => ({
	type: "text",
	text: value,
	...(marks ? { marks } : {}),
});

describe("editorial comment highlights", () => {
	it("finds a text anchor after a hard break, by the text Portable Text stores", () => {
		const ed = createEditor([
			{ key: "b1", content: [text("Line one"), { type: "hardBreak" }, text("line two")] },
		]);
		const anchor: EditorialTextAnchor = {
			type: "text",
			field: "content",
			blockKey: "b1",
			start: 9,
			end: 13,
			quote: "line",
			prefix: "Line one\n",
			suffix: " two",
		};

		const range = locateAnchor(ed.state.doc, anchor);

		expect(range).not.toBeNull();
		expect(ed.state.doc.textBetween(range!.from, range!.to)).toBe("line");
	});

	it("starts a highlight after an inline node with no text, such as a mention", () => {
		const ed = createEditor([
			{ key: "b1", content: [text("Hi "), { type: "testInlineAtom" }, text("Ann")] },
		]);
		const anchor: EditorialTextAnchor = {
			type: "text",
			field: "content",
			blockKey: "b1",
			start: 3,
			end: 6,
			quote: "Ann",
			prefix: "Hi ",
			suffix: "",
		};

		// Paragraph content starts at 1: "Hi " is 1–4, the atom 4–5, "Ann" 5–8.
		expect(locateAnchor(ed.state.doc, anchor)).toEqual({ kind: "text", from: 5, to: 8 });
	});

	it("finds a quote in content saved without block keys, without storing a stand-in key", () => {
		const ed = createEditor([{ key: null, content: [text("The quick brown fox")] }]);
		const anchor: EditorialTextAnchor = {
			type: "text",
			field: "content",
			blockKey: "gone",
			start: 4,
			end: 9,
			quote: "quick",
			prefix: "The ",
			suffix: " brown fox",
		};

		const range = locateAnchor(ed.state.doc, anchor);

		expect(ed.state.doc.textBetween(range!.from, range!.to)).toBe("quick");
		expect(anchorForRange(ed.state.doc, "content", range!.from, range!.to)).toBeNull();
	});

	it("moves a highlight with text typed before it", () => {
		const ed = createEditor([{ key: "b1", content: [text("The quick brown fox")] }]);
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 5, to: 10 }],
		});

		ed.commands.insertContentAt(1, "See: ");

		const [highlight] = getEditorialHighlights(ed.state);
		expect(ed.state.doc.textBetween(highlight!.from, highlight!.to)).toBe("quick");
	});

	it("marks every piece of a hovered thread and shows its badge", () => {
		const ed = createEditor([
			{
				key: "b1",
				content: [text("The "), text("quick", [{ type: "bold" }]), text(" brown fox")],
			},
		]);
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 1, to: 15, badge: "2" }],
		});
		const pieces = () => [...ed.view.dom.querySelectorAll('[data-editorial-thread="t1"]')];
		const badge = () => ed.view.dom.querySelector(".emdash-editorial-badge");

		expect(pieces().length).toBeGreaterThan(1);
		expect(badge()).toBeNull();

		pieces()[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

		expect(pieces().every((piece) => piece.classList.contains("emdash-editorial-hover"))).toBe(
			true,
		);
		expect(badge()?.textContent).toBe("2");

		ed.view.dom.dispatchEvent(new MouseEvent("mouseleave"));

		expect(pieces().some((piece) => piece.classList.contains("emdash-editorial-hover"))).toBe(
			false,
		);
		expect(badge()).toBeNull();
	});

	it("shows the active thread's badge without hovering", () => {
		const ed = createEditor([{ key: "b1", content: [text("The quick brown fox")] }]);
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 5, to: 10, badge: "3" }],
			activeThreadId: "t1",
		});

		expect(ed.view.dom.querySelector(".emdash-editorial-badge")?.textContent).toBe("3");
		expect(ed.state.doc.textContent).toBe("The quick brown fox");
	});

	it("reports a click in a highlight as its thread and a click elsewhere as none", () => {
		const onActivate = vi.fn();
		const onDeactivate = vi.fn();
		const ed = createEditor([{ key: "b1", content: [text("The quick brown fox")] }], {
			onActivate,
			onDeactivate,
		});
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 5, to: 10 }],
		});
		const click = (pos: number) =>
			ed.view.someProp("handleClick", (handle) => handle(ed.view, pos, new MouseEvent("click")));

		click(7);
		expect(onActivate).toHaveBeenCalledWith("t1");
		expect(onDeactivate).not.toHaveBeenCalled();

		click(16);
		expect(onDeactivate).toHaveBeenCalledOnce();
		expect(onActivate).toHaveBeenCalledOnce();
	});

	it("leaves a click at the edge of a highlight to place the caret", () => {
		const onActivate = vi.fn();
		const ed = createEditor([{ key: "b1", content: [text("The quick brown fox")] }], {
			onActivate,
		});
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 5, to: 10 }],
		});

		for (const pos of [5, 10]) {
			ed.view.someProp("handleClick", (handle) => handle(ed.view, pos, new MouseEvent("click")));
		}

		expect(onActivate).not.toHaveBeenCalled();
	});

	it("drops a highlight whose text is deleted", () => {
		const ed = createEditor([{ key: "b1", content: [text("The quick brown fox")] }]);
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "text", from: 5, to: 10 }],
		});

		ed.commands.deleteRange({ from: 4, to: 11 });

		expect(getEditorialHighlights(ed.state)).toEqual([]);
	});

	it("keys an unsaved block so the new anchor survives the next save", () => {
		const ed = createEditor([{ key: null, content: [text("Fresh paragraph")] }]);
		ed.commands.setTextSelection({ from: 7, to: 16 });

		const result = anchorForSelection(ed.state, ed.view.dispatch, "content", () => "new1");

		expect(result).toMatchObject({
			ok: true,
			anchor: { blockKey: "new1", start: 6, end: 15, quote: "paragraph", prefix: "Fresh " },
		});
		expect(ed.state.doc.firstChild!.attrs[PORTABLE_TEXT_KEY_ATTR]).toBe("new1");
	});

	it("keeps the new block key when the edit before the comment is undone", () => {
		const ed = createEditor([{ key: null, content: [text("Fresh paragraph")] }]);
		ed.commands.insertContentAt(16, "!");
		ed.commands.setTextSelection({ from: 7, to: 16 });
		anchorForSelection(ed.state, ed.view.dispatch, "content", () => "new1");

		ed.commands.undo();

		expect(ed.state.doc.textContent).toBe("Fresh paragraph");
		expect(ed.state.doc.firstChild!.attrs[PORTABLE_TEXT_KEY_ATTR]).toBe("new1");
	});

	it("refuses a selection across blocks", () => {
		const ed = createEditor([
			{ key: "b1", content: [text("One")] },
			{ key: "b2", content: [text("Two")] },
		]);
		ed.commands.setTextSelection({ from: 2, to: 7 });

		expect(anchorForSelection(ed.state, ed.view.dispatch, "content", () => "x")).toEqual({
			ok: false,
			reason: "multiple-blocks",
		});
	});
});

const TestImage = Node.create({
	name: "image",
	group: "block",
	atom: true,
	selectable: true,
	addAttributes: () => ({ [PORTABLE_TEXT_KEY_ATTR]: { default: null, rendered: false } }),
	renderHTML: () => ["figure", ["img"]],
});

function createEditorWithImage(imageKey: string | null, bridge: EditorialCommentsBridge = {}) {
	editor = new Editor({
		element: document.createElement("div"),
		extensions: [
			StarterKit,
			KeyAttribute,
			TestImage,
			createEditorialCommentsExtension({ current: bridge }),
		],
		content: {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { [PORTABLE_TEXT_KEY_ATTR]: "b1" },
					content: [text("Caption")],
				},
				{ type: "image", attrs: { [PORTABLE_TEXT_KEY_ATTR]: imageKey } },
			],
		},
	});
	// The paragraph spans 0–9, so the image sits at 9.
	return editor;
}

describe("editorial block comments", () => {
	it("anchors a selected image to its block, keying it outside the undo history", () => {
		const ed = createEditorWithImage(null);
		ed.commands.setNodeSelection(9);
		const depth = undoDepth(ed.state);

		const result = anchorForSelection(ed.state, ed.view.dispatch, "body", () => "img1");

		expect(result).toEqual({
			ok: true,
			anchor: { type: "block", field: "body", blockKey: "img1" },
			range: { kind: "block", from: 9, to: 10 },
		});
		expect(ed.state.doc.child(1).attrs[PORTABLE_TEXT_KEY_ATTR]).toBe("img1");
		expect(undoDepth(ed.state)).toBe(depth);
	});

	it("highlights a block thread on its node and opens it from a click", () => {
		const onActivate = vi.fn();
		const ed = createEditorWithImage("img1", { onActivate });
		const range = locateAnchor(ed.state.doc, { type: "block", field: "body", blockKey: "img1" });
		expect(range).toEqual({ kind: "block", from: 9, to: 10 });

		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", ...range! }],
		});

		const figure = ed.view.dom.querySelector('[data-editorial-thread="t1"]');
		expect(figure?.tagName).toBe("FIGURE");
		expect(figure?.classList.contains("emdash-editorial-block")).toBe(true);
		ed.view.someProp("handleClick", (handle) =>
			handle(ed.view, 9, new MouseEvent("click", { bubbles: true })),
		);
		expect(onActivate).toHaveBeenCalledWith("t1");
	});

	it("keeps a block thread and a block draft when a block is inserted right before them", () => {
		const ed = createEditorWithImage("img1");
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "block", from: 9, to: 10 }],
			pending: { kind: "block", from: 9, to: 10 },
		});

		ed.commands.insertContentAt(9, { type: "paragraph", content: [text("New")] });

		expect(getEditorialHighlights(ed.state)).toEqual([
			{ threadId: "t1", kind: "block", from: 14, to: 15 },
		]);
		expect(getEditorialPending(ed.state)).toEqual({ kind: "block", from: 14, to: 15 });
	});

	it("drops a block highlight when its block is deleted", () => {
		const ed = createEditorWithImage("img1");
		setEditorialHighlights(ed.state, ed.view.dispatch, {
			highlights: [{ threadId: "t1", kind: "block", from: 9, to: 10 }],
		});

		ed.commands.deleteRange({ from: 9, to: 10 });

		expect(getEditorialHighlights(ed.state)).toEqual([]);
	});
});

describe("editorial comments in a read-only editor", () => {
	it("won't key a block to comment on it", () => {
		const ed = createEditor([{ key: null, content: [text("Fresh paragraph")] }]);
		ed.setEditable(false);
		ed.commands.setTextSelection({ from: 7, to: 16 });

		expect(anchorForSelection(ed.state, ed.view.dispatch, "content", () => "new1", false)).toEqual({
			ok: false,
			reason: "unkeyed",
		});
		expect(ed.state.doc.firstChild!.attrs[PORTABLE_TEXT_KEY_ATTR]).toBeNull();
	});

	it("starts a comment from the keyboard shortcut", () => {
		const onCommentShortcut = vi.fn();
		const ed = createEditor([{ key: "b1", content: [text("Fresh paragraph")] }], {
			onCommentShortcut,
		});
		ed.setEditable(false);
		const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

		ed.view.dom.dispatchEvent(
			new KeyboardEvent("keydown", {
				code: "KeyM",
				key: "m",
				altKey: true,
				metaKey: mac,
				ctrlKey: !mac,
				bubbles: true,
			}),
		);

		expect(onCommentShortcut).toHaveBeenCalledOnce();
	});
});

describe("editorial comments on text that isn't saved as a text block", () => {
	const quickAnchor: EditorialTextAnchor = {
		type: "text",
		field: "content",
		blockKey: "gone",
		start: 4,
		end: 9,
		quote: "quick",
		prefix: "The ",
		suffix: " brown fox",
	};

	function createEditorWith(content: unknown[]) {
		editor = new Editor({
			element: document.createElement("div"),
			extensions: [
				StarterKit,
				KeyAttribute,
				Table,
				TableRow,
				TableCell,
				TableHeader,
				createEditorialCommentsExtension({ current: {} }),
			],
			content: { type: "doc", content },
		});
		return editor;
	}

	const codeBlock = {
		type: "codeBlock",
		attrs: { [PORTABLE_TEXT_KEY_ATTR]: "code1" },
		content: [text("The quick brown fox")],
	};
	const table = {
		type: "table",
		content: [
			{
				type: "tableRow",
				content: [
					{
						type: "tableCell",
						content: [{ type: "paragraph", content: [text("The quick brown fox")] }],
					},
				],
			},
		],
	};

	it("doesn't find a deleted paragraph's quote in a code block or a table cell", () => {
		const ed = createEditorWith([codeBlock, table]);

		expect(locateAnchor(ed.state.doc, quickAnchor)).toBeNull();
	});

	it("comments on the whole code block when text in it is selected", () => {
		const ed = createEditorWith([codeBlock]);
		ed.commands.setTextSelection({ from: 5, to: 10 });

		expect(anchorForSelection(ed.state, ed.view.dispatch, "content", () => "x")).toEqual({
			ok: true,
			anchor: { type: "block", field: "content", blockKey: "code1" },
			range: { kind: "block", from: 0, to: codeBlock.content[0]!.text.length + 2 },
		});
	});

	it("refuses text selected in a table cell", () => {
		const ed = createEditorWith([table]);
		let cellText = -1;
		ed.state.doc.descendants((node, pos) => {
			if (node.isText && cellText < 0) cellText = pos;
		});
		ed.commands.setTextSelection({ from: cellText + 4, to: cellText + 9 });

		expect(anchorForSelection(ed.state, ed.view.dispatch, "content", () => "x")).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});
});

describe("editorial comments on a top-level table", () => {
	function createEditorWithTable(tableKey: string | null) {
		editor = new Editor({
			element: document.createElement("div"),
			extensions: [
				StarterKit,
				KeyAttribute,
				PortableTextTable,
				EmDashTableRow,
				EmDashTableHeader,
				EmDashTableCell,
				createEditorialCommentsExtension({ current: {} }),
			],
			content: {
				type: "doc",
				content: [
					{
						type: "table",
						attrs: { emdashKey: tableKey },
						content: [
							{
								type: "tableRow",
								attrs: { emdashKey: "row1" },
								content: [
									{
										type: "tableCell",
										content: [{ type: "paragraph", content: [text("Price")] }],
									},
								],
							},
						],
					},
				],
			},
		});
		return editor;
	}

	it("finds a block thread on the table by the key it saves", () => {
		const ed = createEditorWithTable("tbl1");

		expect(locateAnchor(ed.state.doc, { type: "block", field: "body", blockKey: "tbl1" })).toEqual({
			kind: "block",
			from: 0,
			to: ed.state.doc.child(0).nodeSize,
		});
	});

	it("anchors a selected table to its key, giving it one when it has none", () => {
		const ed = createEditorWithTable(null);
		ed.commands.setNodeSelection(0);

		const result = anchorForSelection(ed.state, ed.view.dispatch, "body", () => "tbl2");

		expect(result).toEqual({
			ok: true,
			anchor: { type: "block", field: "body", blockKey: "tbl2" },
			range: { kind: "block", from: 0, to: ed.state.doc.child(0).nodeSize },
		});
		expect(ed.state.doc.child(0).attrs.emdashKey).toBe("tbl2");
	});
});
