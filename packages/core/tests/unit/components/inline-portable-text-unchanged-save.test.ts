// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

// A stored body whose keys came from somewhere else (an import, the admin
// editor), including a link, whose mark refers to its markDef by key.
const storedBody = [
	{
		_type: "block" as const,
		_key: "stored-a",
		style: "normal" as const,
		markDefs: [],
		children: [{ _type: "span" as const, _key: "stored-a-1", text: "First paragraph.", marks: [] }],
	},
	{
		_type: "block" as const,
		_key: "stored-b",
		style: "normal" as const,
		markDefs: [{ _type: "link", _key: "stored-link", href: "https://example.com/" }],
		children: [
			{ _type: "span" as const, _key: "stored-b-1", text: "Read ", marks: [] },
			{ _type: "span" as const, _key: "stored-b-2", text: "the guide", marks: ["stored-link"] },
			{ _type: "span" as const, _key: "stored-b-3", text: " first.", marks: [] },
		],
	},
];

describe("inline Portable Text editor saves", () => {
	let container: HTMLDivElement;
	let root: Root;
	let puts: Array<{ url: string; body: unknown }>;

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		puts = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (init?.method === "PUT") {
					puts.push({
						url,
						body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
					});
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
		vi.restoreAllMocks();
	});

	async function mount() {
		await act(async () => {
			root.render(
				React.createElement(InlinePortableTextEditor, {
					value: structuredClone(storedBody),
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

	async function blur(editable: HTMLElement) {
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
	}

	it("does not save when focus leaves an unedited body", async () => {
		const editable = await mount();
		await blur(editable);
		await blur(editable);
		await blur(editable);
		expect(puts).toHaveLength(0);
	});

	it("does not save on page leave when the body was never touched", async () => {
		await mount();
		await act(async () => {
			window.dispatchEvent(new Event("pagehide"));
		});
		expect(puts).toHaveLength(0);
	});

	type TestEditor = {
		commands: { insertContentAt: (pos: number, text: string) => boolean; undo: () => boolean };
	};
	// The component does not expose its editor, and @tiptap/react has no
	// public way to reach it from the DOM, so this uses the instance Tiptap's
	// core attaches to its view's root element (`view.dom.editor`). The
	// alternative, synthesizing input events for ProseMirror in jsdom, is less
	// reliable than the internal it would avoid.
	function editorOf(editable: HTMLElement): TestEditor {
		const editor = (editable as HTMLElement & { editor?: TestEditor }).editor;
		expect(editor).toBeDefined();
		return editor!;
	}

	it("saves a real edit once, and not again on the next blur", async () => {
		const editable = await mount();
		await act(async () => {
			editorOf(editable).commands.insertContentAt(1, "Edited. ");
		});

		await blur(editable);
		expect(puts).toHaveLength(1);
		expect(puts[0]!.url).toBe("/_emdash/api/content/posts/entry-1");

		await blur(editable);
		expect(puts).toHaveLength(1);
	});

	it("does not save an edit that was undone before focus left", async () => {
		const editable = await mount();
		await act(async () => {
			editorOf(editable).commands.insertContentAt(1, "Edited. ");
		});
		await act(async () => {
			editorOf(editable).commands.undo();
		});

		await blur(editable);
		expect(puts).toHaveLength(0);
	});
});
