/**
 * The editor's normalizers act on this client's own edits, and only on what
 * they changed. A change another client made renders as it is, so receiving
 * it makes this client write nothing.
 */

import { Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { liftTarget } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it } from "vitest";

import { PORTABLE_TEXT_KEY_ATTR } from "../../src/components/editor/portableTextIdentity";
import {
	portableTextExtensions,
	portableTextToProsemirror,
} from "../../src/internal/portable-text";
import { PortableTextFilledDefaults } from "../../src/portable-text/schema";
import { PortableTextYSync } from "../../src/portable-text/y-sync";

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

function createEditor(...content: JSONContent[]): Editor {
	const editor = new Editor({
		extensions: [...portableTextExtensions(), PortableTextFilledDefaults, PortableTextYSync],
		content: { type: "doc", content },
	});
	editors.push(editor);
	return editor;
}

const text = (value: string): JSONContent => ({ type: "text", text: value });
const p = (value?: string): JSONContent => ({
	type: "paragraph",
	...(value ? { content: [text(value)] } : {}),
});
/** A paragraph with a block key, as every block opened from saved content has. */
const keyed = (key: string, value: string): JSONContent => ({
	type: "paragraph",
	attrs: { [PORTABLE_TEXT_KEY_ATTR]: key },
	content: [text(value)],
});
const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
const ul = (...content: JSONContent[]): JSONContent => ({ type: "bulletList", content });
const ol = (attrs: Record<string, unknown>, ...content: JSONContent[]): JSONContent => ({
	type: "orderedList",
	attrs,
	content,
});
const quote = (...content: JSONContent[]): JSONContent => ({ type: "blockquote", content });
const td = (...content: JSONContent[]): JSONContent => ({ type: "tableCell", content });
const tr = (...content: JSONContent[]): JSONContent => ({ type: "tableRow", content });
const table = (...content: JSONContent[]): JSONContent => ({ type: "table", content });
const heading = (value: string): JSONContent => ({
	type: "heading",
	attrs: { level: 2 },
	content: [text(value)],
});

/** Applies `change` as this client's edit, or as another client's when `remote`. */
function apply(editor: Editor, change: (tr: Transaction) => void, { remote = false } = {}) {
	const transaction = editor.state.tr;
	change(transaction);
	if (remote) transaction.setMeta(ySyncPluginKey, { isChangeOrigin: true });
	editor.view.dispatch(transaction);
	return transaction.doc;
}

/** The position of the first node `matches` accepts. */
function find(editor: Editor, matches: (node: ProseMirrorNode) => boolean): number {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found === -1 && matches(node)) found = pos;
		return found === -1;
	});
	expect(found).toBeGreaterThan(-1);
	return found;
}
const textblock = (editor: Editor, value: string) =>
	find(editor, (node) => node.isTextblock && node.textContent === value);
const nodeOf = (editor: Editor, pos: number) => editor.state.doc.nodeAt(pos)!;

/** The document with only the content that matters here: types, text, and these attributes. */
function outline(node: ProseMirrorNode, attrs: string[] = []): string {
	if (node.isText) return JSON.stringify(node.text);
	const shown = attrs
		.filter((name) => node.attrs[name] !== undefined && node.attrs[name] !== null)
		.map((name) => `${name}=${JSON.stringify(node.attrs[name])}`);
	const head = shown.length > 0 ? `${node.type.name}{${shown.join(" ")}}` : node.type.name;
	const children: string[] = [];
	node.forEach((child) => children.push(outline(child, attrs)));
	return children.length > 0 ? `${head}(${children.join(", ")})` : head;
}

describe("local-only normalizers", () => {
	it("adds the trailing paragraph only when this client's edit changes the last block", () => {
		const remote = createEditor(p("a"));
		const addHeading = (t: Transaction) =>
			t.insert(t.doc.content.size, remote.schema.nodeFromJSON(heading("b")));
		const rendered = apply(remote, addHeading, { remote: true });
		expect(remote.state.doc.eq(rendered)).toBe(true);

		apply(remote, (t) => t.insertText("!", textblock(remote, "a") + 2));
		expect(remote.state.doc.lastChild?.type.name).toBe("heading");

		apply(remote, (t) => t.insertText("!", textblock(remote, "b") + 2));
		expect(remote.state.doc.lastChild?.type.name).toBe("paragraph");

		const local = createEditor(p("a"));
		apply(local, (t) => t.insert(t.doc.content.size, local.schema.nodeFromJSON(heading("b"))));
		expect(outline(local.state.doc)).toBe('doc(paragraph("a"), heading("b"), paragraph)');
	});

	it("links a typed address only when this client typed it", () => {
		const isLinked = (editor: Editor) =>
			editor.state.doc.rangeHasMark(0, editor.state.doc.content.size, editor.schema.marks.link!);

		const remote = createEditor(p("see"));
		apply(remote, (t) => t.insertText(" www.example.com ", textblock(remote, "see") + 4), {
			remote: true,
		});
		expect(isLinked(remote)).toBe(false);

		const local = createEditor(p("see"));
		apply(local, (t) => t.insertText(" www.example.com ", textblock(local, "see") + 4));
		expect(isLinked(local)).toBe(true);
	});

	it("adds the cells a table is missing only after this client's edit", () => {
		const grid = () => createEditor(table(tr(td(p("A")), td(p("B"))), tr(td(p("C")), td(p("D")))));
		const addCell = (editor: Editor) => (t: Transaction) =>
			t.insert(textblock(editor, "B") + 4, editor.schema.nodeFromJSON(td(p("E"))));
		const rowLengths = (editor: Editor) => {
			const lengths: number[] = [];
			editor.state.doc.firstChild!.forEach((row) => lengths.push(row.childCount));
			return lengths;
		};

		const remote = grid();
		const rendered = apply(remote, addCell(remote), { remote: true });
		expect(remote.state.doc.eq(rendered)).toBe(true);
		expect(rowLengths(remote)).toEqual([3, 2]);

		const local = grid();
		apply(local, addCell(local));
		expect(rowLengths(local)).toEqual([3, 3]);
	});

	it("keys a table only when this client added it", () => {
		const keys = (editor: Editor) => {
			const found: unknown[] = [];
			editor.state.doc.descendants((node) => {
				if (node.type.spec.tableRole) found.push(node.attrs.emdashKey);
			});
			return found;
		};
		const addTable = (editor: Editor) => (t: Transaction) =>
			t.insert(0, editor.schema.nodeFromJSON(table(tr(td(p("A"))))));

		const remote = createEditor(p("a"));
		apply(remote, addTable(remote), { remote: true });
		expect(keys(remote)).toEqual([null, null, null]);

		const local = createEditor(p("a"));
		apply(local, addTable(local));
		expect(keys(local).every((key) => typeof key === "string" && key.length > 0)).toBe(true);
	});

	describe("table keys", () => {
		const keyedTable = (key: string, ...content: JSONContent[]): JSONContent => ({
			type: "table",
			attrs: { emdashKey: key },
			content,
		});
		const keyedRow = (key: string, ...content: JSONContent[]): JSONContent => ({
			type: "tableRow",
			attrs: { emdashKey: key },
			content,
		});
		const keyedCell = (key: string, value: string): JSONContent => ({
			type: "tableCell",
			attrs: { emdashKey: key },
			content: [p(value)],
		});
		const tableKeys = (tableNode: ProseMirrorNode) => {
			const keys: unknown[] = [tableNode.attrs.emdashKey];
			tableNode.descendants((node) => {
				if (node.type.spec.tableRole) keys.push(node.attrs.emdashKey);
			});
			return keys;
		};
		const tables = (editor: Editor) => {
			const found: ProseMirrorNode[] = [];
			editor.state.doc.forEach((node) => {
				if (node.type.name === "table") found.push(node);
			});
			return found;
		};

		it("leaves the keys of tables this client's edit didn't change", () => {
			const editor = createEditor(
				keyedTable("shared", keyedRow("row", keyedCell("cell", "Edited"))),
				table(tr(td(p("Unkeyed")))),
				keyedTable("shared", keyedRow("r", keyedCell("c", "A"), keyedCell("c", "B"))),
			);
			const untouched = tables(editor).slice(1).map(tableKeys);

			apply(editor, (t) =>
				t.insert(
					editor.state.doc.firstChild!.nodeSize - 1,
					editor.schema.nodeFromJSON(tr(td(p("New")))),
				),
			);

			const [edited, ...others] = tables(editor);
			expect(others.map(tableKeys)).toEqual(untouched);
			const keys = tableKeys(edited!);
			expect(keys.slice(1, 3)).toEqual(["row", "cell"]);
			expect(keys[0]).not.toBe("shared");
			expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
			expect(new Set(keys).size).toBe(keys.length);
		});

		it("gives a pasted copy of a table a key of its own", () => {
			const original = keyedTable("table", keyedRow("row", keyedCell("cell", "A")));
			const editor = createEditor(original, p("after"));

			apply(editor, (t) => t.insert(t.doc.content.size, editor.schema.nodeFromJSON(original)));

			const [kept, copy] = tables(editor);
			expect(tableKeys(kept!)).toEqual(["table", "row", "cell"]);
			expect(copy!.attrs.emdashKey).toEqual(expect.any(String));
			expect(copy!.attrs.emdashKey).not.toBe("table");
		});
	});

	it("keys a block only when this client added it", () => {
		const addBlock = (editor: Editor) => (t: Transaction) =>
			t.insert(0, editor.schema.nodeFromJSON(p("new")));

		const remote = createEditor(p("a"));
		apply(remote, addBlock(remote), { remote: true });
		expect(remote.state.doc.firstChild!.attrs.emdashPortableTextKey).toBeNull();

		const local = createEditor(p("a"));
		apply(local, addBlock(local));
		expect(local.state.doc.firstChild!.attrs.emdashPortableTextKey).toEqual(expect.any(String));
	});

	describe("numbered lists", () => {
		const attrs = ["listId", "listStart", "start"];
		const twoSegments = () =>
			createEditor(
				ol({ listId: "a", listStart: 1, start: 1 }, li(p("x"))),
				p("between"),
				ol({ listId: "a", listStart: 1, start: 2 }, li(p("y"))),
			);
		const addItem = (editor: Editor) => (t: Transaction) =>
			t.insert(textblock(editor, "x") + 4, editor.schema.nodeFromJSON(li(p("x2"))));
		const removeBetween = (editor: Editor) => (t: Transaction) => {
			const pos = textblock(editor, "between");
			t.delete(pos, pos + nodeOf(editor, pos).nodeSize);
		};

		it("renumbers only after this client's edit", () => {
			const remote = twoSegments();
			apply(remote, addItem(remote), { remote: true });
			expect(
				nodeOf(
					remote,
					find(remote, (node) => node.textContent === "y"),
				).attrs.start,
			).toBe(2);

			const local = twoSegments();
			apply(local, addItem(local));
			expect(
				nodeOf(
					local,
					find(local, (node) => node.textContent === "y"),
				).attrs.start,
			).toBe(3);
		});

		it("joins segments only where this client's edit made them meet", () => {
			const remote = twoSegments();
			apply(remote, removeBetween(remote), { remote: true });
			expect(remote.state.doc.childCount).toBe(2);

			apply(remote, (t) => t.insertText("!", textblock(remote, "x") + 2));
			expect(outline(remote.state.doc, attrs)).toBe(
				'doc(orderedList{listId="a" listStart=1 start=1}(listItem(paragraph("x!"))), orderedList{listId="a" listStart=1 start=2}(listItem(paragraph("y"))))',
			);

			const local = twoSegments();
			apply(local, removeBetween(local));
			expect(outline(local.state.doc, attrs)).toBe(
				'doc(orderedList{listId="a" listStart=1 start=1}(listItem(paragraph("x")), listItem(paragraph("y"))), paragraph)',
			);
		});

		it("renumbers only the lists that share an id with a list the edit changed", () => {
			const editor = createEditor(
				ol({ listId: "a", listStart: 1, start: 1 }, li(p("x"))),
				p("between"),
				ol({ listId: "a", listStart: 1, start: 5 }, li(p("y"))),
				p("other"),
				ol({ listId: "b", listStart: 1, start: 1 }, li(p("z"))),
			);
			const startOf = (value: string) =>
				nodeOf(
					editor,
					find(editor, (node) => node.type.name === "orderedList" && node.textContent === value),
				).attrs.start;

			apply(editor, (t) => t.insertText("!", textblock(editor, "z") + 2));
			expect(startOf("y")).toBe(5);

			apply(editor, (t) => t.insertText("!", textblock(editor, "x") + 2));
			expect(startOf("y")).toBe(2);
		});
	});

	it("keeps a document another client emptied while all its text was selected", () => {
		const emptyQuote = (editor: Editor) => {
			editor.view.dispatch(
				editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 3)),
			);
			return (t: Transaction) => t.delete(2, 3);
		};

		const remote = createEditor(quote(p("q")));
		apply(remote, emptyQuote(remote), { remote: true });
		expect(outline(remote.state.doc)).toBe("doc(blockquote(paragraph))");

		const local = createEditor(quote(p("q")));
		apply(local, emptyQuote(local));
		expect(outline(local.state.doc)).toBe("doc(paragraph, paragraph)");
	});
});

describe("shapes", () => {
	const deleteNode = (editor: Editor, pos: number) => (t: Transaction) =>
		t.delete(pos, pos + nodeOf(editor, pos).nodeSize);

	const cases: Array<{
		action: "refills" | "removes";
		name: string;
		content: JSONContent[];
		at: (editor: Editor) => number;
		local: string;
		remote: string;
	}> = [
		{
			action: "refills",
			name: "a list item without its leading paragraph",
			content: [ul(li(p("a"), ul(li(p("b"))))), p("end")],
			at: (editor) => textblock(editor, "a"),
			local:
				'doc(bulletList(listItem(paragraph, bulletList(listItem(paragraph("b"))))), paragraph("end"))',
			remote: 'doc(bulletList(listItem(bulletList(listItem(paragraph("b"))))), paragraph("end"))',
		},
		{
			action: "removes",
			name: "an empty list item",
			content: [ul(li(p("a")), li(p("b"))), p("end")],
			at: (editor) => textblock(editor, "b"),
			local: 'doc(bulletList(listItem(paragraph("a"))), paragraph("end"))',
			remote: 'doc(bulletList(listItem(paragraph("a")), listItem), paragraph("end"))',
		},
		{
			action: "removes",
			name: "an empty list",
			content: [p("a"), ul(li(p("b"))), p("end")],
			at: (editor) => find(editor, (node) => node.type.name === "listItem"),
			local: 'doc(paragraph("a"), paragraph("end"))',
			remote: 'doc(paragraph("a"), bulletList, paragraph("end"))',
		},
		{
			action: "removes",
			name: "an empty quote",
			content: [p("a"), quote(p("q")), p("end")],
			at: (editor) => textblock(editor, "q"),
			local: 'doc(paragraph("a"), paragraph("end"))',
			remote: 'doc(paragraph("a"), blockquote, paragraph("end"))',
		},
		{
			action: "refills",
			name: "an empty cell",
			content: [table(tr(td(p("A")), td(p("B")))), p("end")],
			at: (editor) => textblock(editor, "A"),
			local:
				'doc(table(tableRow(tableCell(paragraph), tableCell(paragraph("B")))), paragraph("end"))',
			remote: 'doc(table(tableRow(tableCell, tableCell(paragraph("B")))), paragraph("end"))',
		},
	];

	for (const { action, name, content, at, local, remote } of cases) {
		it(`${action} ${name} that this client's edit left`, () => {
			const editor = createEditor(...content);
			apply(editor, deleteNode(editor, at(editor)));
			expect(outline(editor.state.doc)).toBe(local);
		});

		it(`leaves ${name} that another client's edit left`, () => {
			const editor = createEditor(...content);
			const rendered = apply(editor, deleteNode(editor, at(editor)), { remote: true });
			expect(editor.state.doc.eq(rendered)).toBe(true);
			expect(outline(editor.state.doc)).toBe(remote);
		});
	}

	it("refills an empty list that this client's edit added", () => {
		const editor = createEditor(p("a"), p("end"));
		apply(editor, (t) =>
			t.insert(textblock(editor, "end"), editor.schema.nodes.bulletList!.create()),
		);
		expect(outline(editor.state.doc)).toBe(
			'doc(paragraph("a"), bulletList(listItem(paragraph)), paragraph("end"))',
		);
	});

	it("moves up a nested list whose first line this client's edit cut into from the item's start", () => {
		const content = [ul(li(p("a"), ul(li(p("bc"))))), p("end")];
		const cut = (editor: Editor) => (t: Transaction) =>
			t.delete(textblock(editor, "a"), textblock(editor, "bc") + 2);

		const local = createEditor(...content);
		apply(local, cut(local));
		expect(outline(local.state.doc)).toBe(
			'doc(bulletList(listItem(paragraph("c"))), paragraph("end"))',
		);

		const remote = createEditor(...content);
		const rendered = apply(remote, cut(remote), { remote: true });
		expect(remote.state.doc.eq(rendered)).toBe(true);
		expect(outline(remote.state.doc)).toBe(
			'doc(bulletList(listItem(bulletList(listItem(paragraph("c"))))), paragraph("end"))',
		);
	});

	it("moves up only the nested line this client's edit cut into from the item's start", () => {
		const editor = createEditor(
			ul(li(p("Item A"), ul(li(p("Sub one")), li(p("Sub two")))), li(p("Item B"))),
			p("end"),
		);
		editor
			.chain()
			.setTextSelection({
				from: textblock(editor, "Item A") + 1,
				to: textblock(editor, "Sub one") + 5,
			})
			.deleteSelection()
			.run();
		expect(outline(editor.state.doc)).toBe(
			'doc(bulletList(listItem(paragraph("one"), bulletList(listItem(paragraph("Sub two")))), listItem(paragraph("Item B"))), paragraph("end"))',
		);

		const deeper = createEditor(
			ul(li(p("aa"), ul(li(p("bb"), ul(li(p("cc")))), li(p("dd")))), li(p("ee"))),
			p("end"),
		);
		deeper
			.chain()
			.setTextSelection({ from: textblock(deeper, "aa") + 1, to: textblock(deeper, "bb") + 2 })
			.deleteSelection()
			.run();
		expect(outline(deeper.state.doc)).toBe(
			'doc(bulletList(listItem(paragraph("b"), bulletList(listItem(paragraph("cc")), listItem(paragraph("dd")))), listItem(paragraph("ee"))), paragraph("end"))',
		);

		const nextStartsNested = createEditor(
			ul(li(p("a"), ul(li(p("bc")))), li(ul(li(p("x"))))),
			p("end"),
		);
		nextStartsNested
			.chain()
			.setTextSelection({
				from: textblock(nextStartsNested, "a") + 1,
				to: textblock(nextStartsNested, "bc") + 2,
			})
			.deleteSelection()
			.run();
		expect(outline(nextStartsNested.state.doc)).toBe(
			'doc(bulletList(listItem(paragraph("c")), listItem(bulletList(listItem(paragraph("x"))))), paragraph("end"))',
		);
	});

	it("moves up a nested line this client's edit cut to its end", () => {
		const toEnd = createEditor(
			ul(li(p("Item A"), ul(li(p("Sub one")), li(p("Sub two"))))),
			p("end"),
		);
		toEnd
			.chain()
			.setTextSelection({
				from: textblock(toEnd, "Item A") + 1,
				to: textblock(toEnd, "Sub one") + 8,
			})
			.deleteSelection()
			.run();
		expect(outline(toEnd.state.doc)).toBe(
			'doc(bulletList(listItem(paragraph, bulletList(listItem(paragraph("Sub two"))))), paragraph("end"))',
		);
	});

	it("moves up a nested line this client's edit reached through deeper levels", () => {
		const throughDeeper = createEditor(
			ul(li(p("Item A"), ul(li(p("Sub one"), ul(li(p("Deep one")))), li(p("Sub two"))))),
			p("end"),
		);
		throughDeeper
			.chain()
			.setTextSelection({
				from: textblock(throughDeeper, "Item A") + 1,
				to: textblock(throughDeeper, "Deep one") + 6,
			})
			.deleteSelection()
			.run();
		expect(outline(throughDeeper.state.doc)).toBe(
			'doc(bulletList(listItem(paragraph("one"), bulletList(listItem(paragraph("Sub two"))))), paragraph("end"))',
		);
	});

	it("leaves what undo restores as it was", () => {
		const editor = createEditor(
			keyed("k1", "before"),
			ul(li(ul(li(keyed("k2", "nested first")))), li(keyed("k3", "top"))),
			keyed("k4", "after"),
		);
		const opened = editor.state.doc;
		apply(editor, (t) => t.insertText("!", textblock(editor, "after") + 6));
		editor.view.dispatch(closeHistory(editor.state.tr));
		const typed = editor.state.doc;
		editor
			.chain()
			.setTextSelection({
				from: textblock(editor, "before") + 4,
				to: textblock(editor, "after!") + 1,
			})
			.deleteSelection()
			.run();
		editor.view.dispatch(closeHistory(editor.state.tr));

		editor.commands.undo();
		expect(editor.state.doc.eq(typed)).toBe(true);
		editor.commands.undo();
		expect(editor.state.doc.eq(opened)).toBe(true);
	});

	it("leaves a list item that started with a nested list where this client's edit moves it", () => {
		const editor = createEditor(
			keyed("k1", "before"),
			ul(li(ul(li(keyed("k2", "a")))), li(keyed("k3", "b"))),
			keyed("k4", "after"),
		);
		const list = find(editor, (node) => node.type.name === "bulletList");
		const node = nodeOf(editor, list);
		apply(editor, (t) => {
			t.delete(list, list + node.nodeSize);
			t.insert(0, node);
		});
		expect(outline(editor.state.doc)).toBe(
			'doc(bulletList(listItem(bulletList(listItem(paragraph("a")))), listItem(paragraph("b"))), paragraph("before"), paragraph("after"))',
		);
	});

	it("doesn't lift the paragraph a list item starts with out of it when this client does", () => {
		const content = [p("before"), ul(li(p("a"), ul(li(p("b"))))), p("end")];
		const liftFirstLine = (editor: Editor) => (t: Transaction) => {
			const $line = t.doc.resolve(textblock(editor, "a") + 1);
			const range = $line.blockRange()!;
			t.lift(range, liftTarget(range)!);
		};

		const local = createEditor(...content);
		const before = local.state.doc;
		apply(local, liftFirstLine(local));
		expect(local.state.doc.eq(before)).toBe(true);

		const remote = createEditor(...content);
		apply(remote, liftFirstLine(remote), { remote: true });
		expect(outline(remote.state.doc)).toBe(
			'doc(paragraph("before"), paragraph("a"), bulletList(listItem(bulletList(listItem(paragraph("b"))))), paragraph("end"))',
		);

		const twoLines = createEditor(p("before"), ul(li(p("a"), p("a2"), ul(li(p("b"))))), p("end"));
		apply(twoLines, liftFirstLine(twoLines));
		expect(outline(twoLines.state.doc)).toBe(
			'doc(paragraph("before"), paragraph("a"), bulletList(listItem(paragraph("a2"), bulletList(listItem(paragraph("b"))))), paragraph("end"))',
		);
	});

	it("leaves a list item that already started with a nested list", () => {
		const editor = createEditor(ul(li(ul(li(p("a"))), p("b"))), p("after"));
		apply(editor, (t) => t.insertText("!", textblock(editor, "a") + 2));
		apply(editor, (t) => t.insertText("!", textblock(editor, "b") + 2));
		expect(outline(editor.state.doc)).toBe(
			'doc(bulletList(listItem(bulletList(listItem(paragraph("a!"))), paragraph("b!"))), paragraph("after"))',
		);
	});

	describe("line breaks", () => {
		const bold = [{ type: "bold" }];
		const lines = () =>
			createEditor(
				{ type: "paragraph", content: [text("a"), { type: "hardBreak", marks: bold }, text("b")] },
				{ type: "paragraph", content: [text("c"), { type: "hardBreak" }, text("d")] },
			);
		const breakMarks = (editor: Editor) => {
			const marks: string[][] = [];
			editor.state.doc.descendants((node) => {
				if (node.type.name === "hardBreak") marks.push(node.marks.map((mark) => mark.type.name));
			});
			return marks;
		};
		const boldSecond = (editor: Editor) => (t: Transaction) => {
			const pos = find(editor, (node) => node.isTextblock && node.textContent.startsWith("c"));
			t.addMark(pos + 1, pos + 4, editor.schema.marks.bold!.create());
		};

		it("lose the marks this client's edit gives them", () => {
			const editor = lines();
			apply(editor, boldSecond(editor));
			expect(breakMarks(editor)).toEqual([["bold"], []]);
		});

		it("keep the marks another client's edit gives them", () => {
			const editor = lines();
			apply(editor, boldSecond(editor), { remote: true });
			expect(breakMarks(editor)).toEqual([["bold"], ["bold"]]);
		});
	});

	it("renders a table with no rows", () => {
		const editor = createEditor(p("a"), table());
		expect(editor.getHTML()).toContain("<table");
	});
});

describe("opening a document", () => {
	it("keeps the empty paragraph the editor adds after a final block", () => {
		const doc = portableTextToProsemirror([
			{
				_type: "block",
				_key: "k",
				style: "normal",
				listItem: "bullet",
				level: 1,
				children: [{ _type: "span", _key: "s", text: "Item" }],
			},
		]);
		expect(doc.content.at(-1)).toEqual({ type: "paragraph" });

		const editor = createEditor(...(doc.content as JSONContent[]));
		const opened = editor.state.doc;
		editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(opened, 3)));
		expect(editor.state.doc.eq(opened)).toBe(true);
		expect(editor.state.doc.childCount).toBe(2);
	});
});
