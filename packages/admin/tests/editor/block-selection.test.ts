/**
 * Keyboard block selection and scoped Select All.
 *
 * Escape selects the block holding the caret, the arrow keys then move
 * between blocks, typing can't replace the selected block, and Enter goes
 * back to writing. Select All selects just the text of the block holding the
 * caret first.
 */

import { Editor } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	BlockSelectAll,
	BlockSelection,
	DoubleClickLineEnd,
	SelectionHighlights,
	focusDocumentStart,
} from "../../src/components/editor/BlockCommands";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

let editor: Editor;
let element: HTMLDivElement;

function create(content: string, onArrowUpAtStart: (() => boolean) | null = null) {
	element = document.createElement("div");
	document.body.append(element);
	editor = new Editor({
		element,
		extensions: [
			StarterKit,
			BlockSelection.configure({ onArrowUpAtStart }),
			BlockSelectAll,
			DoubleClickLineEnd,
			SelectionHighlights,
		],
		content,
	});
}

function press(key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	editor.view.dom.dispatchEvent(event);
	return event;
}

function caretIn(text: string) {
	let pos = -1;
	editor.state.doc.descendants((node, nodePos) => {
		if (pos === -1 && node.isTextblock && node.textContent === text) pos = nodePos + 1;
	});
	editor.commands.setTextSelection(pos);
}

function selectedBlockText() {
	const { selection } = editor.state;
	return selection instanceof NodeSelection ? selection.node.textContent : null;
}

afterEach(() => {
	editor.destroy();
	element.remove();
});

describe("Block selection", () => {
	it("selects the block holding the caret on Escape", () => {
		create("<p>one</p><p>two</p><p>three</p>");
		caretIn("two");

		expect(press("Escape").defaultPrevented).toBe(true);

		expect(selectedBlockText()).toBe("two");
	});

	it("moves the selection between blocks with the arrow keys", () => {
		create("<p>one</p><p>two</p><p>three</p>");
		caretIn("two");
		press("Escape");

		press("ArrowDown");
		expect(selectedBlockText()).toBe("three");

		press("ArrowUp");
		press("ArrowUp");
		expect(selectedBlockText()).toBe("one");
	});

	it("doesn't let typing or dictation replace a selected block", async () => {
		create("<p>one</p><p>two</p>");
		caretIn("two");
		editor.view.focus();
		press("Escape");
		const before = editor.getJSON();

		await userEvent.keyboard("x");
		const dictation = new InputEvent("beforeinput", {
			inputType: "insertText",
			data: "y",
			bubbles: true,
			cancelable: true,
		});
		editor.view.dom.dispatchEvent(dictation);

		expect(dictation.defaultPrevented).toBe(true);
		expect(editor.getJSON()).toEqual(before);
		expect(selectedBlockText()).toBe("two");
	});

	it("pastes after a selected block instead of replacing it", () => {
		create("<p>one</p><p>two</p>");
		caretIn("one");
		press("Escape");

		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: {
				types: ["text/plain"],
				getData: (type: string) => (type === "text/plain" ? "pasted" : ""),
			},
		});
		editor.view.dom.dispatchEvent(paste);

		expect(editor.getHTML()).toBe("<p>one</p><p>pasted</p><p>two</p>");
	});

	it("doesn't let typing replace a clicked divider", async () => {
		create("<p>one</p><hr><p>two</p>");
		editor.commands.setNodeSelection(5);
		editor.view.focus();

		await userEvent.keyboard("x");

		expect(editor.getHTML()).toBe("<p>one</p><hr><p>two</p>");
	});

	it("doesn't let typing replace a block selected without block selection", async () => {
		create("<blockquote><p>quote</p></blockquote><p>two</p>");
		editor.commands.setNodeSelection(0);
		editor.view.focus();
		const before = editor.getJSON();

		await userEvent.keyboard("x");

		expect(editor.getJSON()).toEqual(before);
	});

	it("selects a divider with Backspace from the start of the block after it", () => {
		create("<p>one</p><hr><p>two</p>");
		caretIn("two");

		press("Backspace");

		expect((editor.state.selection as NodeSelection).node?.type.name).toBe("horizontalRule");
		expect(editor.getHTML()).toBe("<p>one</p><hr><p>two</p>");
	});

	it("selects a divider with Delete from the end of the block before it", () => {
		create("<p>one</p><hr><p>two</p>");
		editor.commands.setTextSelection(4);

		press("Delete");

		expect((editor.state.selection as NodeSelection).node?.type.name).toBe("horizontalRule");
		expect(editor.getHTML()).toBe("<p>one</p><hr><p>two</p>");
	});

	it("leaves the caret before a deleted block instead of selecting the next one", () => {
		create("<p>one</p><hr><hr><p>two</p>");
		editor.commands.setNodeSelection(5);

		press("Backspace");

		expect(editor.getHTML()).toBe("<p>one</p><hr><p>two</p>");
		expect(editor.state.selection).toBeInstanceOf(TextSelection);
		expect(editor.state.selection.$from.parent.textContent).toBe("one");
	});

	it("keeps the caret in the block Backspace came from when it deletes the block before", () => {
		create("<p>xy</p><hr><p>z</p>");
		caretIn("z");

		press("Backspace");
		press("Backspace");

		expect(editor.getHTML()).toBe("<p>xy</p><p>z</p>");
		expect(editor.state.selection.$from.parent.textContent).toBe("z");
		expect(editor.state.selection.$from.parentOffset).toBe(0);
	});

	it("keeps the caret where it was when the editor itself selected the block it deletes", () => {
		create("<ul><li><p>a</p></li></ul><hr><p>z</p>");
		editor.commands.setTextSelection(4);

		press("Delete");
		press("Delete");

		expect(editor.getHTML()).toBe("<ul><li><p>a</p></li></ul><p>z</p>");
		expect(editor.state.selection.$from.parent.textContent).toBe("a");
		expect(editor.state.selection.$from.parentOffset).toBe(1);
	});

	it("leaves the caret where it was on a click between two dividers", async () => {
		create("<p>one</p><hr><hr><p>two</p>");
		editor.view.focus();
		caretIn("one");
		const before = editor.state.selection.from;
		const [first, second] = editor.view.dom.querySelectorAll("hr");
		const top = first!.getBoundingClientRect().bottom;
		const bottom = second!.getBoundingClientRect().top;
		const box = editor.view.dom.getBoundingClientRect();
		expect(bottom - top).toBeGreaterThan(2);

		await userEvent.click(editor.view.dom, {
			position: { x: 20, y: (top + bottom) / 2 - box.top },
		});

		expect(editor.state.selection).not.toBeInstanceOf(GapCursor);
		expect(editor.state.selection.from).toBe(before);
	});

	it("goes back to writing at the end of the block on Enter", () => {
		create("<p>one</p><p>two</p>");
		caretIn("two");
		press("Escape");
		const before = editor.getJSON();

		press("Enter");

		const { selection } = editor.state;
		expect(selection).toBeInstanceOf(TextSelection);
		expect(selection.empty).toBe(true);
		expect(selection.$from.parent.textContent).toBe("two");
		expect(selection.$from.parentOffset).toBe(3);
		expect(editor.getJSON()).toEqual(before);
	});

	it("hands ArrowUp on the first line to the field above", () => {
		const onArrowUpAtStart = vi.fn(() => true);
		create("<p>one</p><p>two</p>", onArrowUpAtStart);
		editor.commands.setTextSelection(1);

		expect(press("ArrowUp").defaultPrevented).toBe(true);
		expect(onArrowUpAtStart).toHaveBeenCalledOnce();
	});
});

describe("Select All", () => {
	const selectAll = () => press("a", isMac ? { metaKey: true } : { ctrlKey: true });

	it.each([
		["a paragraph", "<p>intro</p><p>text</p><p>outro</p>"],
		["a heading", "<p>intro</p><h2>text</h2><p>outro</p>"],
		["a list item", "<ul><li><p>intro</p></li><li><p>text</p></li></ul><p>outro</p>"],
		["a quote", "<blockquote><p>intro</p><p>text</p></blockquote><p>outro</p>"],
		["a code block", "<p>intro</p><pre><code>text</code></pre><p>outro</p>"],
	])("selects the text of %s before the document", (_, content) => {
		create(content);
		caretIn("text");

		selectAll();
		const { selection } = editor.state;
		expect(selection).toBeInstanceOf(TextSelection);
		expect(editor.state.doc.textBetween(selection.from, selection.to)).toBe("text");

		selectAll();
		expect(editor.state.selection).toBeInstanceOf(AllSelection);
	});

	it("selects the whole document from an empty block", () => {
		create("<p>intro</p><p></p><p>outro</p>");
		editor.commands.setTextSelection(8);

		selectAll();

		expect(editor.state.selection).toBeInstanceOf(AllSelection);
	});

	it("selects the whole document from a selected block", () => {
		create("<p>intro</p><p>text</p>");
		caretIn("text");
		press("Escape");

		selectAll();

		expect(editor.state.selection).toBeInstanceOf(AllSelection);
	});
});

describe("Double-click at a line end", () => {
	/** A double-click that left the browser's word selection over `from`–`to`. */
	function doubleClickSelecting(from: number, to: number) {
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
		);
		editor.view.dom.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	}

	it.each([
		["the break into the next block", "<p>one</p><h2>two</h2>", 4, 6],
		["a line break", "<p>one<br>two</p>", 4, 5],
		["a newline in code", "<pre><code>one\ntwo</code></pre>", 4, 5],
	])("leaves a caret at the line end instead of selecting %s", async (_name, content, from, to) => {
		create(content);
		doubleClickSelecting(from, to);

		await vi.waitFor(() => expect(editor.state.selection.empty).toBe(true));
		expect(editor.state.selection.from).toBe(from);
	});

	it("selects the word when the double click lands on its last letter", async () => {
		create("<p>one two</p><p>next</p>");
		const end = editor.view.coordsAtPos(8, -1);
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8, 10)),
		);
		editor.view.dom.dispatchEvent(
			new MouseEvent("dblclick", {
				bubbles: true,
				clientX: end.left - 1,
				clientY: (end.top + end.bottom) / 2,
			}),
		);

		await vi.waitFor(() => expect(editor.state.selection).toMatchObject({ from: 5, to: 8 }));
	});

	it("leaves the caret on the empty line a double click lands on after a line break", async () => {
		create("<p>one<br>two<br></p><p>next</p>");
		const emptyLine = editor.view.coordsAtPos(9);
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8, 9)),
		);
		editor.view.dom.dispatchEvent(
			new MouseEvent("dblclick", {
				bubbles: true,
				clientX: emptyLine.left + 5,
				clientY: (emptyLine.top + emptyLine.bottom) / 2,
			}),
		);

		await vi.waitFor(() => expect(editor.state.selection).toMatchObject({ from: 9, to: 9 }));
	});

	it("keeps a double-clicked word selected", async () => {
		create("<p>one two</p>");
		doubleClickSelecting(5, 8);

		await new Promise((resolve) => setTimeout(resolve));
		expect(editor.state.selection).toMatchObject({ from: 5, to: 8 });
	});
});

describe("Selection highlights", () => {
	const lineBreakMarkers = () => editor.view.dom.querySelectorAll(".emdash-selected-line-break");

	it("marks a selected line break", () => {
		create("<p>one</p><p>two</p>");

		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4, 6)),
		);

		expect(lineBreakMarkers()).toHaveLength(1);
	});

	it("doesn't mark a line break beside selected text", () => {
		create("<p>one</p><p>two</p>");

		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 7)),
		);

		expect(lineBreakMarkers()).toHaveLength(0);
	});

	it("doesn't mark the line break a double click selects before it's collapsed", async () => {
		create("<p>one</p><p>two</p>");

		editor.view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 2 }));
		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 4, 6)),
		);
		expect(lineBreakMarkers()).toHaveLength(0);

		editor.view.dom.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		await vi.waitFor(() => expect(editor.state.selection.empty).toBe(true));
		expect(lineBreakMarkers()).toHaveLength(0);
	});

	it("tints a divider inside a selection", () => {
		create("<p>one</p><hr><p>two</p>");

		editor.view.dispatch(
			editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 8)),
		);

		expect(editor.view.dom.querySelector("hr")?.classList.contains("emdash-in-selection")).toBe(
			true,
		);
	});
});

describe("focusDocumentStart", () => {
	it("puts the caret above a leading divider instead of selecting it", () => {
		create("<hr><p>after</p>");

		focusDocumentStart(editor);

		expect(editor.state.selection).toBeInstanceOf(GapCursor);
		expect(editor.state.selection.from).toBe(0);
	});

	it("puts the caret at the start of a leading paragraph", () => {
		create("<p>first</p>");

		focusDocumentStart(editor);

		expect(editor.state.selection).toBeInstanceOf(TextSelection);
		expect(editor.state.selection.from).toBe(1);
	});
});
