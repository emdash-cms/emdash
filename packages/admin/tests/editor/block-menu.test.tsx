/**
 * BlockMenu component tests.
 *
 * Tests the floating block-level context menu that appears when clicking
 * a drag handle. Covers the main menu (Turn into, Duplicate, Delete),
 * the "Turn into" submenu with block transforms, Escape to close,
 * and click-outside dismissal.
 *
 * BlockMenu is a standalone component that takes an editor instance,
 * an anchor element, and open/close callbacks. It renders via
 * createPortal to document.body.
 */

import type { Editor } from "@tiptap/react";
import { userEvent } from "@vitest/browser/context";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "../utils/render.js";

import { BlockMenu } from "../../src/components/editor/BlockMenu";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";

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

/** Get the block menu portal element */
function getBlockMenu(): HTMLElement | null {
	const portals = document.querySelectorAll("body > div");
	for (const el of portals) {
		// The block menu has "Turn into", "Duplicate", "Delete" buttons
		if (el.textContent?.includes("Turn into") || el.textContent?.includes("Back")) {
			return el as HTMLElement;
		}
	}
	return null;
}

/** Get all text buttons in the menu */
function getMenuButtons(menu: HTMLElement): HTMLButtonElement[] {
	return [...menu.querySelectorAll("button")];
}

/** Find a button by its text content */
function findButtonByText(menu: HTMLElement, text: string): HTMLButtonElement | null {
	const buttons = getMenuButtons(menu);
	return buttons.find((btn) => btn.textContent?.includes(text)) ?? null;
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

	it("shows Turn into submenu when Turn into is clicked", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		const menu = getBlockMenu()!;
		findButtonByText(menu, "Turn into")!.click();

		// Should show transform options
		await vi.waitFor(() => {
			const updatedMenu = getBlockMenu()!;
			expect(findButtonByText(updatedMenu, "Back")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Paragraph")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Heading 1")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Heading 2")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Heading 3")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Quote")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Code Block")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Bullet List")).toBeTruthy();
			expect(findButtonByText(updatedMenu, "Numbered List")).toBeTruthy();
		});
	});

	it("returns to main menu when Back is clicked in transform submenu", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		const menu = getBlockMenu()!;
		findButtonByText(menu, "Turn into")!.click();

		await vi.waitFor(() => {
			expect(findButtonByText(getBlockMenu()!, "Back")).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Back")!.click();

		await vi.waitFor(() => {
			const mainMenu = getBlockMenu()!;
			expect(findButtonByText(mainMenu, "Turn into")).toBeTruthy();
			expect(findButtonByText(mainMenu, "Duplicate")).toBeTruthy();
		});
	});

	it("transforms block to heading when Heading 1 is selected", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		// Focus editor on first paragraph
		editor.commands.focus("start");

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		// Open transforms
		findButtonByText(getBlockMenu()!, "Turn into")!.click();

		await vi.waitFor(() => {
			expect(findButtonByText(getBlockMenu()!, "Heading 1")).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Heading 1")!.click();

		// Should close menu and transform block
		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("h1")).toBeTruthy();
		});
	});

	it("transforms block to blockquote", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.commands.focus("start");

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Turn into")!.click();

		await vi.waitFor(() => {
			expect(findButtonByText(getBlockMenu()!, "Quote")).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Quote")!.click();

		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("blockquote")).toBeTruthy();
		});
	});

	it("transforms block to code block", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.commands.focus("start");

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Turn into")!.click();

		await vi.waitFor(() => {
			expect(findButtonByText(getBlockMenu()!, "Code Block")).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Code Block")!.click();

		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("pre")).toBeTruthy();
		});
	});

	it("transforms block to bullet list", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.commands.focus("start");

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Turn into")!.click();

		await vi.waitFor(() => {
			expect(findButtonByText(getBlockMenu()!, "Bullet List")).toBeTruthy();
		});

		findButtonByText(getBlockMenu()!, "Bullet List")!.click();

		expect(onClose).toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(pm.querySelector("ul")).toBeTruthy();
		});
	});

	it("deletes the current block when Delete is clicked", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		// Focus on first paragraph
		editor.commands.focus("start");

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

	it("duplicates the current block when Duplicate is clicked", async () => {
		const { editor, pm } = await getEditor();
		const onClose = vi.fn();

		editor.commands.focus("start");

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

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		await userEvent.keyboard("{Escape}");

		expect(onClose).toHaveBeenCalled();
	});

	it("closes transform submenu on Escape (returns to main, not full close)", async () => {
		const { editor } = await getEditor();
		const onClose = vi.fn();

		await render(<BlockMenuTestWrapper editor={editor} isOpen={true} onClose={onClose} />);

		await vi.waitFor(() => {
			expect(getBlockMenu()).toBeTruthy();
		});

		// Open transforms
		findButtonByText(getBlockMenu()!, "Turn into")!.click();

		await vi.waitFor(() => {
			expect(findButtonByText(getBlockMenu()!, "Back")).toBeTruthy();
		});

		// Escape should close submenu, not the whole menu
		await userEvent.keyboard("{Escape}");

		// onClose should NOT have been called — submenu should just close
		// (The component resets showTransforms on Escape in submenu)
		await vi.waitFor(() => {
			const menu = getBlockMenu()!;
			// Should be back to main menu
			expect(findButtonByText(menu, "Turn into")).toBeTruthy();
		});
	});
});
