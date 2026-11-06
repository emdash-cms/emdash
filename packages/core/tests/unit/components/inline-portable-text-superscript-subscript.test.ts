// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const storedBody = [
	{
		_type: "block" as const,
		_key: "blk1",
		style: "normal" as const,
		markDefs: [{ _type: "link" as const, _key: "fn1link", href: "#fn-1" }],
		children: [
			{ _type: "span" as const, _key: "s1", text: "This claim has a footnote marker", marks: [] },
			{ _type: "span" as const, _key: "s2", text: "1", marks: ["superscript", "fn1link"] },
			{ _type: "span" as const, _key: "s3", text: " and here is a plain ordinal", marks: [] },
			{ _type: "span" as const, _key: "s4", text: "2", marks: ["superscript"] },
			{ _type: "span" as const, _key: "s5", text: " and a subscript value H", marks: [] },
			{ _type: "span" as const, _key: "s6", text: "2", marks: ["subscript"] },
			{ _type: "span" as const, _key: "s7", text: "O for good measure.", marks: [] },
		],
	},
];

type PortableTextValue = React.ComponentProps<typeof InlinePortableTextEditor>["value"];

describe("inline Portable Text editor superscript/subscript marks", () => {
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

	async function mountRaw(value: PortableTextValue = storedBody) {
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
	}

	async function mount(value: PortableTextValue = storedBody) {
		await mountRaw(value);
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

	type TestEditor = {
		commands: { insertContentAt: (pos: number, text: string) => boolean; undo: () => boolean };
	};

	function editorOf(editable: HTMLElement): TestEditor {
		const editor = (editable as HTMLElement & { editor?: TestEditor }).editor;
		expect(editor).toBeDefined();
		return editor!;
	}

	it("preserves superscript, subscript, and superscript-plus-link marks across a trivial edit save", async () => {
		const editable = await mount();
		await act(async () => {
			editorOf(editable).commands.insertContentAt(1, "EDITED. ");
		});

		await blur(editable);
		expect(puts).toHaveLength(1);

		const body = puts[0]!.body as {
			data: {
				body: Array<{
					_type: string;
					children: Array<{ text: string; marks?: string[] }>;
					markDefs?: Array<{ _type: string; _key: string; href?: string }>;
				}>;
			};
		};
		const block = body.data.body.find((b) => b._type === "block");
		expect(block).toBeDefined();

		const spans = block!.children;
		const superscriptLink = spans.find((s) => s.text === "1");
		const superscriptPlain = spans.find((s) => s.text === "2");
		const subscriptPlain = spans.find((s) => s.text === "2" && s !== superscriptPlain);

		expect(superscriptLink).toBeDefined();
		expect(superscriptLink!.marks).toEqual(expect.arrayContaining(["superscript"]));
		const linkRef = superscriptLink!.marks?.find((m) => m !== "superscript" && m !== "subscript");
		expect(linkRef).toBeDefined();
		const linkDef = block!.markDefs?.find((m) => m._key === linkRef);
		expect(linkDef).toMatchObject({ _type: "link", href: "#fn-1" });

		expect(superscriptPlain).toBeDefined();
		expect(superscriptPlain!.marks).toEqual(["superscript"]);

		expect(subscriptPlain).toBeDefined();
		expect(subscriptPlain!.marks).toEqual(["subscript"]);
	});

	it("renders an error message instead of a blank editor when content contains unsupported marks", async () => {
		const badValue: PortableTextValue = [
			{
				_type: "block",
				_key: "bad1",
				style: "normal",
				children: [{ _type: "span", _key: "s1", text: "unsupported mark", marks: ["highlight"] }],
			},
		];
		await mountRaw(badValue);

		expect(container.querySelector(".ProseMirror")).toBeNull();
		const error = container.querySelector(".emdash-inline-editor-error");
		expect(error).not.toBeNull();
		expect(error!.textContent).toContain("highlight");
	});

	it("exposes superscript and subscript toggle commands from the registered extensions", async () => {
		const editable = await mount();
		const editor = editorOf(editable) as unknown as {
			commands: {
				selectAll: () => boolean;
				toggleSuperscript: () => boolean;
				toggleSubscript: () => boolean;
			};
			isActive: (name: string) => boolean;
		};

		await act(async () => {
			editor.commands.selectAll();
			editor.commands.toggleSuperscript();
		});
		expect(editor.isActive("superscript")).toBe(true);

		await act(async () => {
			editor.commands.selectAll();
			editor.commands.toggleSuperscript();
		});
		expect(editor.isActive("superscript")).toBe(false);

		await act(async () => {
			editor.commands.selectAll();
			editor.commands.toggleSubscript();
		});
		expect(editor.isActive("subscript")).toBe(true);

		await act(async () => {
			editor.commands.selectAll();
			editor.commands.toggleSubscript();
		});
		expect(editor.isActive("subscript")).toBe(false);
	});

	it("surfaces a save error when the document contains unsupported ProseMirror marks", async () => {
		const editable = await mount();
		const editor = editorOf(editable) as unknown as {
			commands: { insertContentAt: (pos: number, text: string) => boolean };
			getJSON: () => unknown;
		};

		await act(async () => {
			editor.commands.insertContentAt(1, "EDITED. ");
		});

		await act(async () => {
			vi.spyOn(editor, "getJSON").mockReturnValue({
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "bad", marks: [{ type: "highlight" }] }],
					},
				],
			});
		});

		const saveStates: unknown[] = [];
		const onSave = (event: Event) => {
			if (event instanceof CustomEvent) saveStates.push(event.detail?.state);
		};
		document.addEventListener("emdash:save", onSave);
		try {
			await blur(editable);
		} finally {
			document.removeEventListener("emdash:save", onSave);
		}

		expect(puts).toHaveLength(0);
		expect(saveStates).toEqual(["error"]);
		const error = container.querySelector(".emdash-inline-editor-error");
		expect(error).not.toBeNull();
		expect(error!.textContent).toContain("highlight");
	});
});
