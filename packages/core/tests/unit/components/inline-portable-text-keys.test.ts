// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

type PortableTextValue = React.ComponentProps<typeof InlinePortableTextEditor>["value"];

function block(key: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		_type: "block" as const,
		_key: key,
		style: "normal" as const,
		markDefs: [],
		children: [{ _type: "span" as const, _key: `${key}-span`, text, marks: [] }],
		...extra,
	};
}

const storedBody: PortableTextValue = [
	block("para", "First paragraph."),
	block("heading", "A heading", { style: "h2" }),
	block("bullet-1", "Bullet one", { listItem: "bullet", level: 1 }),
	block("bullet-2", "Bullet two", { listItem: "bullet", level: 1 }),
	block("quote-1", "Quoted once", { style: "blockquote" }),
	block("quote-2", "Quoted twice", { style: "blockquote" }),
	{ _type: "code", _key: "code", code: "let x = 1;", language: "js" },
	{ _type: "image", _key: "image", asset: { _ref: "01IMAGE", url: "/image.jpg" } },
	{ _type: "htmlBlock", _key: "html", html: "<p>Embedded HTML</p>" },
	{ _type: "marketing.hero", _key: "hero", headline: "Hello" },
	{ _type: "break", _key: "rule", style: "lineBreak" },
	block("last", "Last paragraph."),
];

describe("inline Portable Text editor block keys", () => {
	let container: HTMLDivElement;
	let root: Root;
	let puts: Array<{ data: Record<string, Array<{ _key: string; _type: string }>> }>;

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		puts = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "PUT" && typeof init.body === "string") {
					puts.push(JSON.parse(init.body));
				}
				return Response.json({ data: {} });
			}),
		);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
		vi.unstubAllGlobals();
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
		// The component doesn't expose its editor; TipTap attaches it to the view's root element.
		const editor = (editable as HTMLElement & { editor?: Editor }).editor;
		expect(editor).toBeDefined();
		return { editable: editable!, editor: editor! };
	}

	async function save(editable: HTMLElement) {
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
		expect(puts).toHaveLength(1);
		return puts[0]!.data.body!;
	}

	it("keeps every block's key when an edited body is saved", async () => {
		const { editable, editor } = await mount(storedBody);
		await act(async () => {
			editor.commands.insertContentAt(1, "Edited. ");
		});

		const saved = await save(editable);

		expect(saved.map((item) => item._key)).toEqual(storedBody.map((stored) => stored._key));
	});

	it("keeps the key on one half of a split block and gives the other half its own", async () => {
		const { editable, editor } = await mount([block("para", "Before after"), block("next", "Next")]);
		await act(async () => {
			editor.chain().setTextSelection(8).splitBlock().run();
		});

		const keys = (await save(editable)).map((saved) => saved._key);

		expect(keys).toHaveLength(3);
		expect(keys).toContain("para");
		expect(keys[2]).toBe("next");
		expect(new Set(keys).size).toBe(3);
	});

	it("gives a pasted copy of a block a new key", async () => {
		const { editable, editor } = await mount([block("para", "Copy me"), block("next", "Next")]);
		const copy = editor.getJSON().content![0]!;
		await act(async () => {
			editor.commands.insertContentAt(editor.state.doc.content.size, copy);
		});

		const keys = (await save(editable)).map((saved) => saved._key);

		expect(keys.slice(0, 2)).toEqual(["para", "next"]);
		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(3);
	});

	it("saves each key once when the stored body repeats one", async () => {
		const { editable, editor } = await mount([block("same", "One"), block("same", "Two")]);
		await act(async () => {
			editor.commands.insertContentAt(1, "Edited. ");
		});

		const keys = (await save(editable)).map((saved) => saved._key);

		expect(keys).toContain("same");
		expect(new Set(keys).size).toBe(2);
	});
});
