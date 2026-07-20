import { i18n } from "@lingui/core";
import type { Editor } from "@tiptap/core";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { DragHandleWrapper } from "../../src/components/editor/DragHandleWrapper";
import { render } from "../utils/render";

vi.mock("@tiptap/extension-drag-handle-react", () => ({
	DragHandle: ({
		children,
		computePositionConfig,
	}: {
		children: React.ReactNode;
		computePositionConfig: {
			placement: string;
			middleware?: Array<{ name: string; options?: [number?] }>;
		};
	}) => (
		<div
			className="drag-handle"
			draggable="true"
			data-placement={computePositionConfig.placement}
			data-offset={
				computePositionConfig.middleware?.find(({ name }) => name === "offset")?.options?.[0] ?? ""
			}
		>
			{children}
		</div>
	),
}));

vi.mock("../../src/components/editor/BlockMenu", () => ({
	BlockMenu: () => null,
}));

describe("DragHandleWrapper interactions", () => {
	it("uses Kumo buttons for both drag-handle controls", async () => {
		const editor = {
			view: { dom: document.createElement("div") },
		} as unknown as Editor;
		const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);

		await expect
			.element(screen.getByRole("button", { name: "Insert block below" }))
			.toHaveAttribute("data-kumo-component", "Button");
		await expect
			.element(
				screen.getByRole("button", {
					name: "Block actions - drag to reorder, click for menu",
				}),
			)
			.toHaveAttribute("data-kumo-component", "Button");
	});

	it("disables native block dragging while pressing the insert button", async () => {
		const editorElement = document.createElement("div");
		const setMeta = vi.fn((_key: string, locked: boolean) => {
			const dragHandle = document.querySelector<HTMLElement>(".drag-handle");
			if (dragHandle) dragHandle.draggable = !locked;
			return true;
		});
		const editor = {
			view: { dom: editorElement },
			commands: { setMeta },
		} as unknown as Editor;
		const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
		const insertButton = screen.getByRole("button", { name: "Insert block below" }).element();
		const dragHandle = insertButton.closest<HTMLElement>(".drag-handle");
		expect(dragHandle).not.toBe(insertButton);
		expect(dragHandle?.draggable).toBe(true);

		insertButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(setMeta).toHaveBeenLastCalledWith("lockDragHandle", true);
		expect(dragHandle?.draggable).toBe(false);

		window.dispatchEvent(new PointerEvent("pointerup"));
		expect(setMeta).toHaveBeenLastCalledWith("lockDragHandle", false);
		expect(dragHandle?.draggable).toBe(true);
	});

	it("places and orders controls from the admin UI direction", async () => {
		const previousLocale = i18n.locale;
		i18n.load("ar", {});
		i18n.load("en", {});
		i18n.activate("en");
		const editorElement = document.createElement("div");
		editorElement.dir = "ltr";
		const editor = {
			view: { dom: editorElement },
		} as unknown as Editor;

		try {
			const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
			const insertButton = screen.getByRole("button", { name: "Insert block below" }).element();
			expect(insertButton.closest("[data-placement]")?.getAttribute("data-placement")).toBe(
				"left-start",
			);
			expect(insertButton.closest("[data-offset]")?.getAttribute("data-offset")).toBe("4");

			i18n.activate("ar");
			await vi.waitFor(() => {
				expect(insertButton.closest("[data-placement]")?.getAttribute("data-placement")).toBe(
					"right-start",
				);
			});
			expect(insertButton.parentElement?.className).toContain("rtl:flex-row-reverse");
		} finally {
			i18n.activate(previousLocale);
		}
	});
});
