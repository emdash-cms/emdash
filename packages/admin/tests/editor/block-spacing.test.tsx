import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { PortableTextEditorProps } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";

import "../../dist/styles.css";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

interface Box {
	top: number;
	bottom: number;
}

const key = () => Math.random().toString(36).slice(2, 9);

function textBlock(text: string, style = "normal") {
	return {
		_type: "block",
		_key: key(),
		style,
		children: [{ _type: "span", _key: key(), text }],
	};
}

const codeBlock = (code: string) => ({ _type: "code", _key: key(), code, language: "js" });

/** The lines of a text block, without the padding around them. */
function textBox(element: Element): Box {
	const rect = element.getBoundingClientRect();
	const style = getComputedStyle(element);
	return {
		top: rect.top + Number.parseFloat(style.paddingTop),
		bottom: rect.bottom - Number.parseFloat(style.paddingBottom),
	};
}

function frameBox(element: Element): Box {
	const { top, bottom } = element.getBoundingClientRect();
	return { top, bottom };
}

const gap = (above: Box, below: Box) => below.top - above.bottom;

async function renderEditor(
	variant: PortableTextEditorProps["variant"],
	value: NonNullable<PortableTextEditorProps["value"]>,
) {
	let editor: Editor | null = null;
	const screen = await render(
		<PortableTextEditor
			variant={variant}
			value={value}
			onEditorReady={(instance) => (editor = instance)}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	const pm = screen.container.querySelector<HTMLElement>(".ProseMirror")!;
	// Node views can fill in after the editor is ready.
	await vi.waitFor(() => expect(pm.querySelectorAll(".react-renderer:empty")).toHaveLength(0));
	await document.fonts.ready;
	return { editor: editor!, pm };
}

describe.each(["document", "boxed"] as const)("Block spacing in the %s editor", (variant) => {
	const renderBlocks = (value: NonNullable<PortableTextEditorProps["value"]>) =>
		renderEditor(variant, value);

	it("gives a heading clearly more space above it than paragraphs have between them", async () => {
		const { pm } = await renderBlocks([
			textBlock("First paragraph"),
			textBlock("Second paragraph"),
			textBlock("Section", "h2"),
		]);
		const [first, second] = Array.from(pm.querySelectorAll(":scope > p"), textBox);
		const heading = textBox(pm.querySelector("h2")!);

		expect(gap(second!, heading)).toBeGreaterThan(gap(first!, second!) * 1.5);
	});

	it("gives a quote the same clearance from text as a code block", async () => {
		const { pm } = await renderBlocks([
			textBlock("Before the quote"),
			textBlock("Quoted", "blockquote"),
			textBlock("Before the code"),
			codeBlock("let a = 1;"),
			textBlock("After the code"),
		]);
		const [beforeQuote, beforeCode, afterCode] = Array.from(
			pm.querySelectorAll(":scope > p"),
			textBox,
		);
		const quote = frameBox(pm.querySelector("blockquote")!);
		const code = frameBox(pm.querySelector(".emdash-code-block")!);

		expect(gap(beforeQuote!, quote)).toBeCloseTo(gap(beforeCode!, code), 0);
		expect(gap(quote, beforeCode!)).toBeCloseTo(gap(code, afterCode!), 0);
	});

	it("joins quotes that sit next to each other into one", async () => {
		const quote = (...lines: string[]) => ({
			type: "blockquote",
			content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
		});
		const single = await renderBlocks([]);
		single.editor.commands.setContent({
			type: "doc",
			content: [quote("First quoted line", "Second quoted line")],
		});
		const adjacent = await renderBlocks([]);
		adjacent.editor.commands.setContent({
			type: "doc",
			content: [quote("First quoted line"), quote("Second quoted line")],
		});

		const layout = (pm: HTMLElement) => {
			const quotes = Array.from(pm.querySelectorAll("blockquote"), frameBox);
			const top = quotes[0]!.top;
			return {
				rule: Math.round(quotes.at(-1)!.bottom - top),
				lines: Array.from(pm.querySelectorAll("blockquote p"), (line) =>
					Math.round(line.getBoundingClientRect().top - top),
				),
			};
		};
		expect(layout(adjacent.pm)).toEqual(layout(single.pm));
	});

	it.each([
		{ name: "code block", block: () => codeBlock("let a = 1;"), frame: ".emdash-code-block" },
		{ name: "quote", block: () => textBlock("Quoted", "blockquote"), frame: "blockquote" },
	])(
		"sets a heading apart from a $name above it and close to one below it",
		async ({ block, frame }) => {
			const { pm } = await renderBlocks([
				textBlock("Intro"),
				block(),
				textBlock("Section", "h3"),
				block(),
				textBlock("After"),
			]);
			const [intro, after] = Array.from(pm.querySelectorAll(":scope > p"), textBox);
			const [above, below] = Array.from(pm.querySelectorAll(frame), frameBox);
			const heading = textBox(pm.querySelector("h3")!);

			expect(gap(above!, heading)).toBeGreaterThan(gap(below!, after!));
			expect(gap(heading, below!)).toBeLessThan(gap(intro!, above!));
		},
	);

	it("centres a divider between a paragraph and the heading after it", async () => {
		const { pm } = await renderBlocks([
			textBlock("End of a section"),
			{ _type: "break", _key: key(), style: "lineBreak" },
			textBlock("Next section", "h2"),
		]);
		const rule = pm.querySelector("hr")!.getBoundingClientRect();
		const line = { top: rule.top + rule.height / 2, bottom: rule.top + rule.height / 2 };

		expect(gap(textBox(pm.querySelector(":scope > p")!), line)).toBeCloseTo(
			gap(line, textBox(pm.querySelector("h2")!)),
			0,
		);
	});
});

const video = () => ({
	_type: "video",
	_key: key(),
	asset: { _ref: "clip", url: "/clip.mp4", provider: "external" },
	width: 640,
	height: 360,
});

const image = () => ({
	_type: "image",
	_key: key(),
	asset: { _ref: "photo", url: "/photo.jpg", provider: "external" },
	alt: "Photo",
	width: 400,
	height: 300,
});

/** Selects the media block and opens its empty caption with Add caption. */
async function openCaption(editor: Editor, pm: HTMLElement) {
	editor.view.focus();
	editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize);
	await userEvent.click(page.getByRole("button", { name: "Add caption" }));
	const caption = pm.querySelector("figure textarea");
	expect(document.activeElement).toBe(caption);
}

describe("Empty media captions", () => {
	it("take no room until Add caption opens them", async () => {
		const { editor, pm } = await renderEditor("document", [
			textBlock("Before"),
			video(),
			textBlock("After"),
		]);
		const figure = pm.querySelector("figure")!;
		const frame = pm.querySelector("video")!.parentElement!;
		const frameHeight = frame.getBoundingClientRect().height;
		expect(figure.getBoundingClientRect().height).toBeCloseTo(frameHeight, 0);

		await openCaption(editor, pm);
		expect(figure.getBoundingClientRect().height).toBeGreaterThan(frameHeight);

		await userEvent.keyboard("{Escape}");
		await vi.waitFor(() =>
			expect(figure.getBoundingClientRect().height).toBeCloseTo(frameHeight, 0),
		);
	});

	it.each([
		{ name: "image", block: image },
		{ name: "video", block: video },
	])(
		"keeps the text below still until a click away from an empty $name caption ends",
		async ({ block }) => {
			const { editor, pm } = await renderEditor("document", [
				textBlock("Before"),
				block(),
				textBlock("After"),
			]);
			await openCaption(editor, pm);
			const after = pm.querySelector<HTMLElement>(":scope > p:last-of-type")!;
			const tops: number[] = [];
			const record = () => tops.push(after.getBoundingClientRect().top);
			const events = ["pointerdown", "pointerup", "click"];
			for (const type of events) window.addEventListener(type, record, true);
			try {
				await userEvent.click(after);
			} finally {
				for (const type of events) window.removeEventListener(type, record, true);
			}

			expect(tops).toHaveLength(3);
			for (const top of tops) expect(top).toBeCloseTo(tops[0]!, 0);
			await vi.waitFor(() => expect(after.getBoundingClientRect().top).toBeLessThan(tops[0]!));
		},
	);
});
