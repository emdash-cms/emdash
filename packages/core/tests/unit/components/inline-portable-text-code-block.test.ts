// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlineCodeBlockExtension } from "../../../src/components/inline-code-block.js";
import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

describe("inline Portable Text code blocks", () => {
	let editor: Editor;
	let element: HTMLDivElement;

	beforeEach(() => {
		element = document.createElement("div");
		document.body.append(element);
		editor = new Editor({
			element,
			extensions: [StarterKit.configure({ codeBlock: false }), InlineCodeBlockExtension],
			content: "",
		});
	});

	afterEach(() => {
		editor.destroy();
		element.remove();
	});

	it("renders syntax tokens for a supported language", async () => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "javascript" },
			content: [{ type: "text", text: 'const greeting = "hello";' }],
		});

		await vi.waitFor(() => {
			expect(element.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
		});
	});

	it("preserves an unsupported string language without highlighting it", async () => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "astro" },
			content: [{ type: "text", text: 'const greeting = "hello";' }],
		});

		await vi.waitFor(() => {
			expect(element.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0);
		});
		expect(editor.getJSON().content?.[0]?.attrs?.language).toBe("astro");
	});

	it("treats an invalid non-string language as missing", () => {
		const proseMirror = portableTextToPM([
			{ _type: "code", _key: "code", code: "const value = 1;", language: 42 } as never,
		]);
		const codeBlock = proseMirror.content?.[0];
		const serialized = pmToPortableText(proseMirror)[0];

		expect(codeBlock?.attrs?.language).toBeNull();
		expect(JSON.stringify(serialized)).not.toContain('"language"');
	});
});
