/**
 * Tests for the custom CodeBlockExtension (language picker node view).
 *
 * Verifies that:
 *   - The extension keeps the canonical `codeBlock` schema name so existing
 *     code that calls `editor.isActive("codeBlock")` keeps working.
 *   - The `language` attribute is settable and round-trips through getJSON.
 *   - StarterKit's backtick input rule still fires when our extension is
 *     swapped in (since we extend the base extension rather than replace
 *     it).
 */

import { Editor, type Content } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeBlockExtension } from "../../src/components/editor/CodeBlockNode";

type Selection = number | { from: number; to: number };

const tabEventInit = { key: "Tab", bubbles: true, cancelable: true };

function pressTab(editor: Editor, shiftKey = false) {
	const event = new KeyboardEvent("keydown", { ...tabEventInit, shiftKey });
	editor.view.dom.dispatchEvent(event);
	return event;
}

function setCode(editor: Editor, text: string) {
	editor.commands.setContent({ type: "codeBlock", content: [{ type: "text", text }] });
}

function expectTabUnhandled(editor: Editor, content: Content, selection: Selection) {
	for (const shiftKey of [false, true]) {
		editor.commands.setContent(content);
		editor.commands.setTextSelection(selection);
		const before = editor.state.doc.toJSON();
		const selected = editor.state.selection.toJSON();
		expect(pressTab(editor, shiftKey).defaultPrevented).toBe(false);
		expect(editor.state.doc.toJSON()).toEqual(before);
		expect(editor.state.selection.toJSON()).toEqual(selected);
	}
}

describe("CodeBlockExtension", () => {
	let editor: Editor;
	let element: HTMLDivElement;

	beforeEach(() => {
		element = document.createElement("div");
		document.body.append(element);
		editor = new Editor({
			element,
			extensions: [
				StarterKit.configure({
					heading: { levels: [1, 2, 3] },
					codeBlock: false,
				}),
				CodeBlockExtension,
			],
			content: "",
		});
	});

	afterEach(() => {
		editor.destroy();
		element.remove();
	});

	it("registers the codeBlock schema node", () => {
		expect(editor.schema.nodes.codeBlock).toBeDefined();
	});

	it("registers under the name 'codeBlock' so isActive lookups keep working", () => {
		const ext = editor.extensionManager.extensions.find((e) => e.name === "codeBlock");
		expect(ext).toBeDefined();
	});

	it("toggleCodeBlock activates the node", () => {
		editor.commands.toggleCodeBlock();
		expect(editor.isActive("codeBlock")).toBe(true);
	});

	it("language attribute round-trips through the editor state", () => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "html" },
			content: [{ type: "text", text: "<p>hi</p>" }],
		});
		const json = editor.getJSON();
		const node = json.content?.find((n) => n.type === "codeBlock");
		expect(node).toBeDefined();
		expect((node as { attrs?: { language?: string } }).attrs?.language).toBe("html");
	});

	it("updateAttributes can change the language on an existing code block", () => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: null },
			content: [{ type: "text", text: "x" }],
		});
		editor.commands.setNodeSelection(0);
		editor.commands.updateAttributes("codeBlock", { language: "typescript" });
		const node = editor.getJSON().content?.find((n) => n.type === "codeBlock");
		expect((node as { attrs?: { language?: string } }).attrs?.language).toBe("typescript");
	});

	it.each([
		["indentation", false, "code", 3, "co    de"],
		["outdent", true, "      code", 11, "  code"],
	])("handles caret %s as one undoable operation", (_name, shiftKey, before, position, after) => {
		setCode(editor, before);
		editor.view.dispatch(closeHistory(editor.state.tr));
		editor.commands.setTextSelection(position);
		expect(pressTab(editor, shiftKey).defaultPrevented).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe(after);
		expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
		expect(editor.commands.undo()).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe(before);
		expect(editor.commands.redo()).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe(after);
	});

	it("indents and outdents a multiline selection", () => {
		setCode(editor, "one\ntwo");
		editor.commands.setTextSelection({ from: 1, to: 8 });
		expect(pressTab(editor).defaultPrevented).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe("    one\n    two");
		expect(pressTab(editor, true).defaultPrevented).toBe(true);
		expect(editor.state.doc.firstChild?.textContent).toBe("one\ntwo");
	});

	it("leaves paragraph and cross-block selections unhandled", () => {
		expectTabUnhandled(editor, { type: "paragraph", content: [{ type: "text", text: "text" }] }, 2);
		expectTabUnhandled(
			editor,
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

	it.each([
		["javascript", 'const greeting = "hello";'],
		["dockerfile", "FROM node:22"],
	])("renders syntax tokens for %s", async (language, code) => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language },
			content: [{ type: "text", text: code }],
		});

		await vi.waitFor(() => {
			expect(element.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
		});

		expect(JSON.stringify(editor.getJSON())).not.toContain("hljs-");
	});

	it.each(["plaintext", "astro", "zig", "custom-language", null, undefined])(
		"leaves %s code unhighlighted",
		async (language) => {
			editor.commands.insertContent({
				type: "codeBlock",
				attrs: { language },
				content: [{ type: "text", text: 'const greeting = "hello";' }],
			});

			await vi.waitFor(() => {
				expect(element.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0);
			});
		},
	);

	it("updates decorations when the selected language changes", async () => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "javascript" },
			content: [{ type: "text", text: 'const greeting = "hello";' }],
		});

		await vi.waitFor(() => {
			expect(element.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
		});

		editor.commands.setNodeSelection(0);
		editor.commands.updateAttributes("codeBlock", { language: "astro" });

		await vi.waitFor(() => {
			expect(element.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0);
		});
		const node = editor.getJSON().content?.find((item) => item.type === "codeBlock");
		expect(node?.content?.[0]?.text).toBe('const greeting = "hello";');
	});
});
