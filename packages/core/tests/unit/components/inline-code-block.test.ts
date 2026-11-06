// @vitest-environment jsdom

import { Editor, type Content } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InlineCodeBlockExtension } from "../../../src/components/inline-code-block.js";

type Selection = number | { from: number; to: number };
const tabEventInit = { key: "Tab", bubbles: true, cancelable: true };
let editor: Editor;
function pressSelectAll() {
	const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
	const event = new KeyboardEvent("keydown", {
		key: "a",
		bubbles: true,
		cancelable: true,
		metaKey: isMac,
		ctrlKey: !isMac,
	});
	editor.view.dom.dispatchEvent(event);
	return event;
}
function pressTab(shiftKey = false) {
	const event = new KeyboardEvent("keydown", { ...tabEventInit, shiftKey });
	editor.view.dom.dispatchEvent(event);
	return event;
}
function setCode(text: string) {
	editor.commands.setContent({ type: "codeBlock", content: [{ type: "text", text }] });
}
function setCodeDocument(code = "code") {
	editor.commands.setContent({
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "before" }] },
			{ type: "codeBlock", content: [{ type: "text", text: code }] },
			{ type: "paragraph", content: [{ type: "text", text: "after" }] },
		],
	});
	const from = editor.state.doc.child(0).nodeSize + 1;
	return { from, to: from + code.length };
}
function expectTabUnhandled(content: Content, selection: Selection) {
	for (const shiftKey of [false, true]) {
		editor.commands.setContent(content);
		editor.commands.setTextSelection(selection);
		const before = editor.state.doc.toJSON();
		const selected = editor.state.selection.toJSON();
		expect(pressTab(shiftKey).defaultPrevented).toBe(false);
		expect(editor.state.doc.toJSON()).toEqual(before);
		expect(editor.state.selection.toJSON()).toEqual(selected);
	}
}

describe("InlineCodeBlockExtension", () => {
	beforeEach(() => {
		editor = new Editor({
			extensions: [StarterKit.configure({ codeBlock: false }), InlineCodeBlockExtension],
		});
	});

	afterEach(() => editor.destroy());

	it.each([
		["indentation", false, "code", 3, "co    de"],
		["outdent", true, "      code", 11, "  code"],
	])("handles caret %s as one undoable operation", (_name, shiftKey, before, position, after) => {
		setCode(before);
		editor.view.dispatch(closeHistory(editor.state.tr));
		editor.commands.setTextSelection(position);
		expect(pressTab(shiftKey).defaultPrevented).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe(after);
		expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
		editor.commands.undo();
		expect(editor.state.doc.firstChild?.textContent).toBe(before);
		editor.commands.redo();
		expect(editor.state.doc.firstChild?.textContent).toBe(after);
	});

	it("indents and outdents a multiline selection", () => {
		setCode("one\ntwo");
		editor.commands.setTextSelection({ from: 1, to: 8 });
		expect(pressTab().defaultPrevented).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe("    one\n    two");
		expect(pressTab(true).defaultPrevented).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe("one\ntwo");
	});

	it("leaves paragraph and cross-block selections unhandled", () => {
		expectTabUnhandled({ type: "paragraph", content: [{ type: "text", text: "text" }] }, 2);
		expectTabUnhandled(
			{
				type: "doc",
				content: [
					{ type: "codeBlock", content: [{ type: "text", text: "code" }] },
					{ type: "paragraph", content: [{ type: "text", text: "after" }] },
				],
			},
			{ from: 1, to: 9 },
		);
	});

	it("keeps repeated Select All and deletion inside the active code block", () => {
		const range = setCodeDocument("one\ntwo");
		editor.commands.setTextSelection(range.from + 2);

		expect(pressSelectAll().defaultPrevented).toBe(true);
		expect(editor.state.selection.toJSON()).toEqual({
			type: "text",
			anchor: range.from,
			head: range.to,
		});
		const selectedCode = editor.state.selection.toJSON();
		expect(pressSelectAll().defaultPrevented).toBe(true);
		expect(editor.state.selection.toJSON()).toEqual(selectedCode);

		editor.commands.deleteSelection();
		expect(editor.state.doc.childCount).toBe(3);
		expect(editor.state.doc.child(0).textContent).toBe("before");
		expect(editor.state.doc.child(1).toJSON()).toMatchObject({ type: "codeBlock" });
		expect(editor.state.doc.child(1).textContent).toBe("");
		expect(editor.state.doc.child(2).textContent).toBe("after");
	});

	it("keeps Select All document-wide outside a single code block", () => {
		const range = setCodeDocument();
		for (const selection of [2, { from: range.from, to: range.to + 2 }]) {
			editor.commands.setTextSelection(selection);
			expect(pressSelectAll().defaultPrevented).toBe(true);
			expect(editor.state.selection.toJSON()).toEqual({ type: "all" });
		}
	});
});
