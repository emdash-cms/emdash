/**
 * Regression tests for TipTap's automatic link detection in the Portable Text editor.
 *
 * linkify treats bare `word.tld` strings such as `README.md` as URLs because `.md`
 * is a real TLD. The production editor limits auto-detection to explicit URLs
 * (with a scheme or `www.`) so filenames and dotted identifiers stay plain text.
 */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultLinkOptions } from "../../src/components/editor/defaultLinkOptions.js";

function simulateTyping(editor: Editor, text: string) {
	for (const char of text) {
		const { from, to } = editor.state.selection;
		const deflt = () => editor.state.tr.insertText(char, from, to);
		const handled = editor.view.someProp("handleTextInput", (f) =>
			f(editor.view, from, to, char, deflt),
		);
		if (!handled) {
			editor.view.dispatch(deflt());
		}
	}
}

function simulatePaste(editor: Editor, text: string) {
	editor.view.pasteText(text);
}

function extractLinks(editor: Editor): Array<{ text: string; href: string }> {
	const links: Array<{ text: string; href: string }> = [];
	editor.state.doc.descendants((node) => {
		if (node.isText) {
			const linkMark = node.marks.find((m) => m.type.name === "link");
			if (linkMark) {
				links.push({ text: node.text || "", href: linkMark.attrs.href });
			}
		}
	});
	return links;
}

beforeEach(() => {
	// Playwright is required by the admin package test config. Ensure browsers are
	// installed (`pnpm exec playwright install chromium`) before running tests.
});

describe("Production link options", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor({
			extensions: [
				StarterKit.configure({
					link: defaultLinkOptions,
				}),
			],
			content: "",
		});
		editor.commands.focus();
	});

	afterEach(() => {
		editor.destroy();
	});

	it("does not auto-link bare word.tld when typed", () => {
		simulateTyping(editor, "See README.md for details.");
		expect(extractLinks(editor)).toEqual([]);
		expect(editor.getText()).toContain("README.md");
	});

	it("does not auto-link bare word.tld when pasted", () => {
		simulatePaste(editor, "See README.md and setup.sh for details.");
		expect(extractLinks(editor)).toEqual([]);
		expect(editor.getText()).toContain("README.md");
		expect(editor.getText()).toContain("setup.sh");
	});

	it("auto-links explicit URLs with a scheme when typed", () => {
		simulateTyping(editor, "Visit https://example.com today.");
		const links = extractLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toEqual({ text: "https://example.com", href: "https://example.com" });
	});

	it("auto-links explicit URLs with a scheme when pasted", () => {
		simulatePaste(editor, "Visit https://example.com today.");
		const links = extractLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toEqual({ text: "https://example.com", href: "https://example.com" });
	});

	it("auto-links www. URLs when typed", () => {
		simulateTyping(editor, "Visit www.example.com today.");
		const links = extractLinks(editor);
		expect(links.length).toBeGreaterThan(0);
		expect(links.some((l) => l.text === "www.example.com")).toBe(true);
	});

	it("creates a link via the setLink command", () => {
		editor.commands.insertContent("click here");
		editor.commands.selectAll();
		editor.commands.setLink({ href: "https://example.com" });

		const links = extractLinks(editor);
		expect(links).toHaveLength(1);
		expect(links[0]).toEqual({ text: "click here", href: "https://example.com" });
	});
});

describe("Default TipTap link options", () => {
	it("would create a link from bare word.tld without the production filter", () => {
		const defaultEditor = new Editor({
			extensions: [StarterKit.configure({ link: { openOnClick: false } })],
			content: "",
		});
		defaultEditor.commands.focus();

		simulateTyping(defaultEditor, "See README.md for details.");

		const links = extractLinks(defaultEditor);
		expect(links.length).toBeGreaterThan(0);
		expect(links.some((l) => l.text === "README.md" && l.href === "http://README.md")).toBe(true);

		defaultEditor.destroy();
	});
});
