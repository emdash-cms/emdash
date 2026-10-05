/**
 * BlockMenu component tests.
 *
 * Tests the floating block-level context menu that appears when clicking
 * a drag handle. Covers the main menu (Turn into, Duplicate, Move, Delete),
 * the "Turn into" submenu with block transforms, Escape to close,
 * and click-outside dismissal.
 *
 * BlockMenu is a standalone component that takes an editor instance,
 * an anchor element, and open/close callbacks. The drag handle selects the
 * block before opening it, so the tests do the same.
 */

import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { BlockMenu } from "../../src/components/editor/BlockMenu";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

import "../../src/styles.css";

// ---------------------------------------------------------------------------
// Mocks — same as other editor tests
// ---------------------------------------------------------------------------

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

vi.mock("../../src/components/editor/ImageNode", async () => {
	const { Node } = await import("@tiptap/core");
	const ImageExtension = Node.create({
		name: "image",
		group: "block",
		atom: true,
		addAttributes() {
			return {
				src: { default: null },
				alt: { default: "" },
				title: { default: "" },
				caption: { default: "" },
				mediaId: { default: null },
				provider: { default: "local" },
				width: { default: null },
				height: { default: null },
				displayWidth: { default: null },
				displayHeight: { default: null },
			};
		},
		parseHTML() {
			return [{ tag: "img[src]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["img", HTMLAttributes];
		},
	});
	return { ImageExtension };
});

vi.mock("../../src/components/editor/PluginBlockNode", async () => {
	const { Node } = await import("@tiptap/core");
	const PluginBlockExtension = Node.create({
		name: "pluginBlock",
		group: "block",
		atom: true,
		addAttributes() {
			return {
				blockType: { default: "embed" },
				id: { default: "" },
				data: { default: {} },
			};
		},
		parseHTML() {
			return [{ tag: "div[data-plugin-block]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["div", { ...HTMLAttributes, "data-plugin-block": "" }];
		},
	});
	return {
		PluginBlockExtension,
		getEmbedMeta: () => ({ label: "Embed", Icon: () => null }),
		registerPluginBlocks: () => {},
		resolveIcon: () => () => null,
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultValue = [
	{
		_type: "block" as const,
		_key: "1",
		style: "normal" as const,
		children: [{ _type: "span" as const, _key: "s1", text: "First paragraph" }],
	},
	{
		_type: "block" as const,
		_key: "2",
		style: "normal" as const,
		children: [{ _type: "span" as const, _key: "s2", text: "Second paragraph" }],
	},
];

/** Render the full editor to get a real TipTap Editor instance */
async function getEditor() {
	let editorInstance: Editor | null = null;

	await render(
		<PortableTextEditor
			value={defaultValue}
			onEditorReady={(editor) => {
				editorInstance = editor;
			}}
		/>,
	);

	await vi.waitFor(
		() => {
			expect(document.querySelector(".ProseMirror")).toBeTruthy();
			expect(editorInstance).toBeTruthy();
		},
		{ timeout: 3000 },
	);

	const pm = document.querySelector(".ProseMirror") as HTMLElement;
	return { editor: editorInstance!, pm };
}

/**
 * Wrapper component that renders BlockMenu with an anchor element.
 * This is needed because BlockMenu uses useFloating which needs a real DOM element.
 */
function BlockMenuTestWrapper({
	editor,
	isOpen,
	onClose,
}: {
	editor: Editor;
	isOpen: boolean;
	onClose: () => void;
}) {
	const anchorRef = React.useRef<HTMLDivElement>(null);

	return (
		<>
			<div ref={anchorRef} data-testid="anchor" style={{ width: 100, height: 20 }}>
				Anchor
			</div>
			<BlockMenu
				editor={editor}
				anchorElement={anchorRef.current}
				isOpen={isOpen}
				onClose={onClose}
			/>
		</>
	);
}

function ClosingBlockMenuTestWrapper({
	editor,
	onCloseComplete,
}: {
	editor: Editor;
	onCloseComplete: () => void;
}) {
	const [isOpen, setIsOpen] = React.useState(true);
	const anchorRef = React.useRef<HTMLDivElement>(null);

	return (
		<>
			<div ref={anchorRef}>Anchor</div>
			<button type="button">Outside menu</button>
			<BlockMenu
				editor={editor}
				anchorElement={anchorRef.current}
				isOpen={isOpen}
				onClose={() => setIsOpen(false)}
				onCloseComplete={onCloseComplete}
			/>
		</>
	);
}

/** Get the block menu popup */
function getBlockMenu(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[role="menu"][aria-label="Block actions"]');
}

/** Get the Turn into submenu popup, the other menu open beside the block menu */
function getTurnIntoMenu(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[role="menu"]:not([aria-label="Block actions"])');
}

/** Get all actionable items in the menu */
function getMenuItems(menu: HTMLElement): HTMLElement[] {
	return [
		...menu.querySelectorAll<HTMLElement>(
			'[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
		),
	];
}

function itemName(item: HTMLElement): string {
	return item.textContent?.trim() ?? "";
}

/** Find a menu item by its name */
function findButtonByText(menu: HTMLElement, text: string): HTMLElement | null {
	return getMenuItems(menu).find((item) => itemName(item) === text) ?? null;
}

async function openTurnInto(): Promise<HTMLElement> {
	await userEvent.hover(findButtonByText(getBlockMenu()!, "Turn into")!);
	await vi.waitFor(() => expect(getTurnIntoMenu()).toBeTruthy());
	return getTurnIntoMenu()!;
}

// =============================================================================
// BlockMenu — Main Menu
// =============================================================================

describe("BlockMenu", () => {
	it("renders nothing when isOpen is false", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={false} onClose={onClose} />);

		expect(getBlockMenu()).toBeNull();
	});

	it("renders main menu with Turn into, Duplicate, Delete when open", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			const menu = getBlockMenu();
			expect(menu).toBeTruthy();
		});

		const menu = getBlockMenu()!;
		expect(findButtonByText(menu, "Turn into")).toBeTruthy();
		expect(findButtonByText(menu, "Duplicate")).toBeTruthy();
		expect(findButtonByText(menu, "Delete")).toBeTruthy();
	});

	it("exposes block actions as an accessible menu", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		const items = getMenuItems(getBlockMenu()!);

		expect(items.map(itemName)).toEqual([
			"Turn into",
			"Align",
			"Duplicate",
			"Move up",
			"Move down",
			"Delete",
		]);
	});

	it("can't move the first block up or the last block down", async () => {
		const { editor } = await getEditor();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={vi.fn()} />);
		await vi.waitFor(() => expect(getBlockMenu()).toBeTruthy());

		expect(findButtonByText(getBlockMenu()!, "Move up")).toHaveAttribute("aria-disabled", "true");
		expect(findButtonByText(getBlockMenu()!, "Move down")).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);
	});

	it("moves the selected block down and keeps it selected", async () => {
		const { editor, pm } = await getEditor();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={vi.fn()} />);
		await vi.waitFor(() => expect(getBlockMenu()).toBeTruthy());
		findButtonByText(getBlockMenu()!, "Move down")!.click();

		await vi.waitFor(() => {
			expect(Array.from(pm.querySelectorAll("p"), (p) => p.textContent)).toEqual([
				"Second paragraph",
				"First paragraph",
			]);
		});
		expect(editor.state.selection.$from.nodeAfter?.textContent).toBe("First paragraph");
	});

	it("shows Turn into submenu when Turn into is clicked", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		const submenu = await openTurnInto();

		expect(getMenuItems(submenu).map(itemName)).toEqual([
			"Paragraph",
			"Heading 1",
			"Heading 2",
			"Heading 3",
			"Bullet List",
			"Numbered List",
			"Quote",
			"Code Block",
		]);
		expect(findButtonByText(submenu, "Paragraph")).toHaveAttribute("aria-checked", "true");
		expect(findButtonByText(submenu, "Heading 1")).toHaveAttribute("aria-checked", "false");
	});

	it("lists a deeper heading level only for a block that already uses it", async () => {
		const { editor } = await getEditor();
		editor.chain().setNodeSelection(0).setNode("heading", { level: 5 }).setNodeSelection(0).run();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={vi.fn()} />);
		await vi.waitFor(() => expect(getBlockMenu()).toBeTruthy());

		const submenu = await openTurnInto();

		expect(findButtonByText(submenu, "Heading 5")).toBeTruthy();
		expect(findButtonByText(submenu, "Heading 4")).toBeNull();
	});

	it("keeps a block's type when it is turned into the type it already has", async () => {
		const { editor } = await getEditor();
		editor.commands.setContent(
			"<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul><p>after</p>",
		);
		const before = editor.getJSON();
		editor.commands.setNodeSelection(0);
		const onClose = vi.fn();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);
		await vi.waitFor(() => expect(getBlockMenu()).toBeTruthy());
		findButtonByText(await openTurnInto(), "Bullet List")!.click();

		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(editor.getJSON()).toEqual(before);
	});

	it("turns every item of a selected list into another type and keeps it selected", async () => {
		const { editor } = await getEditor();
		editor.commands.setContent(
			"<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li><li><p>three</p></li></ul><p>after</p>",
		);
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={vi.fn()} />);
		await vi.waitFor(() => expect(getBlockMenu()).toBeTruthy());
		findButtonByText(await openTurnInto(), "Numbered List")!.click();

		await vi.waitFor(() => expect(editor.getHTML()).toContain("<ol"));
		const list = editor.state.doc.firstChild;
		expect(list?.type.name).toBe("orderedList");
		expect(list?.childCount).toBe(3);
		expect(list?.child(1).lastChild?.type.name).toBe("bulletList");
		const { selection } = editor.state;
		expect(selection).toBeInstanceOf(NodeSelection);
		expect(selection.from).toBe(0);
	});

	it("transforms block to heading when Heading 1 is selected", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.chain().focus().setNodeSelection(0).run();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(await openTurnInto(), "Heading 1")!.click();

		// Should close menu and transform block
		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("h1")).toBeTruthy();
		});
	});

	it("transforms block to blockquote", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.chain().focus().setNodeSelection(0).run();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(await openTurnInto(), "Quote")!.click();

		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("blockquote")).toBeTruthy();
		});
	});

	it("transforms block to code block", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.chain().focus().setNodeSelection(0).run();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(await openTurnInto(), "Code Block")!.click();

		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("pre")).toBeTruthy();
		});
	});

	it("transforms block to bullet list", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.chain().focus().setNodeSelection(0).run();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(await openTurnInto(), "Bullet List")!.click();

		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("ul")).toBeTruthy();
		});
	});

	it("deletes the current block when Delete is clicked", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		// Select the first block as the drag handle does before opening the menu
		editor.commands.setNodeSelection(0);

		// Count initial paragraphs
		const initialParagraphs = pm.querySelectorAll("p").length;

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Delete")!.click();

		expect(onClose).toHaveBeenCalled();

		// Should have one fewer paragraph
		await vi.waitFor(() => {
			const newParagraphs = pm.querySelectorAll("p").length;
			expect(newParagraphs).toBeLessThan(initialParagraphs);
		});
	});

	it("deletes a selected table when Delete is clicked", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.chain().focus("start").insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();

		let tablePos = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name !== "table") return true;
			tablePos = pos;
			return false;
		});
		expect(tablePos).toBeGreaterThanOrEqual(0);

		editor.commands.setNodeSelection(tablePos);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Delete")!.click();

		expect(onClose).toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(pm.querySelector("table")).toBeNull();
		});
	});

	it("duplicates the current block when Duplicate is clicked", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		// Select the first block as the drag handle does before opening the menu
		editor.commands.setNodeSelection(0);

		const initialParagraphs = pm.querySelectorAll("p").length;

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Duplicate")!.click();

		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			const newParagraphs = pm.querySelectorAll("p").length;
			expect(newParagraphs).toBe(initialParagraphs + 1);
		});
	});

	it("closes on Escape key", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		await userEvent.keyboard("{Escape}");

		expect(onClose).toHaveBeenCalled();
	});

	it("closes back into the editor on Tab", async () => {
		const { editor } = await getEditor();
		editor.commands.setNodeSelection(0);

		await render(<ClosingBlockMenuTestWrapper editor={editor} onCloseComplete={vi.fn()} />);
		await vi.waitFor(() => expect(getBlockMenu()).toBeTruthy());
		getBlockMenu()!.focus();

		await userEvent.keyboard("{Tab}");

		await vi.waitFor(() => expect(getBlockMenu()).toBeNull());
		expect(document.activeElement).toBe(editor.view.dom);
	});

	it("stays open when the pointer leaves a highlighted menu item", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		await userEvent.hover(findButtonByText(getBlockMenu()!, "Duplicate")!);
		await userEvent.hover(pm.querySelectorAll("p")[1]!);

		expect(onClose).not.toHaveBeenCalled();
		expect(getBlockMenu()).toBeTruthy();
	});

	it("closes when the user clicks outside the menu", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		await userEvent.click(pm.querySelectorAll("p")[1]!);

		expect(onClose).toHaveBeenCalled();
	});

	it("reports when the menu exit transition completes", async () => {
		const { editor } = await getEditor();
		const onCloseComplete = vi.fn();
		editor.commands.setNodeSelection(0);
		const screen = await render(
			<ClosingBlockMenuTestWrapper editor={editor} onCloseComplete={onCloseComplete} />,
		);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		await userEvent.click(screen.getByRole("button", { name: "Outside menu" }));

		await vi.waitFor(() => {
			expect(onCloseComplete).toHaveBeenCalledOnce();
		});
	});

	it("closes only the Turn into submenu on Escape", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();
		editor.commands.setNodeSelection(0);

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(await openTurnInto(), "Heading 1")!.focus();
		await userEvent.keyboard("{Escape}");

		await vi.waitFor(() => expect(getTurnIntoMenu()).toBeNull());
		expect(getBlockMenu()).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});
});
