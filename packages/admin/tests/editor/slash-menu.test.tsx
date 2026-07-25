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
import { SuggestionPluginKey } from "@tiptap/suggestion";
import { userEvent } from "@vitest/browser/context";
import { describe, it, expect, vi } from "vitest";

import type { PortableTextEditorProps } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: ({
		open,
		onOpenChange,
		onSelect,
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSelect: (section: { content: unknown[] }) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() => {
					onSelect({
						content: [
							{
								_type: "block",
								_key: "section-block",
								style: "normal",
								children: [{ _type: "span", _key: "section-span", text: "Inserted section" }],
							},
						],
					});
					onOpenChange(false);
				}}
			>
				Select test section
			</button>
		) : null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: ({
		editor,
		onInsertBlock,
	}: {
		editor: Editor;
		onInsertBlock?: (insertPos: number) => void;
	}) => (
		<button type="button" onClick={() => onInsertBlock?.(editor.state.doc.content.size)}>
			Test gutter insert
		</button>
	),
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
	return document.querySelector<HTMLElement>("[data-slash-command-menu]");
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
 * Selected items use the semantic interaction surface.
 */
function isItemSelected(el: HTMLElement): boolean {
	return el.className.split(WHITESPACE_SPLIT_REGEX).includes("bg-kumo-interact");
}

function isSlashSuggestionActive(editor: Editor): boolean {
	return Boolean(
		(SuggestionPluginKey.getState(editor.state) as { active?: boolean } | undefined)?.active,
	);
}

// =============================================================================
// Slash Command Menu
// =============================================================================

describe("Slash Command Menu", () => {
	it("keeps focus in the editor when the menu opens", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		expect(document.activeElement).toBe(pm);

		const focusGuards = menu.parentElement?.querySelectorAll("[data-base-ui-focus-guard]");
		expect(focusGuards).toHaveLength(2);
		expect(menu.parentElement?.classList.contains("slash-command-menu-positioner")).toBe(true);
	});

	it("uses a contained scroll viewport inside the menu shell", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const scrollViewport = menu.querySelector<HTMLElement>("[data-slash-menu-scroll-viewport]");

		expect(scrollViewport).toBeTruthy();
		expect(scrollViewport).not.toBe(menu);
		expect(scrollViewport!.className.split(WHITESPACE_SPLIT_REGEX)).toEqual(
			expect.arrayContaining(["overflow-y-auto", "overscroll-contain"]),
		);
		expect(menu.className.split(WHITESPACE_SPLIT_REGEX)).not.toContain("overflow-y-auto");
	});

	it("closes on Tab and lets focus leave the editor", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();
		const nextFocusable = screen.getByRole("button", { name: "Test gutter insert" }).element();

		await userEvent.keyboard("{Tab}");

		await waitForSlashMenuClosed();
		expect(document.activeElement).toBe(nextFocusable);
		expect(editor.getText()).toBe("/");
		expect(isSlashSuggestionActive(editor)).toBe(false);
	});

	it("closes on Shift+Tab and lets focus leave the editor", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");

		await waitForSlashMenuClosed();
		expect(document.activeElement).not.toBe(pm);
		expect(editor.getText()).toBe("/");
		expect(isSlashSuggestionActive(editor)).toBe(false);
	});

	it("closes a gutter-triggered menu on Tab without inserting content", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		const before = editor.getJSON();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		await userEvent.keyboard("{Tab}");

		await waitForSlashMenuClosed();
		expect(editor.getJSON()).toEqual(before);
	});

	it("opens from the gutter and cancels without inserting a slash", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		const before = editor.getJSON();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		expect(editor.getText()).not.toContain("/");
		expect(editor.getJSON()).toEqual(before);

		await userEvent.keyboard("{Escape}");
		await waitForSlashMenuClosed();
		expect(editor.getJSON()).toEqual(before);
	});

	it("discards an untouched gutter block when clicking outside the menu", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		const before = editor.getText();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		pm.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

		await waitForSlashMenuClosed();
		expect(editor.getText()).toBe(before);
	});

	it("exits the slash suggestion plugin when clicking outside the menu", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();
		expect(isSlashSuggestionActive(editor)).toBe(true);

		pm.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

		await waitForSlashMenuClosed();
		expect(isSlashSuggestionActive(editor)).toBe(false);
	});

	it("keeps slash suggestion dismissed when opening the gutter menu", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		const gutterButton = screen.getByRole("button", { name: "Test gutter insert" }).element();
		gutterButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		gutterButton.click();
		await waitForSlashMenu();
		editor.view.dispatch(editor.state.tr.setMeta("test", true));

		expect(isSlashSuggestionActive(editor)).toBe(false);
		expect(getSlashMenu()).toBeTruthy();
	});

	it("records slash dismissal when opening the gutter menu from the keyboard", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		screen.getByRole("button", { name: "Test gutter insert" }).element().click();
		await waitForSlashMenu();
		editor.view.dispatch(editor.state.tr.setMeta("test", true));

		expect(isSlashSuggestionActive(editor)).toBe(false);
		expect(getSlashMenu()).toBeTruthy();
	});

	it("does not leave a staging paragraph when a gutter command opens a modal", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		const before = editor.getJSON();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await waitForSlashMenu();
		const imageCommand = getSlashMenuItems(menu).find((item) =>
			item.textContent?.includes("Image"),
		);
		expect(imageCommand).toBeTruthy();

		imageCommand?.click();
		await waitForSlashMenuClosed();
		expect(editor.getJSON()).toEqual(before);
	});

	it("materializes a new block when a direct gutter command is selected", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await waitForSlashMenu();
		getSlashMenuItems(menu)[0]?.click();
		await waitForSlashMenuClosed();

		const content = editor.getJSON().content;
		expect(content?.[1]?.type).toBe("heading");
		expect(content?.[1]?.attrs?.level).toBe(1);
	});

	it("inserts modal-backed gutter content at the requested block position", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await waitForSlashMenu();
		const sectionCommand = getSlashMenuItems(menu).find((item) =>
			item.textContent?.includes("Section"),
		);
		sectionCommand?.click();
		await screen.getByRole("button", { name: "Select test section" }).click();

		const content = editor.getJSON().content;
		expect(content).toHaveLength(2);
		expect(content?.[1]?.content?.[0]?.text).toBe("Inserted section");
	});

	it("materializes a new gutter paragraph when the user starts typing", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		await userEvent.keyboard("A");

		await waitForSlashMenuClosed();
		const content = editor.getJSON().content;
		expect(content).toHaveLength(2);
		expect(content?.[1]?.content?.[0]?.text).toBe("A");
	});

	it("does not materialize a gutter paragraph for modifier shortcuts", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		const before = editor.getJSON();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		await userEvent.keyboard("{Control>}b{/Control}");

		expect(editor.getJSON()).toEqual(before);
	});

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
		expect(titles).toContain("HTML");
		expect(titles).toContain("Divider");
		expect(titles).toContain("Table");
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

		await waitForSlashMenu();

		await vi.waitFor(
			() => {
				const menu = getSlashMenu()!;
				const items = getSlashMenuItems(menu);
				expect(isItemSelected(items[0]!)).toBe(true);
				expect(items[0]?.getAttribute("aria-current")).toBe("true");
				expect(menu.querySelector('[role="status"]')?.textContent).toBe("Selected Heading 1");
			},
			{ timeout: 3000 },
		);
	});

	it("uses the interaction surface for selected items", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const selectedItem = getSlashMenuItems(menu)[0]!;
		const classes = selectedItem.className.split(WHITESPACE_SPLIT_REGEX);
		expect(classes).toContain("bg-kumo-interact");
		expect(classes).not.toContain("bg-kumo-tint");
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
			expect(items[1]?.getAttribute("aria-current")).toBe("true");
			expect(items[0]?.hasAttribute("aria-current")).toBe(false);
			expect(menu.querySelector('[role="status"]')?.textContent).toBe("Selected Heading 2");
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
		expect(isSlashSuggestionActive(editor)).toBe(false);
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

	it("inserts an HTML block via slash command", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const htmlBtn = getSlashMenuItems(menu).find(
			(btn) => btn.querySelector(".font-medium")?.textContent === "HTML",
		);
		expect(htmlBtn).toBeTruthy();
		htmlBtn!.click();

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			const htmlBlock = editor.getJSON().content?.find((node) => node.type === "htmlBlock");
			expect(htmlBlock).toBeDefined();
			expect((htmlBlock as { attrs?: { html?: string } }).attrs?.html).toBe("");
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

		// The menu gates mouseenter on a "has the user actually moved the
		// pointer since the menu opened?" flag, to avoid jumping selection
		// when the menu renders under a stationary pointer (which happens
		// in CI because pointer position persists across tests). Dispatch a
		// real pointermove on the menu first so the gate is open before we
		// hover an item. userEvent.hover by itself only teleports the
		// cursor to the target and fires pointerenter -- no pointermove.
		menu.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));

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

	it("renders plugin block commands with a custom category override", async () => {
		// A plugin block that opts into the "Sections" category instead of the
		// default "Embeds". The category itself isn't currently surfaced in the
		// rendered DOM (the slash menu doesn't group by category), but providing
		// it must not break rendering and the block must still be selectable.
		const { editor, pm } = await renderEditor({
			pluginBlocks: [
				{
					pluginId: "marketing-blocks",
					type: "marketing.hero",
					label: "Hero",
					category: "Sections",
				},
			],
		});
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");

		expect(titles).toContain("Hero");
	});

	it("renders plugin block commands without a category (default Embeds)", async () => {
		// Existing plugins that omit `category` must continue to render under
		// the default category. This guards against regressions in the type
		// widening / fallback behaviour.
		const { editor, pm } = await renderEditor({
			pluginBlocks: [
				{
					pluginId: "test-plugin",
					type: "vimeo",
					label: "Vimeo",
					// no category provided
				},
			],
		});
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const titles = items.map((btn) => btn.querySelector(".font-medium")?.textContent ?? "");

		expect(titles).toContain("Vimeo");
	});
});
