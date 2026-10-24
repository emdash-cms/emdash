import { i18n } from "@lingui/core";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { DragHandleWrapper } from "../../src/components/editor/DragHandleWrapper";

import "../../dist/styles.css";
import { render } from "../utils/render";

type NodeChangeHandler = (data: { node: PMNode | null; editor: Editor; pos: number }) => void;

let dragHandleLocked = false;
let dragHandleNodeChange: NodeChangeHandler | null = null;
let moveDragHandle: ((pos: number) => void) | null = null;
let closeBlockMenu: (() => void) | null = null;
let completeBlockMenuExit: (() => void) | null = null;

async function hoverBlock(editor: Editor, node: PMNode, pos: number) {
	await React.act(async () => {
		if (dragHandleLocked) return;
		moveDragHandle?.(pos);
		dragHandleNodeChange?.({ node, editor, pos });
	});
}

vi.mock("@tiptap/extension-drag-handle-react", () => ({
	DragHandle: ({
		children,
		computePositionConfig,
		onNodeChange,
	}: {
		children: React.ReactNode;
		computePositionConfig: {
			placement: string;
			middleware?: Array<{ name: string; options?: [number?] }>;
		};
		onNodeChange: NodeChangeHandler;
	}) => {
		const [nodePosition, setNodePosition] = React.useState<number | null>(null);

		React.useEffect(() => {
			dragHandleLocked = false;
			dragHandleNodeChange = onNodeChange;
			moveDragHandle = setNodePosition;

			return () => {
				dragHandleNodeChange = null;
				moveDragHandle = null;
			};
		}, [onNodeChange]);

		return (
			<div
				className="drag-handle"
				draggable={!dragHandleLocked}
				data-node-position={nodePosition ?? ""}
				data-placement={computePositionConfig.placement}
				data-offset={
					computePositionConfig.middleware?.find(({ name }) => name === "offset")?.options?.[0] ??
					""
				}
			>
				{children}
			</div>
		);
	},
}));

vi.mock("../../src/components/editor/BlockMenu", () => ({
	BlockMenu: ({
		anchorElement,
		isOpen,
		onClose,
		onCloseComplete,
	}: {
		anchorElement: HTMLElement | null;
		isOpen: boolean;
		onClose: () => void;
		onCloseComplete?: () => void;
	}) => {
		closeBlockMenu = onClose;
		completeBlockMenuExit = onCloseComplete ?? null;
		return isOpen ? (
			<div
				role="menu"
				data-anchor-position={anchorElement?.closest(".drag-handle")?.dataset.nodePosition}
			/>
		) : null;
	},
}));

describe("DragHandleWrapper interactions", () => {
	beforeEach(() => {
		dragHandleLocked = false;
		dragHandleNodeChange = null;
		moveDragHandle = null;
		closeBlockMenu = null;
		completeBlockMenuExit = null;
	});

	it("uses Kumo buttons for both drag-handle controls", async () => {
		const editor = {
			view: { dom: document.createElement("div"), nodeDOM: () => null },
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

	it("keeps the handle in place while the pointer is on +, so a key press can't hide it", async () => {
		const locks: boolean[] = [];
		const editor = {
			view: { dom: document.createElement("div"), nodeDOM: () => null },
			commands: {
				setMeta: (_key: string, locked: boolean) => {
					locks.push(locked);
					return true;
				},
			},
		} as unknown as Editor;
		const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
		const insertButton = screen.getByRole("button", { name: "Insert block below" });

		await userEvent.hover(insertButton);
		expect(locks.at(-1)).toBe(true);

		await userEvent.unhover(insertButton);
		expect(locks.at(-1)).toBe(false);
	});

	it("disables native block dragging while pressing the insert button", async () => {
		const editorElement = document.createElement("div");
		const setMeta = vi.fn((_key: string, locked: boolean) => {
			const dragHandle = document.querySelector<HTMLElement>(".drag-handle");
			if (dragHandle) dragHandle.draggable = !locked;
			return true;
		});
		const editor = {
			view: { dom: editorElement, nodeDOM: () => null },
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
			view: { dom: editorElement, nodeDOM: () => null },
		} as unknown as Editor;

		try {
			const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
			const insertButton = screen.getByRole("button", { name: "Insert block below" }).element();
			expect(insertButton.closest("[data-placement]")?.getAttribute("data-placement")).toBe(
				"left-start",
			);
			expect(insertButton.closest("[data-offset]")?.getAttribute("data-offset")).toBe("4");

			i18n.activate("ar");
			document.documentElement.dir = "rtl";
			await vi.waitFor(() => {
				expect(insertButton.closest("[data-placement]")?.getAttribute("data-placement")).toBe(
					"right-start",
				);
			});
			// Mirrored, so + stays outermost and the grip stays beside the text.
			const grip = screen
				.getByRole("button", { name: "Block actions - drag to reorder, click for menu" })
				.element();
			expect(insertButton.getBoundingClientRect().left).toBeGreaterThan(
				grip.getBoundingClientRect().left,
			);
		} finally {
			document.documentElement.dir = "";
			i18n.activate(previousLocale);
		}
	});

	it("centers the handle on a code block's header row rather than its first line of code", async () => {
		const block = document.createElement("div");
		block.className = "node-codeBlock";
		block.style.position = "relative";
		block.innerHTML =
			'<pre class="emdash-code-block" style="margin: 0; padding-top: 36px; line-height: 20px">code</pre>' +
			'<div class="emdash-code-block-controls" style="position: absolute; top: 4px; height: 28px"></div>';
		document.body.append(block);
		const editor = {
			view: { dom: document.createElement("div"), nodeDOM: () => block },
		} as unknown as Editor;

		try {
			const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
			await hoverBlock(editor, {} as PMNode, 0);

			// The handle is placed at the block's top, so compare offsets from each one's top.
			const insertButton = screen.getByRole("button", { name: "Insert block below" }).element();
			const handleTop = insertButton.closest(".drag-handle")!.getBoundingClientRect().top;
			const handle = insertButton.getBoundingClientRect();
			const row = block.querySelector(".emdash-code-block-controls")!.getBoundingClientRect();
			const blockTop = block.getBoundingClientRect().top;
			expect(handle.top + handle.height / 2 - handleTop).toBeCloseTo(
				row.top + row.height / 2 - blockTop,
				0,
			);
		} finally {
			block.remove();
		}
	});

	it("keeps the controls and menu pinned to the block that opened the menu", async () => {
		const selectedPositions: number[] = [];
		const setMeta = vi.fn((_key: string, locked: boolean) => {
			dragHandleLocked = locked;
			return true;
		});
		const editor = {
			view: { dom: document.createElement("div"), nodeDOM: () => null },
			commands: { setMeta },
			chain: () => ({
				setNodeSelection(pos: number) {
					selectedPositions.push(pos);
					return this;
				},
				run: () => true,
			}),
		} as unknown as Editor;
		const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
		const firstNode = { nodeSize: 2 } as PMNode;
		const secondNode = { nodeSize: 3 } as PMNode;

		await hoverBlock(editor, firstNode, 1);
		const actionsButton = screen.getByRole("button", {
			name: "Block actions - drag to reorder, click for menu",
		});
		await expect.element(actionsButton).toBeVisible();
		actionsButton.element().click();

		await vi.waitFor(() => {
			expect(screen.getByRole("menu").element().dataset.anchorPosition).toBe("1");
		});
		expect(selectedPositions).toEqual([1]);
		expect(setMeta).toHaveBeenLastCalledWith("lockDragHandle", true);

		await hoverBlock(editor, secondNode, 5);

		expect(screen.getByRole("menu").element().dataset.anchorPosition).toBe("1");
		expect(
			actionsButton.element().closest(".drag-handle")?.getAttribute("data-node-position"),
		).toBe("1");
		expect(selectedPositions).toEqual([1]);
	});

	it("keeps the drag handle pinned until the menu exit completes", async () => {
		const setMeta = vi.fn((_key: string, locked: boolean) => {
			dragHandleLocked = locked;
			return true;
		});
		const editor = {
			view: { dom: document.createElement("div"), nodeDOM: () => null },
			commands: { setMeta },
			chain: () => ({
				setNodeSelection() {
					return this;
				},
				run: () => true,
			}),
		} as unknown as Editor;
		const screen = await render(<DragHandleWrapper editor={editor} onInsertBlock={vi.fn()} />);
		const actionsButton = screen.getByRole("button", {
			name: "Block actions - drag to reorder, click for menu",
		});
		const firstNode = { nodeSize: 2 } as PMNode;
		const secondNode = { nodeSize: 3 } as PMNode;

		await hoverBlock(editor, firstNode, 1);
		actionsButton.element().click();
		await vi.waitFor(() => {
			expect(screen.getByRole("menu").element().dataset.anchorPosition).toBe("1");
		});

		await React.act(async () => closeBlockMenu?.());
		await expect.element(actionsButton).toHaveAttribute("aria-expanded", "false");
		expect(setMeta).toHaveBeenLastCalledWith("lockDragHandle", true);

		await hoverBlock(editor, secondNode, 5);
		expect(
			actionsButton.element().closest(".drag-handle")?.getAttribute("data-node-position"),
		).toBe("1");

		await React.act(async () => completeBlockMenuExit?.());
		expect(setMeta).toHaveBeenLastCalledWith("lockDragHandle", false);

		await hoverBlock(editor, secondNode, 5);
		expect(
			actionsButton.element().closest(".drag-handle")?.getAttribute("data-node-position"),
		).toBe("5");
	});
});
