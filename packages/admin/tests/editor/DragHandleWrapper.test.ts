import { Editor } from "@tiptap/core";
import { DragHandlePlugin, normalizeNestedOptions } from "@tiptap/extension-drag-handle";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { _getDragHandlePlacement } from "../../src/components/editor/DragHandleWrapper";

describe("DragHandleWrapper", () => {
	it("places controls at the admin UI's logical start edge", () => {
		expect(_getDragHandlePlacement("ltr")).toBe("left-start");
		expect(_getDragHandlePlacement("rtl")).toBe("right-start");
	});

	it("locks the real drag plugin through core transaction metadata", () => {
		const host = document.createElement("div");
		const editorElement = document.createElement("div");
		const dragElement = document.createElement("div");
		host.append(editorElement);
		document.body.append(host);
		const editor = new Editor({
			element: editorElement,
			extensions: [StarterKit],
			content: "<p>Test</p>",
		});
		const dragPlugin = DragHandlePlugin({
			editor,
			element: dragElement,
			nestedOptions: normalizeNestedOptions(false),
		});

		try {
			editor.registerPlugin(dragPlugin.plugin);
			expect(dragElement.draggable).toBe(true);

			editor.commands.setMeta("lockDragHandle", true);
			expect(dragElement.draggable).toBe(false);

			editor.commands.setMeta("lockDragHandle", false);
			expect(dragElement.draggable).toBe(true);
		} finally {
			dragPlugin.unbind();
			editor.destroy();
			host.remove();
		}
	});
});
