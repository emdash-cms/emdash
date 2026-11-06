// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	InlinePortableTextEditor,
	_InlineTableBlockNode as InlineTableBlockNode,
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

const table = {
	_type: "table",
	_key: "table-original",
	hasHeaderRow: true,
	rows: [
		{
			_type: "tableRow",
			_key: "row-header",
			cells: [
				{
					_type: "tableCell",
					_key: "cell-header",
					isHeader: true,
					content: [{ _type: "span", _key: "span-header", text: "Name" }],
				},
			],
		},
		{
			_type: "tableRow",
			_key: "row-body",
			cells: [
				{
					_type: "tableCell",
					_key: "cell-body",
					colwidth: [192],
					textAlign: "right",
					content: [{ _type: "span", _key: "span-body", text: "EmDash", marks: ["strong"] }],
				},
			],
		},
	],
};

const editors: Editor[] = [];
const elements: HTMLElement[] = [];
const roots: Root[] = [];

function createEditor(content: JSONContent): Editor {
	const element = document.createElement("div");
	document.body.append(element);
	elements.push(element);
	const editor = new Editor({
		element,
		extensions: [StarterKit, InlineTableBlockNode],
		content,
	});
	editors.push(editor);
	return editor;
}

afterEach(() => {
	for (const root of roots.splice(0)) root.unmount();
	for (const editor of editors.splice(0)) editor.destroy();
	for (const element of elements.splice(0)) element.remove();
});

describe("inline editor table preservation", () => {
	it("keeps table labels local to each editor", async () => {
		const element = document.body.appendChild(document.createElement("div"));
		elements.push(element);
		const root = createRoot(element);
		roots.push(root);
		const labels = ["Table (edit in admin)", "جدول (التحرير في لوحة الإدارة)"];
		const props = { value: [table], collection: "posts", entryId: "post-1", field: "body" };
		root.render(
			[undefined, labels[1]].map((tablePlaceholder, key) =>
				createElement(InlinePortableTextEditor, { ...props, key, tablePlaceholder }),
			),
		);
		await vi.waitFor(() => {
			const nodes = element.querySelectorAll("[data-emdash-table-block]");
			expect(Array.from(nodes, (node) => node.textContent)).toEqual(labels);
		});
	});

	it("keeps the raw table when cutting its opaque placeholder", () => {
		const editor = createEditor(portableTextToPM([table]));
		editor.commands.setNodeSelection(0);
		const before = editor.getJSON();
		const cut = new Event("cut", { bubbles: true, cancelable: true });
		Object.defineProperty(cut, "clipboardData", {
			value: { clearData() {}, setData() {} },
		});
		editor.view.dom.dispatchEvent(cut);
		expect(editor.getJSON()).toEqual(before);
	});

	it("stores the complete table in one opaque ProseMirror node", () => {
		const document = portableTextToPM([table]);
		const node = document.content?.[0];

		expect(node?.type).toBe("table");
		expect(node?.attrs).toEqual({ rawTable: table });
		expect(node?.attrs).not.toHaveProperty("id");
	});

	it("preserves the table payload and structural keys exactly across a round trip", () => {
		const roundTripped = pmToPortableText(portableTextToPM([table]));

		expect(roundTripped).toEqual([table]);
	});

	it("survives schema loading, an adjacent edit, and editor serialization", () => {
		const content = portableTextToPM([
			{
				_type: "block",
				_key: "before",
				style: "normal",
				children: [{ _type: "span", _key: "before-span", text: "Before" }],
			},
			table,
			{
				_type: "block",
				_key: "after",
				style: "normal",
				children: [{ _type: "span", _key: "after-span", text: "After" }],
			},
		]);
		const editor = createEditor(content);

		editor.commands.insertContentAt(1, "Edited ");

		const tableNode = editor.getJSON().content?.find((node) => node.type === "table");
		const serializedTable = pmToPortableText(editor.getJSON()).find(
			(block) => block._type === "table",
		);
		expect(tableNode?.attrs?.rawTable).toEqual(table);
		expect(serializedTable).toEqual(table);
	});

	it("rejects a pasted rendered placeholder that has no raw table payload", () => {
		const source = createEditor(portableTextToPM([table]));
		const placeholder = source.view.dom.querySelector<HTMLElement>(
			'[data-emdash-table-block="true"]',
		);
		expect(placeholder).not.toBeNull();

		const target = createEditor({
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Keep" }] }],
		});
		target.commands.setTextSelection(5);
		const clipboardData = {
			files: [],
			items: [],
			types: ["text/html", "text/plain"],
			getData: (type: string) => {
				if (type === "text/html") return placeholder?.outerHTML ?? "";
				if (type === "text/plain") return "Table (edit in admin)";
				return "";
			},
		};
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: clipboardData });

		target.view.dom.dispatchEvent(paste);

		expect(paste.defaultPrevented).toBe(true);
		expect(target.getText()).toBe("Keep");
		expect(target.getJSON().content?.some((node) => node.type === "table")).toBe(false);
		expect(pmToPortableText(target.getJSON()).some((block) => block._type === "table")).toBe(false);
	});
});
