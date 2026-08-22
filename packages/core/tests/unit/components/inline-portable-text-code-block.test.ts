// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlineCodeBlockExtension } from "../../../src/components/inline-code-block.js";
import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

describe("inline Portable Text code blocks", () => {
	let editor: Editor;
	let element: HTMLDivElement;
	let root: Root;
	let clipboardDescriptor: PropertyDescriptor | undefined;
	let execCommandDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
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
		if (clipboardDescriptor) {
			Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		} else {
			Reflect.deleteProperty(navigator, "clipboard");
		}
		if (execCommandDescriptor) {
			Object.defineProperty(document, "execCommand", execCommandDescriptor);
		} else {
			Reflect.deleteProperty(document, "execCommand");
		}
		root.unmount();
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

	it("renders two actions and selects a language immediately", async () => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "python" },
			content: [{ type: "text", text: "print('hello')" }],
		});

		let toolbar: HTMLElement | null = null;
		await vi.waitFor(() => {
			toolbar = element.querySelector<HTMLElement>('[role="toolbar"]');
			expect(toolbar).not.toBeNull();
			expect(toolbar?.querySelectorAll("button")).toHaveLength(2);
			expect(toolbar?.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
		});

		const languageButton = toolbar?.querySelector<HTMLButtonElement>(
			'button[aria-label="Set language (current: Python)"]',
		);
		languageButton?.focus();
		languageButton?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
		);
		expect(document.activeElement).toBe(
			toolbar?.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]'),
		);
		languageButton?.click();
		await vi.waitFor(() => {
			expect(element.querySelector('input[placeholder="Search for a language…"]')).not.toBeNull();
		});

		const javascriptOption = [...element.querySelectorAll<HTMLElement>('[role="option"]')].find(
			(option) => option.textContent?.includes("JavaScript"),
		);
		expect(javascriptOption).toBeDefined();
		javascriptOption?.click();
		await vi.waitFor(() => {
			expect(editor.getJSON().content?.[0]?.attrs?.language).toBe("javascript");
		});
	});

	it("copies raw code and exposes copied feedback", async () => {
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: clipboardWrite },
		});
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "javascript" },
			content: [{ type: "text", text: "const greeting = 'hello';" }],
		});

		await vi.waitFor(() => {
			expect(element.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
		});
		element.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')?.click();
		await vi.waitFor(() => {
			expect(clipboardWrite).toHaveBeenCalledWith("const greeting = 'hello';");
			expect(element.querySelector('button[aria-label="Copied"]')).not.toBeNull();
			expect(element.querySelector('[role="status"]')?.textContent).toBe("Copied");
		});
	});

	it("falls back to document copy without the Clipboard API", async () => {
		const copyCommand = vi.fn().mockReturnValue(true);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: copyCommand,
		});
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "javascript" },
			content: [{ type: "text", text: "const fallback = true;" }],
		});

		await vi.waitFor(() => {
			expect(element.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
		});
		element.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')?.click();
		await vi.waitFor(() => {
			expect(copyCommand).toHaveBeenCalledWith("copy");
			expect(element.querySelector('button[aria-label="Copied"]')).not.toBeNull();
		});
		expect(document.querySelector("textarea[readonly]")).toBeNull();
	});

	it("commits free-form input and restores focus on Escape", async () => {
		editor.commands.insertContent({
			type: "codeBlock",
			attrs: { language: "plaintext" },
			content: [{ type: "text", text: "custom()" }],
		});
		await vi.waitFor(() => {
			expect(
				element.querySelector('button[aria-label="Set language (current: Plain text)"]'),
			).not.toBeNull();
		});

		let languageButton = element.querySelector<HTMLButtonElement>(
			'button[aria-label="Set language (current: Plain text)"]',
		);
		languageButton?.click();
		let input: HTMLInputElement | null = null;
		await vi.waitFor(() => {
			input = element.querySelector<HTMLInputElement>(
				'input[placeholder="Search for a language…"]',
			);
			expect(input).not.toBeNull();
		});
		const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		valueSetter?.call(input, "Custom Language");
		input?.dispatchEvent(new Event("input", { bubbles: true }));
		input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => {
			expect(editor.getJSON().content?.[0]?.attrs?.language).toBe("custom-language");
		});

		languageButton = element.querySelector<HTMLButtonElement>(
			'button[aria-label="Set language (current: custom-language)"]',
		);
		languageButton?.click();
		await vi.waitFor(() => {
			input = element.querySelector<HTMLInputElement>(
				'input[placeholder="Search for a language…"]',
			);
			expect(input).not.toBeNull();
		});
		input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await vi.waitFor(() => {
			expect(element.querySelector('input[placeholder="Search for a language…"]')).toBeNull();
			expect(document.activeElement).toBe(languageButton);
		});
	});
});
