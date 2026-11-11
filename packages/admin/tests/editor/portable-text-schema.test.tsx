import type { MarkType, NodeType, Schema } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { portableTextSchema } from "../../src/internal/portable-text";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

function describeAttrs(type: NodeType | MarkType) {
	return Object.entries(type.attrs).map(([name, attr]) => ({
		name,
		default: attr.hasDefault ? attr.default : "(required)",
	}));
}

function describeSchema(schema: Schema) {
	return {
		topNode: schema.topNodeType.name,
		nodes: Object.values(schema.nodes).map((type) => ({
			name: type.name,
			content: type.spec.content,
			group: type.spec.group,
			marks: type.spec.marks,
			inline: type.isInline,
			atom: type.isAtom,
			selectable: type.spec.selectable,
			draggable: type.spec.draggable,
			code: type.spec.code,
			whitespace: type.whitespace,
			defining: type.spec.defining,
			isolating: type.spec.isolating,
			tableRole: type.spec.tableRole,
			attrs: describeAttrs(type),
		})),
		marks: Object.values(schema.marks).map((type) => ({
			name: type.name,
			excludes: Object.values(schema.marks)
				.filter((other) => type.excludes(other))
				.map((other) => other.name),
			inclusive: type.spec.inclusive,
			spanning: type.spec.spanning,
			group: type.spec.group,
			attrs: describeAttrs(type),
		})),
	};
}

describe("editor schema", () => {
	it("is the shared Portable Text schema", async () => {
		let editor: Editor | null = null;
		await render(
			<PortableTextEditor
				onEditorReady={(ready) => {
					editor = ready;
				}}
			/>,
		);
		await vi.waitFor(() => expect(editor).toBeTruthy());

		expect(describeSchema(editor!.schema)).toEqual(describeSchema(portableTextSchema()));
	});
});
