// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlineCodeBlockExtension } from "../../../src/components/inline-code-block.js";
import {
	InlinePortableTextEditor,
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

describe("inline Portable Text code blocks", () => {
	let editor: Editor;
	let element: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		element = document.createElement("div");
		document.body.append(element);
		editor = new Editor({
			extensions: [StarterKit.configure({ codeBlock: false }), InlineCodeBlockExtension],
			content: "",
		});
		root = createRoot(element);
		root.render(React.createElement(EditorContent, { editor }));
	});

	afterEach(() => {
		root.unmount();
		editor.destroy();
		element.remove();
	});

	async function renderInlineCode(code: string, language: string) {
		root.render(
			React.createElement(InlinePortableTextEditor, {
				value: [{ _type: "code", _key: "code", code, language }],
				collection: "posts",
				entryId: "post-1",
				field: "body",
			}),
		);
		await vi.waitFor(() => expect(element.querySelector(".emdash-inline-editor")).not.toBeNull(), {
			timeout: 3000,
		});
	}

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

	it("preserves native datalist apply, cancel, alias, and free-form behavior", async () => {
		await renderInlineCode("custom()", "plaintext");
		const languageAction = () =>
			element.querySelector<HTMLButtonElement>('button[aria-label^="Set language"]');
		const openPicker = async (label: string) => {
			await vi.waitFor(() => expect(languageAction()?.getAttribute("aria-label")).toBe(label));
			languageAction()?.click();
			await vi.waitFor(() =>
				expect(element.querySelector('input[aria-label="Language"]')).not.toBeNull(),
			);
		};
		const setInput = (value: string) => {
			const input = element.querySelector<HTMLInputElement>('input[aria-label="Language"]');
			expect(input?.list?.options.length).toBeGreaterThan(0);
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, value);
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		};
		const clickAction = (label: "Apply language" | "Cancel") => {
			const button = element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
			expect(button).not.toBeNull();
			button?.click();
		};

		await openPicker("Set language (current: Plain text)");
		setInput("js");
		clickAction("Apply language");
		await vi.waitFor(() =>
			expect(languageAction()?.getAttribute("aria-label")).toBe(
				"Set language (current: JavaScript)",
			),
		);

		await openPicker("Set language (current: JavaScript)");
		setInput("Discarded Language");
		clickAction("Cancel");
		await vi.waitFor(() =>
			expect(languageAction()?.getAttribute("aria-label")).toBe(
				"Set language (current: JavaScript)",
			),
		);

		await openPicker("Set language (current: JavaScript)");
		setInput("Custom Language");
		clickAction("Apply language");
		await vi.waitFor(() =>
			expect(languageAction()?.getAttribute("aria-label")).toBe(
				"Set language (current: custom-language)",
			),
		);
	});
});
