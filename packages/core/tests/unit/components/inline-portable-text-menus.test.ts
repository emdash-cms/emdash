// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

type PortableTextValue = React.ComponentProps<typeof InlinePortableTextEditor>["value"];
type SavedBlock = {
	_type: string;
	style?: string;
	listItem?: string;
	level?: number;
	children?: Array<{ text: string; marks?: string[] }>;
	markDefs?: Array<{ _key: string; href?: string }>;
};

function block(
	key: string,
	text: string,
	style = "normal",
	list: { listItem?: "bullet"; level?: number } = {},
) {
	return {
		_type: "block" as const,
		_key: key,
		style,
		markDefs: [],
		children: [{ _type: "span" as const, _key: `${key}-1`, text, marks: [] }],
		...(list.listItem ? { listItem: list.listItem, level: list.level ?? 1 } : {}),
	};
}

type TestEditor = {
	state: { doc: { content: { size: number } } };
	view: { dom: HTMLElement };
	commands: {
		focus: () => boolean;
		setTextSelection: (position: number | { from: number; to: number }) => boolean;
		insertContent: (value: string) => boolean;
		splitBlock: () => boolean;
	};
};

// The component does not expose its editor, so this uses the instance
// Tiptap's core attaches to its view's root element (`view.dom.editor`).
function editorOf(editable: HTMLElement): TestEditor {
	const editor = (editable as HTMLElement & { editor?: TestEditor }).editor;
	expect(editor).toBeDefined();
	return editor!;
}

function setInputValue(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(target: Element, key: string) {
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("inline Portable Text editor toolbars and slash menu", () => {
	let container: HTMLDivElement;
	let root: Root;
	let puts: Array<{ data: Record<string, SavedBlock[]> }>;

	beforeAll(() => {
		// ProseMirror measures ranges to place the toolbars; jsdom has no layout.
		Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
		Range.prototype.getBoundingClientRect ??= () => new DOMRect();
	});

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		puts = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "PUT" && typeof init.body === "string")
					puts.push(JSON.parse(init.body));
				return Response.json({ data: {} });
			}),
		);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function mount(value: PortableTextValue) {
		await act(async () => {
			root.render(
				React.createElement(InlinePortableTextEditor, {
					value: structuredClone(value),
					collection: "posts",
					entryId: "entry-1",
					field: "body",
				}),
			);
		});
		const editable = container.querySelector<HTMLElement>(".ProseMirror");
		expect(editable).not.toBeNull();
		return editable!;
	}

	async function saved(editable: HTMLElement): Promise<SavedBlock[]> {
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
		await vi.waitFor(() => expect(puts).toHaveLength(1));
		return puts[0]!.data.body!;
	}

	async function selectAndShowToolbar(editable: HTMLElement, from: number, to: number) {
		await act(async () => {
			editorOf(editable).commands.focus();
			editorOf(editable).commands.setTextSelection({ from, to });
		});
		return vi.waitFor(
			() => {
				const toolbar = document.querySelector<HTMLElement>(".emdash-bubble-menu");
				expect(toolbar?.isConnected).toBe(true);
				return toolbar!;
			},
			{ timeout: 3000 },
		);
	}

	async function click(element: Element) {
		await act(async () => {
			(element as HTMLElement).click();
		});
	}

	async function turnInto(toolbar: HTMLElement, label: string) {
		await click(toolbar.querySelector('[aria-label="Turn into"]')!);
		const item = await vi.waitFor(() => {
			const match = [...document.querySelectorAll('[role="menuitemradio"]')].find(
				(candidate) => candidate.textContent === label,
			);
			expect(match).toBeDefined();
			return match!;
		});
		await click(item);
	}

	it("turns a heading into a quote without losing its text", async () => {
		const editable = await mount([block("a", "Section title", "h2"), block("b", "Body text.")]);
		const toolbar = await selectAndShowToolbar(editable, 2, 9);

		await turnInto(toolbar, "Quote");

		const blocks = await saved(editable);
		expect(blocks[0]).toMatchObject({
			_type: "block",
			style: "blockquote",
			children: [{ text: "Section title" }],
		});
		expect(blocks[1]).toMatchObject({ style: "normal", children: [{ text: "Body text." }] });
	});

	it("turns a nested list into one quote, and the quote into a flat list", async () => {
		const editable = await mount([
			block("a", "First line.", "normal", { listItem: "bullet" }),
			block("b", "Second line.", "normal", { listItem: "bullet", level: 2 }),
		]);
		const editor = editorOf(editable);
		const toolbar = await selectAndShowToolbar(editable, 4, editor.state.doc.content.size - 6);

		await turnInto(toolbar, "Quote");
		expect(editable.querySelectorAll("ul")).toHaveLength(0);
		expect(
			Array.from(editable.querySelectorAll("blockquote > p"), (line) => line.textContent),
		).toEqual(["First line.", "Second line."]);

		await turnInto(toolbar, "Bullet List");
		const blocks = await saved(editable);
		expect(blocks.slice(0, 2)).toMatchObject([
			{ listItem: "bullet", level: 1, children: [{ text: "First line." }] },
			{ listItem: "bullet", level: 1, children: [{ text: "Second line." }] },
		]);
		expect(blocks.some((savedBlock) => savedBlock.style === "blockquote")).toBe(false);
	});

	it("tabs through the toolbar as if it followed the editor", async () => {
		const editable = await mount([block("a", "Some text to format.")]);
		const nextOnPage = document.createElement("button");
		nextOnPage.textContent = "After the field";
		container.append(nextOnPage);
		const toolbar = await selectAndShowToolbar(editable, 1, 5);

		await act(async () => press(editable, "Tab"));
		const turnIntoButton = toolbar.querySelector('[aria-label="Turn into"]');
		expect(document.activeElement).toBe(turnIntoButton);
		expect(toolbar.isConnected).toBe(true);

		await act(async () => {
			turnIntoButton!.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Tab",
					shiftKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		expect(document.activeElement).toBe(editable);

		const more = toolbar.querySelector<HTMLElement>('[aria-label="More formatting"]')!;
		await act(async () => more.focus());
		await act(async () => press(more, "Tab"));
		expect(document.activeElement).toBe(nextOnPage);
	});

	it("hides the toolbar once focus leaves the editor after a toolbar button", async () => {
		const editable = await mount([block("a", "Some text to format.")]);
		const toolbar = await selectAndShowToolbar(editable, 1, 5);
		const bold = toolbar.querySelector<HTMLElement>('[aria-label="Bold"]')!;

		await act(async () => {
			bold.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
			bold.click();
		});
		expect(bold.getAttribute("aria-pressed")).toBe("true");
		// Outlasts the toolbar's 120 ms update after the edit, which would otherwise hide it.
		await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
		expect(toolbar.isConnected).toBe(true);
		await act(async () => editable.blur());

		await vi.waitFor(() => expect(toolbar.isConnected).toBe(false));
	});

	it("shows a stored heading 4 as a heading 4", async () => {
		const editable = await mount([block("a", "Fine print", "h4")]);
		expect(editable.querySelector("h4")?.textContent).toBe("Fine print");
	});

	it("finds Heading 4 from the slash menu and inserts it", async () => {
		const editable = await mount([block("a", "Intro.")]);
		const editor = editorOf(editable);
		await act(async () => {
			editor.commands.focus();
			editor.commands.setTextSelection(editor.state.doc.content.size - 1);
			editor.commands.splitBlock();
			editor.commands.insertContent("/h4");
		});
		await vi.waitFor(() =>
			expect(document.querySelector('.emdash-slash-menu [aria-current="true"]')?.textContent).toBe(
				"Heading 4####",
			),
		);

		await act(async () => press(editable, "Enter"));
		await act(async () => {
			editor.commands.insertContent("Details");
		});

		// The menu fades out before it leaves the page.
		await vi.waitFor(() => expect(document.querySelector(".emdash-slash-menu")).toBeNull());
		const blocks = await saved(editable);
		expect(blocks[1]).toMatchObject({ style: "h4", children: [{ text: "Details" }] });
	});

	it("keeps an unsafe link out and links a bare domain over https", async () => {
		const editable = await mount([block("a", "Read the guide first.")]);
		const toolbar = await selectAndShowToolbar(editable, 10, 15);

		await click(toolbar.querySelector('[aria-label="Add link"]')!);
		const input = await vi.waitFor(() => {
			const field = toolbar.querySelector<HTMLInputElement>("input");
			expect(field).not.toBeNull();
			return field!;
		});
		await act(async () => setInputValue(input, "javascript:alert(1)"));
		await act(async () => press(input, "Enter"));
		expect(toolbar.querySelector('[role="alert"]')?.textContent).toContain(
			"This link can't be used",
		);
		expect(editable.querySelector("a")).toBeNull();

		await act(async () => setInputValue(input, "example.com"));
		await act(async () => press(input, "Enter"));

		const blocks = await saved(editable);
		expect(blocks[0]!.markDefs).toEqual([
			expect.objectContaining({ _type: "link", href: "https://example.com" }),
		]);
		const linked = blocks[0]!.children!.find((child) => child.marks?.length);
		expect(linked?.text).toBe("guide");
	});
});
