/**
 * Slash command menu tests.
 *
 * Tests the "/" trigger, command filtering, keyboard navigation,
 * command execution, and menu dismissal via Escape.
 *
 * The slash menu is internal to PortableTextEditor and driven by
 * TipTap's Suggestion plugin. We test it through the full editor
 * since there's no standalone export.
 */

import type { Editor } from "@tiptap/react";
import { userEvent } from "@vitest/browser/context";
import { describe, it, expect, vi } from "vitest";
import { render } from "../utils/render.js";

import type { PortableTextEditorProps } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";

// ---------------------------------------------------------------------------
// Mocks
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
	const embedMeta: Record<string, { label: string }> = {
		youtube: { label: "YouTube Video" },
		vimeo: { label: "Vimeo" },
		tweet: { label: "Tweet" },
	};
	return {
		PluginBlockExtension,
		getEmbedMeta: (type: string) => ({
			label: embedMeta[type]?.label ?? "Embed",
			Icon: () => null,
		}),
		registerPluginBlocks: () => {},
		resolveIcon: () => () => null,
	};
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WHITESPACE_SPLIT_REGEX = /\s+/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the editor, wait for TipTap, return editor instance + ProseMirror element */
async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editorInstance: Editor | null = null;

	const screen = await render(
		<PortableTextEditor
			onEditorReady={(editor) => {
				editorInstance = editor;
			}}
			{...props}
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
	return { screen, editor: editorInstance!, pm };
}

/** Focus the editor */
async function focusEditor(pm: HTMLElement) {
	pm.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(pm), { timeout: 1000 });
}

/** Get the slash menu portal element from document.body */
function getSlashMenu(): HTMLElement | null {
	const portals = document.querySelectorAll("body > div");
	for (const el of portals) {
		if (el.querySelector("[data-index]") || el.textContent?.includes("No results")) {
			return el as HTMLElement;
		}
	}
	return null;
}

/** Wait for the slash menu to appear */
async function waitForSlashMenu(): Promise<HTMLElement> {
	let menu: HTMLElement | null = null;
	await vi.waitFor(
		() => {
			menu = getSlashMenu();
			expect(menu).toBeTruthy();
		},
		{ timeout: 3000 },
	);
	return menu!;
}

/** Wait for the slash menu to disappear */
async function waitForSlashMenuClosed() {
	await vi.waitFor(
		() => {
			expect(getSlashMenu()).toBeNull();
		},
		{ timeout: 3000 },
	);
}

/** Get visible items in the slash menu */
function getSlashMenuItems(menu: HTMLElement): HTMLButtonElement[] {
	return [...menu.querySelectorAll("button[data-index]")];
}

/**
 * Check if an item is the selected/highlighted item.
 * Selected items use "bg-kumo-tint text-kumo-default" (space-separated).
 * Non-selected items use "hover:bg-kumo-tint/50".
 */
function isItemSelected(el: HTMLElement): boolean {
	// Split className by spaces and check for exact "bg-kumo-tint" token
	return el.className.split(WHITESPACE_SPLIT_REGEX).includes("bg-kumo-tint");
}

// =============================================================================
// Slash Command Menu
// =============================================================================

describe("Slash Command Menu", () => {
	it("opens when typing / at the start of an empty line", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);

		// Default commands: heading1-3, bullet/numbered list, quote, code block, divider, image, section
		expect(items.length).toBeGreaterThanOrEqual(8);
	});

	it("shows default block type commands", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");

		expect(titles).toContain("Heading 1");
		expect(titles).toContain("Heading 2");
		expect(titles).toContain("Heading 3");
		expect(titles).toContain("Bullet List");
		expect(titles).toContain("Numbered List");
		expect(titles).toContain("Quote");
		expect(titles).toContain("Code Block");
		expect(titles).toContain("Divider");
	});

	it("shows descriptions for each command", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);

		for (const item of items) {
			const description = item.querySelector(".text-xs");
			expect(description).toBeTruthy();
			expect(description!.textContent!.length).toBeGreaterThan(0);
		}
	});

	it("filters commands by query text", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		// Type filter text — Suggestion plugin watches text after "/"
		await userEvent.keyboard("head");

		await vi.waitFor(
			() => {
				const menu = getSlashMenu();
				expect(menu).toBeTruthy();
				const items = getSlashMenuItems(menu!);
				const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");
				expect(titles.length).toBeGreaterThanOrEqual(1);
				expect(titles.every((t) => t.toLowerCase().includes("heading"))).toBe(true);
			},
			{ timeout: 3000 },
		);
	});

	it("shows No results when no commands match", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("xyznonexistent");

		await vi.waitFor(
			() => {
				const menu = getSlashMenu();
				expect(menu).toBeTruthy();
				expect(menu!.textContent).toContain("No results");
			},
			{ timeout: 3000 },
		);
	});

	it("highlights the first item by default", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);

		expect(isItemSelected(items[0]!)).toBe(true);
	});

	it("moves selection down with ArrowDown", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("{ArrowDown}");

		await vi.waitFor(() => {
			const menu = getSlashMenu()!;
			const items = getSlashMenuItems(menu);
			expect(isItemSelected(items[1]!)).toBe(true);
			expect(isItemSelected(items[0]!)).toBe(false);
		});
	});

	it("moves selection up with ArrowUp from second item", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		// Move down, then back up
		await userEvent.keyboard("{ArrowDown}");
		await vi.waitFor(() => {
			const items = getSlashMenuItems(getSlashMenu()!);
			expect(isItemSelected(items[1]!)).toBe(true);
		});

		await userEvent.keyboard("{ArrowUp}");
		await vi.waitFor(() => {
			const items = getSlashMenuItems(getSlashMenu()!);
			expect(isItemSelected(items[0]!)).toBe(true);
		});
	});

	it("wraps selection around when pressing ArrowUp from first item", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("{ArrowUp}");

		await vi.waitFor(() => {
			const menu = getSlashMenu()!;
			const items = getSlashMenuItems(menu);
			const lastItem = items.at(-1)!;
			expect(isItemSelected(lastItem)).toBe(true);
		});
	});

	it("executes selected command on Enter and converts to heading", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		// First item is "Heading 1"
		await userEvent.keyboard("{Enter}");

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			expect(pm.querySelector("h1")).toBeTruthy();
		});
	});

	it("closes menu on Escape without executing", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("{Escape}");

		await waitForSlashMenuClosed();

		// Should still be a paragraph
		expect(pm.querySelector("h1")).toBeNull();
	});

	it("executes command when clicking an item", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const quoteBtn = items.find(
			(btn) => btn.querySelector(".font-medium")?.textContent === "Quote",
		);
		expect(quoteBtn).toBeTruthy();
		quoteBtn!.click();

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			expect(pm.querySelector("blockquote")).toBeTruthy();
		});
	});

	it("inserts a code block via slash command", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const codeBlockBtn = items.find(
			(btn) => btn.querySelector(".font-medium")?.textContent === "Code Block",
		);
		expect(codeBlockBtn).toBeTruthy();
		codeBlockBtn!.click();

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			expect(pm.querySelector("pre")).toBeTruthy();
		});
	});

	it("inserts a horizontal rule via slash command", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const dividerBtn = items.find(
			(btn) => btn.querySelector(".font-medium")?.textContent === "Divider",
		);
		expect(dividerBtn).toBeTruthy();
		dividerBtn!.click();

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			expect(pm.querySelector("hr")).toBeTruthy();
		});
	});

	it("inserts bullet list via slash command", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const bulletBtn = items.find(
			(btn) => btn.querySelector(".font-medium")?.textContent === "Bullet List",
		);
		expect(bulletBtn).toBeTruthy();
		bulletBtn!.click();

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			expect(pm.querySelector("ul")).toBeTruthy();
		});
	});

	it("inserts numbered list via slash command", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const numberedBtn = items.find(
			(btn) => btn.querySelector(".font-medium")?.textContent === "Numbered List",
		);
		expect(numberedBtn).toBeTruthy();
		numberedBtn!.click();

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			expect(pm.querySelector("ol")).toBeTruthy();
		});
	});

	it("highlights item on mouse hover", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);

		// React listens for pointerenter/mouseenter on the element.
		// Use userEvent.hover which properly dispatches pointer + mouse events.
		await userEvent.hover(items[2]!);

		await vi.waitFor(() => {
			const freshItems = getSlashMenuItems(menu);
			expect(isItemSelected(freshItems[2]!)).toBe(true);
		});
	});

	it("filters by alias (typing /h1 shows Heading 1)", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("h1");

		await vi.waitFor(
			() => {
				const menu = getSlashMenu();
				expect(menu).toBeTruthy();
				const items = getSlashMenuItems(menu!);
				expect(items.length).toBeGreaterThanOrEqual(1);
				const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");
				expect(titles).toContain("Heading 1");
			},
			{ timeout: 3000 },
		);
	});

	it("includes Image and Section commands", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");

		expect(titles).toContain("Image");
		expect(titles).toContain("Section");
	});

	it("prioritises title matches over description matches when filtering", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		// "sec" matches "Section" by title and headings by description ("section heading")
		await userEvent.keyboard("sec");

		await vi.waitFor(
			() => {
				const menu = getSlashMenu();
				expect(menu).toBeTruthy();
				const items = getSlashMenuItems(menu!);
				const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");
				expect(titles.length).toBeGreaterThan(1);
				expect(titles[0]).toBe("Section");
			},
			{ timeout: 3000 },
		);
	});

	it("includes plugin block commands when provided", async () => {
		const { editor, pm } = await renderEditor({
			pluginBlocks: [
				{
					pluginId: "test-plugin",
					type: "youtube",
					label: "YouTube Video",
				},
			],
		});
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");

		expect(titles).toContain("YouTube Video");
	});
});
