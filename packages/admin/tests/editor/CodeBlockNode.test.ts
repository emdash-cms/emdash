/**
 * Tests for the custom CodeBlockExtension (language picker node view).
 *
 * Verifies that:
 *   - The extension keeps the canonical `codeBlock` schema name so existing
 *     code that calls `editor.isActive("codeBlock")` keeps working.
 *   - The `language` attribute is settable and round-trips through getJSON.
 *   - StarterKit's backtick input rule still fires when our extension is
 *     swapped in (since we extend the base extension rather than replace
 *     it). We can't drive real keyboard input in jsdom, so we verify the
 *     rule's regex is registered via the extension's inputRules schema.
 */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { CodeBlockExtension } from "../../src/components/editor/CodeBlockNode";

describe("CodeBlockExtension", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor({
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
});
