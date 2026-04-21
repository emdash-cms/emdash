/**
 * Markdown Link Extension Tests
 *
 * Tests the MarkdownLinkExtension which converts [text](url) syntax
 * into proper link marks:
 * - Extension registration and input/paste rule presence
 * - Input rule converts typed [text](url) to a linked text node
 * - Paste rule converts pasted markdown links inline
 * - Disallowed protocols (javascript:) are rejected
 * - Edge cases: empty text, empty href, whitespace trimming
 * - No conflict with StarterKit's Link extension commands
 */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { MarkdownLinkExtension } from "../../src/components/editor/MarkdownLinkExtension";

/**
 * Simulate typing text character-by-character into the editor.
 *
 * TipTap InputRules only fire on the `handleTextInput` view prop,
 * which requires dispatching through the EditorView — insertContent()
 * bypasses it. We call `view.someProp("handleTextInput", ...)` for
 * each character, matching how ProseMirror's input rules plugin works.
 */
function simulateTyping(editor: Editor, text: string) {
	for (const char of text) {
		const { from, to } = editor.state.selection;
		const deflt = () => editor.state.tr.insertText(char, from, to);
		const handled = editor.view.someProp("handleTextInput", (f) =>
			f(editor.view, from, to, char, deflt),
		);
		if (!handled) {
			// If no input rule consumed it, insert as plain text
			editor.view.dispatch(deflt());
		}
	}
}

/**
 * Simulate pasting plain text into the editor.
 *
 * Uses ProseMirror's `pasteText()` which runs through the full paste
 * pipeline including TipTap's PasteRule handlers.
 */
function simulatePaste(editor: Editor, text: string) {
	editor.view.pasteText(text);
}

/** Extract all link marks from the editor doc for assertions. */
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

describe("Markdown Link Extension", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor({
			extensions: [
				StarterKit.configure({
					link: {
						openOnClick: false,
						enableClickSelection: true,
					},
				}),
				MarkdownLinkExtension,
			],
			content: "",
		});
	});

	afterEach(() => {
		editor.destroy();
	});

	describe("Extension registration", () => {
		it("registers the markdownLink extension", () => {
			const ext = editor.extensionManager.extensions.find((e) => e.name === "markdownLink");
			expect(ext).toBeDefined();
		});

		it("has the link mark type from StarterKit", () => {
			expect(editor.schema.marks.link).toBeDefined();
		});

		it("registers input rules", () => {
			const ext = editor.extensionManager.extensions.find((e) => e.name === "markdownLink");
			expect(ext).toBeDefined();
			// The extension defines addInputRules, verify it produced rules
			const plugins = editor.state.plugins;
			const inputRulesPlugin = plugins.find(
				(p) => (p.spec as Record<string, unknown>).isInputRules,
			);
			expect(inputRulesPlugin).toBeDefined();
		});
	});

	describe("Input rule — typed markdown links", () => {
		it("converts [text](url) to a link mark on closing paren", () => {
			editor.commands.focus();
			simulateTyping(editor, "[Example](https://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]).toEqual({ text: "Example", href: "https://example.com" });
		});

		it("converts [text](url) with preceding text", () => {
			editor.commands.focus();
			simulateTyping(editor, "Visit [Example](https://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]).toEqual({ text: "Example", href: "https://example.com" });

			// Preceding text should still be present as plain text
			const plainText = editor.getText();
			expect(plainText).toContain("Visit");
			expect(plainText).toContain("Example");
		});

		it("trims whitespace from href", () => {
			editor.commands.focus();
			simulateTyping(editor, "[Docs](  https://docs.example.com  )");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]!.href).toBe("https://docs.example.com");
		});

		it("preserves link text with spaces", () => {
			editor.commands.focus();
			simulateTyping(editor, "[My Cool Link](https://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]!.text).toBe("My Cool Link");
		});
	});

	describe("Paste rule — pasted markdown links", () => {
		it("converts a pasted [text](url) to a link mark", () => {
			editor.commands.focus();
			simulatePaste(editor, "[Example](https://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]).toEqual({ text: "Example", href: "https://example.com" });
		});

		it("converts multiple markdown links in pasted text", () => {
			editor.commands.focus();
			simulatePaste(editor, "See [Foo](https://foo.com) and [Bar](https://bar.com).");

			const links = extractLinks(editor);
			expect(links).toHaveLength(2);
			expect(links[0]).toEqual({ text: "Foo", href: "https://foo.com" });
			expect(links[1]).toEqual({ text: "Bar", href: "https://bar.com" });
		});
	});

	describe("Protocol allowlist — rejects disallowed URIs", () => {
		it("rejects javascript: protocol", () => {
			editor.commands.focus();
			simulateTyping(editor, "[click me](javascript:alert(1))");

			const links = extractLinks(editor);
			expect(links).toHaveLength(0);
			// The raw markdown syntax should remain as literal text
			expect(editor.getText()).toContain("[click me](javascript:alert(1))");
		});

		it("rejects data: protocol", () => {
			editor.commands.focus();
			simulateTyping(editor, "[click me](data:text/html,<script>alert(1)</script>)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(0);
		});

		it("allows https: protocol", () => {
			editor.commands.focus();
			simulateTyping(editor, "[safe](https://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
		});

		it("allows http: protocol", () => {
			editor.commands.focus();
			simulateTyping(editor, "[safe](http://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
		});

		it("allows relative paths", () => {
			editor.commands.focus();
			simulateTyping(editor, "[page](/about)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]!.href).toBe("/about");
		});

		it("allows mailto: protocol", () => {
			editor.commands.focus();
			simulateTyping(editor, "[email](mailto:user@example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
		});
	});

	describe("Edge cases", () => {
		it("does not convert when link text is empty", () => {
			editor.commands.focus();
			simulateTyping(editor, "[](https://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(0);
		});

		it("does not convert when href is empty", () => {
			editor.commands.focus();
			simulateTyping(editor, "[text]()");

			const links = extractLinks(editor);
			expect(links).toHaveLength(0);
		});

		it("handles special characters in link text", () => {
			editor.commands.focus();
			simulateTyping(editor, "[it's a <test> & more](https://example.com)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]!.text).toBe("it's a <test> & more");
		});

		it("handles query strings and fragments in URL", () => {
			editor.commands.focus();
			simulateTyping(editor, "[search](https://example.com/path?q=hello&lang=en#section)");

			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]!.href).toBe("https://example.com/path?q=hello&lang=en#section");
		});
	});

	describe("Coexistence with StarterKit Link extension", () => {
		it("can still set links via the Link command API", () => {
			editor.commands.insertContent("click here");
			editor.commands.selectAll();
			editor.commands.setLink({ href: "https://example.com" });

			expect(editor.isActive("link")).toBe(true);
			const links = extractLinks(editor);
			expect(links).toHaveLength(1);
			expect(links[0]).toEqual({ text: "click here", href: "https://example.com" });
		});

		it("can unset links via the Link command API", () => {
			editor.commands.insertContent("click here");
			editor.commands.selectAll();
			editor.commands.setLink({ href: "https://example.com" });
			expect(editor.isActive("link")).toBe(true);

			editor.commands.unsetLink();
			expect(editor.isActive("link")).toBe(false);
			const links = extractLinks(editor);
			expect(links).toHaveLength(0);
		});

		it("markdown link input does not break subsequent link commands", () => {
			// First, create a link via markdown syntax
			editor.commands.focus();
			simulateTyping(editor, "[md link](https://md.example.com) ");

			// Then create a link via command API
			editor.commands.insertContent("cmd link");
			// Select just the "cmd link" text
			const docSize = editor.state.doc.content.size;
			editor.commands.setTextSelection({ from: docSize - 8, to: docSize - 1 });
			editor.commands.setLink({ href: "https://cmd.example.com" });

			const links = extractLinks(editor);
			expect(links).toHaveLength(2);
		});
	});
});
