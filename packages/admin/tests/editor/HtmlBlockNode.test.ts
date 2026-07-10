/**
 * Tests for the custom HtmlBlockExtension (first-class HTML block node view).
 *
 * Verifies that:
 *   - The extension registers the `htmlBlock` schema node.
 *   - The `html` attribute round-trips through getJSON.
 *   - DOM/clipboard serialization stores the markup in a semantic
 *     `data-html-content` attribute rather than leaking a bare `html="..."`
 *     attribute, and parses it back on the way in.
 */

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { HtmlBlockExtension } from "../../src/components/editor/HtmlBlockNode";

describe("HtmlBlockExtension", () => {
	let editor: Editor;

	beforeEach(() => {
		editor = new Editor({
			extensions: [
				StarterKit.configure({
					heading: { levels: [1, 2, 3] },
				}),
				HtmlBlockExtension,
			],
			content: "",
		});
	});

	afterEach(() => {
		editor.destroy();
	});

	it("registers the htmlBlock schema node", () => {
		expect(editor.schema.nodes.htmlBlock).toBeDefined();
	});

	it("html attribute round-trips through the editor state", () => {
		editor.commands.insertContent({
			type: "htmlBlock",
			attrs: { html: '<div class="callout"><p>Hello</p></div>' },
		});
		const node = editor.getJSON().content?.find((n) => n.type === "htmlBlock");
		expect((node as { attrs?: { html?: string } }).attrs?.html).toBe(
			'<div class="callout"><p>Hello</p></div>',
		);
	});

	it("serializes markup to data-html-content, not a bare html attribute", () => {
		editor.commands.insertContent({
			type: "htmlBlock",
			attrs: { html: "<p>Injected</p>" },
		});
		const serialized = editor.getHTML();
		expect(serialized).toContain("data-html-content");
		// The raw markup must not leak as a top-level `html="..."` attribute.
		expect(serialized).not.toMatch(/\shtml="/);
	});

	it("parses markup back from the data-html-content attribute", () => {
		editor.commands.setContent(
			'<div data-html-block data-html-content="&lt;p&gt;Round trip&lt;/p&gt;"></div>',
		);
		const node = editor.getJSON().content?.find((n) => n.type === "htmlBlock");
		expect(node).toBeDefined();
		expect((node as { attrs?: { html?: string } }).attrs?.html).toBe("<p>Round trip</p>");
	});
});
