import type { Editor } from "@tiptap/core";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { DragHandleWrapper } from "../../src/components/editor/DragHandleWrapper";
import { render } from "../utils/render";

vi.mock("@tiptap/extension-drag-handle-react", () => ({
	DragHandle: ({ children }: { children: React.ReactNode }) => (
		<div draggable="true">{children}</div>
	),
}));

vi.mock("../../src/components/editor/BlockMenu", () => ({
	BlockMenu: () => null,
}));

describe("DragHandleWrapper interactions", () => {
	it("prevents the insert button from starting a native block drag", async () => {
		const editorElement = document.createElement("div");
		const editor = {
			view: { dom: editorElement },
		} as unknown as Editor;
		const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
		const insertButton = screen.getByRole("button", { name: "Insert block below" }).element();
		const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

		insertButton.dispatchEvent(mouseDown);

		expect(mouseDown.defaultPrevented).toBe(true);
	});
});
