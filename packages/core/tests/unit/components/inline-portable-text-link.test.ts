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
		_key: "link-block",
		style: "normal" as const,
		markDefs: [],
		children: [{ _type: "span" as const, _key: "link-span", text: "Selected text.", marks: [] }],
	},
];

type PortableTextValue = React.ComponentProps<typeof InlinePortableTextEditor>["value"];

describe("inline Portable Text editor link serialization", () => {
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

	async function mount(value: PortableTextValue = storedBody) {
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

	async function blur(editable: HTMLElement) {
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
	}

	type TestEditor = {
		commands: {
			selectAll: () => boolean;
			setLink: (attrs: { href: string }) => boolean;
		};
	};

	function editorOf(editable: HTMLElement): TestEditor {
		const editor = (editable as HTMLElement & { editor?: TestEditor }).editor;
		expect(editor).toBeDefined();
		return editor!;
	}

	it("does not save text links with blank:true when authors have no new-tab control (regression #4105)", async () => {
		const editable = await mount();
		const editor = editorOf(editable);

		await act(async () => {
			editor.commands.selectAll();
			editor.commands.setLink({ href: "/about" });
		});

		await blur(editable);
		expect(puts).toHaveLength(1);

		const body = puts[0]!.body as {
			data: {
				body: Array<{
					_type: string;
					markDefs?: Array<{ _type: string; _key: string; href?: string; blank?: boolean }>;
				}>;
			};
		};
		const block = body.data.body.find((b) => b._type === "block");
		expect(block).toBeDefined();
		const linkDef = block!.markDefs?.find((m) => m._type === "link");
		expect(linkDef).toMatchObject({ _type: "link", href: "/about" });
		expect(linkDef).not.toMatchObject({ blank: true });
	});
});
