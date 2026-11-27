// @vitest-environment jsdom

import type { PortableTextBlock } from "@emdash-cms/admin/internal/portable-text";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InlinePortableTextEditor } from "../../../src/components/InlinePortableTextEditor.js";
import { editorFixtures } from "../../utils/admin-portable-text-round-trip.js";
import { destroyInlineEditors, loadInline, saveInline } from "../../utils/inline-portable-text.js";

const table = editorFixtures
	.find((fixture) => fixture.name.startsWith("table with a header row"))!
	.blocks.find((block) => block._type === "table")!;

const paragraph = (key: string, text: string): PortableTextBlock => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
});

const elements: HTMLElement[] = [];
const roots: Root[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) root.unmount();
	for (const element of elements.splice(0)) element.remove();
	destroyInlineEditors();
});

/** Each row's cells, as whether the cell is a header and its text. */
function cellTexts(block: PortableTextBlock) {
	const { rows } = block as {
		rows: Array<{ cells: Array<{ isHeader?: boolean; content: Array<{ text: string }> }> }>;
	};
	return rows.map((row) =>
		row.cells.map((cell) => [
			cell.isHeader ?? false,
			cell.content.map((span) => span.text).join(""),
		]),
	);
}

function tablePosition(editor: ReturnType<typeof loadInline>): number {
	let position = -1;
	editor.state.doc.forEach((node, offset) => {
		if (node.type.name === "table") position = offset;
	});
	return position;
}

describe("inline editor tables", () => {
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

	it("shows a table as a read-only placeholder without its cells", () => {
		const editor = loadInline([table]);

		const placeholder = editor.view.dom.querySelector("[data-emdash-table-block]");
		expect(placeholder?.textContent).toBe("Table (edit in admin)");
		expect(placeholder?.getAttribute("contenteditable")).toBe("false");
		expect(editor.view.dom.querySelector("td, th")).toBeNull();
	});

	it("saves a table unchanged after an edit beside it", () => {
		const editor = loadInline([paragraph("before", "Before"), table, paragraph("after", "After")]);

		editor.commands.insertContentAt(1, "Edited ");

		const saved = saveInline(editor);
		expect(saved[1]).toEqual(table);
		expect(saved).toHaveLength(3);
	});

	it("selects a table as one block from the line after it, never a cell it doesn't show", () => {
		const editor = loadInline([table, paragraph("after", "After")]);
		const afterTable = tablePosition(editor) + editor.state.doc.child(0).nodeSize;

		const found = Selection.findFrom(editor.state.doc.resolve(afterTable), -1);

		expect(found).toBeInstanceOf(NodeSelection);
		expect((found as NodeSelection).node.type.name).toBe("table");
	});

	it("keeps the whole table when it's cut and pasted elsewhere", () => {
		const editor = loadInline([table, paragraph("after", "After")]);
		const { view } = editor;
		view.dispatch(
			view.state.tr.setSelection(NodeSelection.create(view.state.doc, tablePosition(editor))),
		);
		const { dom } = view.serializeForClipboard(view.state.selection.content());
		editor.commands.deleteSelection();
		expect(tablePosition(editor)).toBe(-1);

		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		view.pasteHTML(dom.innerHTML, new Event("paste") as ClipboardEvent);

		const pasted = saveInline(editor).find((block) => block._type === "table");
		expect(pasted && cellTexts(pasted)).toEqual(cellTexts(table));
	});
});
