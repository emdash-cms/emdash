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

import { closeHistory } from "@tiptap/pm/history";
import { TableMap } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/react";
import { SuggestionPluginKey } from "@tiptap/suggestion";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { PortableTextEditorProps } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

import "../../src/styles.css";

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
		<>
			<button type="button" onClick={() => onInsertBlock?.(editor.state.doc.content.size)}>
				Test gutter insert
			</button>
			<button
				type="button"
				data-block-insert
				onClick={() => onInsertBlock?.(editor.state.doc.child(0).nodeSize)}
			>
				Test insert after first block
			</button>
		</>
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

function itemTitle(item: HTMLElement): string {
	return item.querySelector("[data-slash-item-title]")?.textContent ?? "";
}

function getItemTitles(menu: HTMLElement): string[] {
	return getSlashMenuItems(menu).map(itemTitle);
}

function findItem(menu: HTMLElement, title: string): HTMLButtonElement | undefined {
	return getSlashMenuItems(menu).find((item) => itemTitle(item) === title);
}

/** Whether an item is the highlighted one that Enter would run. */
function isItemSelected(el: HTMLElement): boolean {
	return el.getAttribute("aria-current") === "true";
}

/** The text of each top-level block. */
function blockTexts(editor: Editor): string[] {
	const texts: string[] = [];
	editor.state.doc.forEach((block) => texts.push(block.textContent));
	return texts;
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

	it("types a slash on a new line below the block from the insert button", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("First");

		await screen.getByRole("button", { name: "Test gutter insert" }).click();

		await waitForSlashMenu();
		expect(blockTexts(editor)).toEqual(["First", "/"]);
		expect(isSlashSuggestionActive(editor)).toBe(true);
		await userEvent.keyboard("hea");
		await vi.waitFor(() => expect(getItemTitles(getSlashMenu()!)).toContain("Heading 1"));
		expect(getItemTitles(getSlashMenu()!).every((title) => title.startsWith("Heading"))).toBe(true);
	});

	it("types into an empty paragraph from the insert button instead of adding a line", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);

		await screen.getByRole("button", { name: "Test gutter insert" }).click();

		await waitForSlashMenu();
		expect(blockTexts(editor)).toEqual(["/"]);
	});

	it.each([
		["Escape", () => userEvent.keyboard("{Escape}")],
		["Tab", () => userEvent.keyboard("{Tab}")],
		[
			"a click outside the menu",
			async () => {
				document
					.querySelector(".ProseMirror")!
					.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			},
		],
	])("removes the insert button's line when %s closes the menu", async (_name, close) => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("First");
		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();

		await close();

		await waitForSlashMenuClosed();
		expect(blockTexts(editor)).toEqual(["First"]);
		expect(editor.commands.undo()).toBe(true);
		expect(blockTexts(editor)).toEqual([""]);
	});

	it("leaves nothing to undo after closing the insert button's slash in an empty line", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("First");
		const { tr, schema } = editor.state;
		editor.view.dispatch(
			closeHistory(tr.insert(tr.doc.content.size, schema.nodes.paragraph!.create())),
		);
		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		expect(blockTexts(editor)).toEqual(["First", "/"]);

		await userEvent.keyboard("{Escape}");

		await waitForSlashMenuClosed();
		expect(blockTexts(editor)).toEqual(["First", ""]);
		expect(editor.commands.undo()).toBe(true);
		expect(blockTexts(editor)).toEqual(["First"]);
	});

	it("turns an empty line into the chosen block from the insert button, in one undo step", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("First");
		const { tr, schema } = editor.state;
		editor.view.dispatch(
			closeHistory(tr.insert(tr.doc.content.size, schema.nodes.paragraph!.create())),
		);
		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await waitForSlashMenu();

		findItem(menu, "Heading 1")?.click();

		await waitForSlashMenuClosed();
		expect(editor.state.doc.child(1).type.name).toBe("heading");
		expect(editor.commands.undo()).toBe(true);
		expect(blockTexts(editor)).toEqual(["First", ""]);
		expect(editor.state.doc.child(1).type.name).toBe("paragraph");
		expect(editor.commands.undo()).toBe(true);
		expect(blockTexts(editor)).toEqual(["First"]);
	});

	it.each([
		["runs a command", () => findItem(getSlashMenu()!, "Heading 1")?.click(), "h"],
		["closes", () => userEvent.keyboard("{Escape}"), "/h"],
	])(
		"keeps text typed after the insert button's slash when the caret moves back and the menu %s",
		async (_name, close, expected) => {
			const { screen, editor, pm } = await renderEditor();
			await focusEditor(pm);
			editor.commands.setContent("<p>First</p><p>Second</p>");
			await screen.getByRole("button", { name: "Test insert after first block" }).click();
			await waitForSlashMenu();
			await userEvent.keyboard("h{ArrowLeft}");
			await vi.waitFor(() =>
				expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 2),
			);

			await close();

			await waitForSlashMenuClosed();
			expect(blockTexts(editor)).toEqual(["First", expected, "Second"]);
			expect(editor.state.doc.child(2).type.name).toBe("paragraph");
		},
	);

	it("reports no change until the insert button's menu runs a command", async () => {
		const onChange = vi.fn();
		const { screen, editor, pm } = await renderEditor({ onChange });
		await focusEditor(pm);
		editor.commands.insertContent("First");
		onChange.mockClear();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		await userEvent.keyboard("hea");
		await vi.waitFor(() => expect(getItemTitles(getSlashMenu()!)).toContain("Heading 1"));
		expect(onChange).not.toHaveBeenCalled();

		findItem(getSlashMenu()!, "Heading 1")?.click();

		await waitForSlashMenuClosed();
		const blocks = onChange.mock.lastCall?.[0] as Array<{ style?: string }>;
		expect(blocks.map((block) => block.style)).toEqual(["normal", "h1"]);
	});

	it("types into an empty paragraph right after the insert point instead of adding a line", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.setContent("<p>First</p><p></p><p>Last</p>");

		await screen.getByRole("button", { name: "Test insert after first block" }).click();

		await waitForSlashMenu();
		expect(blockTexts(editor)).toEqual(["First", "/", "Last"]);
	});

	it("keeps one line when the insert button is pressed again", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.setContent("<p>First</p><p>Last</p>");
		const insert = screen.getByRole("button", { name: "Test insert after first block" }).element();

		insert.click();
		await waitForSlashMenu();
		insert.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		insert.click();

		await waitForSlashMenu();
		expect(blockTexts(editor)).toEqual(["First", "/", "Last"]);
	});

	it("hides the menu while its line is under the sticky toolbar", async () => {
		let editorInstance: Editor | null = null;
		await render(
			<div style={{ height: 400, overflowY: "auto" }} data-testid="scroller">
				<PortableTextEditor
					variant="document"
					onEditorReady={(editor) => (editorInstance = editor)}
				/>
			</div>,
		);
		await vi.waitFor(() => expect(editorInstance).toBeTruthy());
		const editor = editorInstance!;
		// The test build has no Tailwind utilities, so the toolbar gets its sticky position here.
		const toolbar = document.querySelector<HTMLElement>('[data-emdash-editor-toolbar="document"]')!;
		toolbar.style.position = "sticky";
		toolbar.style.top = "0px";
		editor.commands.setContent(
			Array.from({ length: 30 }, (_, index) => `<p>Paragraph ${index}</p>`).join(""),
		);
		editor.view.focus();
		editor
			.chain()
			.setTextSelection(editor.state.doc.child(0).nodeSize * 10 + 1)
			.scrollIntoView()
			.run();
		editor.commands.insertContent("/");
		await waitForSlashMenu();
		const positioner = document.querySelector(".slash-command-menu-positioner")!;
		expect(positioner.hasAttribute("data-anchor-hidden")).toBe(false);

		const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
		const line = editor.view.coordsAtPos(editor.state.selection.from);
		scroller.scrollTop += line.top - scroller.getBoundingClientRect().top - 4;

		await vi.waitFor(() => expect(positioner.hasAttribute("data-anchor-hidden")).toBe(true));
	});

	it("keeps a query typed after the insert button's slash when the menu closes", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await waitForSlashMenu();
		await userEvent.keyboard("zz");

		await userEvent.keyboard("{Escape}");

		await waitForSlashMenuClosed();
		expect(blockTexts(editor)).toEqual(["/zz"]);
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

	it.each([
		["a pointer", true],
		["the keyboard", false],
	])(
		"leaves a typed slash as text when the insert button is used with %s",
		async (_name, withPointer) => {
			const { screen, editor, pm } = await renderEditor();
			await focusEditor(pm);
			editor.commands.insertContent("/");
			await waitForSlashMenu();

			const insertButton = screen.getByRole("button", { name: "Test gutter insert" }).element();
			if (withPointer)
				insertButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			insertButton.click();

			await waitForSlashMenu();
			expect(blockTexts(editor)).toEqual(["/", "/"]);
			const suggestion = SuggestionPluginKey.getState(editor.state) as { range: { from: number } };
			expect(suggestion.range.from).toBe(editor.state.doc.child(0).nodeSize + 1);
		},
	);

	it("does not leave the insert button's line when a command opens a picker", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("First");
		const before = editor.getJSON();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await waitForSlashMenu();
		findItem(menu, "Image")?.click();

		await waitForSlashMenuClosed();
		expect(editor.getJSON()).toEqual(before);
		expect(editor.commands.undo()).toBe(true);
		expect(blockTexts(editor)).toEqual([""]);
	});

	it("inserts picker content where the insert button's line was", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("First");

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await waitForSlashMenu();
		findItem(menu, "Section")?.click();
		await screen.getByRole("button", { name: "Select test section" }).click();

		expect(blockTexts(editor)).toEqual(["First", "Inserted section"]);
	});

	it("turns the insert button's line into the chosen block, and undoes it without the slash", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("First");

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await waitForSlashMenu();
		findItem(menu, "Heading 1")?.click();
		await waitForSlashMenuClosed();

		const content = editor.getJSON().content;
		expect(content?.[1]?.type).toBe("heading");
		expect(content?.[1]?.attrs?.level).toBe(1);
		expect(editor.commands.undo()).toBe(true);
		expect(blockTexts(editor)).toEqual(["First", ""]);
		expect(editor.commands.undo()).toBe(true);
		expect(blockTexts(editor)).toEqual(["First"]);
	});

	it("follows its line when the editor scrolls inside a container", async () => {
		let editorInstance: Editor | null = null;
		await render(
			<div style={{ height: 400, overflowY: "auto" }} data-testid="scroller">
				<PortableTextEditor onEditorReady={(editor) => (editorInstance = editor)} />
			</div>,
		);
		await vi.waitFor(() => expect(editorInstance).toBeTruthy());
		const editor = editorInstance!;
		editor.commands.setContent(
			Array.from({ length: 30 }, (_, index) => `<p>Paragraph ${index}</p>`).join(""),
		);
		editor.view.focus();
		editor
			.chain()
			.setTextSelection(editor.state.doc.child(0).nodeSize + 1)
			.scrollIntoView()
			.run();
		editor.commands.insertContent("/");
		const menu = await waitForSlashMenu();
		const top = menu.getBoundingClientRect().top;

		document.querySelector<HTMLElement>('[data-testid="scroller"]')!.scrollTop += 40;

		await vi.waitFor(() => expect(menu.getBoundingClientRect().top).toBeCloseTo(top - 40, 0));
	});

	it("keeps searching across a space while titles still match", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("heading 2");
		await vi.waitFor(() => expect(getItemTitles(getSlashMenu()!)).toEqual(["Heading 2"]));

		await userEvent.keyboard(" is next");
		await waitForSlashMenuClosed();
		expect(editor.getText()).toBe("/heading 2 is next");
	});

	it("finds blocks by the Markdown shown beside them", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/#");

		const menu = await waitForSlashMenu();

		expect(getItemTitles(menu)[0]).toBe("Heading 1");
	});

	it("finds Divider by its Markdown once Typography turns the dashes into an em dash", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/—-");

		const menu = await waitForSlashMenu();

		expect(getItemTitles(menu)).toEqual(["Divider"]);
	});

	it("goes back to the editor when Tab leaves the table picker", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/table");
		const menu = await waitForSlashMenu();
		findItem(menu, "Table")?.click();
		await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();

		await userEvent.keyboard("{Tab}{Tab}");

		await waitForSlashMenuClosed();
		expect(editor.view.hasFocus()).toBe(true);
		expect(editor.getText()).toBe("/table");
	});

	it("hints at searching until a query is typed", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		const hint = () =>
			getComputedStyle(pm.querySelector(".emdash-slash-query")!, "::after").content;
		expect(hint()).toBe('"Type to search"');
		await userEvent.keyboard("h");
		await vi.waitFor(() => expect(hint()).toBe("none"));
	});

	it("opens when typing / at the start of an empty line", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);

		// Default commands: text, headings 1-3, lists, quote, code, divider, table, media, and more
		expect(items.length).toBeGreaterThanOrEqual(8);
	});

	it("shows default block type commands", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const titles = getItemTitles(menu);

		expect(titles[0]).toBe("Paragraph");
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

	it("keeps headings 4 to 6 out of the list until a search asks for them", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		expect(getItemTitles(menu)).not.toContain("Heading 4");

		await userEvent.keyboard("h4");

		await vi.waitFor(() => {
			expect(getItemTitles(getSlashMenu()!)[0]).toBe("Heading 4");
		});
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() => expect(pm.querySelector("h4")).toBeTruthy());
	});

	it("groups the unfiltered list by category and flattens it while searching", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const groupLabels = Array.from(menu.querySelectorAll('[role="group"]'), (group) =>
			group.getAttribute("aria-label"),
		);
		expect(groupLabels).toEqual(["Basic blocks", "Media", "Advanced", "Embeds"]);

		await userEvent.keyboard("image");

		await vi.waitFor(() => {
			const groups = getSlashMenu()!.querySelectorAll('[role="group"]');
			expect(groups).toHaveLength(1);
			expect(groups[0]?.hasAttribute("aria-label")).toBe(false);
		});
	});

	it("opens the shared table picker and preserves the query on Escape", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/table");
		const menu = await waitForSlashMenu();
		getSlashMenuItems(menu)
			.find((item) => item.textContent?.includes("Table"))!
			.click();

		await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();
		expect(editor.getText()).toContain("/table");
		await userEvent.keyboard("{Escape}");

		await waitForSlashMenuClosed();
		expect(editor.getText()).toContain("/table");
		await vi.waitFor(() => expect(document.activeElement).toBe(pm));
	});

	it("closes the shared table picker when the editor becomes read-only", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/table");
		const menu = await waitForSlashMenu();
		getSlashMenuItems(menu)
			.find((item) => item.textContent?.includes("Table"))!
			.click();
		await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();

		await screen.rerender(<PortableTextEditor editable={false} />);

		await waitForSlashMenuClosed();
		expect(editor.getText()).toContain("/table");
	});

	it("inserts the chosen table and removes the slash query in one undo", async () => {
		const { screen, editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/table");
		const menu = await waitForSlashMenu();
		getSlashMenuItems(menu)
			.find((item) => item.textContent?.includes("Table"))!
			.click();
		await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();

		await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowDown}{Enter}");

		await waitForSlashMenuClosed();
		expect(editor.view.hasFocus()).toBe(true);
		const table = editor.state.doc.firstChild!;
		expect(TableMap.get(table)).toMatchObject({ width: 3, height: 2 });
		expect(table.firstChild?.firstChild?.type.spec.tableRole).toBe("header_cell");
		expect(editor.getText()).not.toContain("/table");
		expect(editor.commands.undo()).toBe(true);
		expect(editor.getText()).toContain("/table");
	});

	it("describes the highlighted command below the list", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		expect(menu.textContent).toContain("Start writing with plain text");

		await userEvent.keyboard("{ArrowDown}");

		await vi.waitFor(() => {
			expect(getSlashMenu()!.textContent).toContain("Large section heading");
		});
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
				const titles = getItemTitles(menu!);
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
				expect(menu.querySelector('[role="status"]')?.textContent).toBe("Selected Paragraph");
			},
			{ timeout: 3000 },
		);
	});

	it("uses the interaction surface for selected items", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const [selectedItem, otherItem] = getSlashMenuItems(menu);
		expect(selectedItem!.className.split(WHITESPACE_SPLIT_REGEX)).toContain("bg-kumo-tint");
		expect(otherItem!.className.split(WHITESPACE_SPLIT_REGEX)).not.toContain("bg-kumo-tint");
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
			expect(items[0]?.hasAttribute("aria-current")).toBe(false);
			expect(menu.querySelector('[role="status"]')?.textContent).toBe("Selected Heading 1");
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

		await userEvent.keyboard("h1");
		await vi.waitFor(() => expect(getItemTitles(getSlashMenu()!)[0]).toBe("Heading 1"));
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
		const quoteBtn = items.find((btn) => itemTitle(btn) === "Quote");
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
		const codeBlockBtn = items.find((btn) => itemTitle(btn) === "Code Block");
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
		const dividerBtn = items.find((btn) => itemTitle(btn) === "Divider");
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
		const htmlBtn = findItem(menu, "HTML");
		expect(htmlBtn).toBeTruthy();
		htmlBtn!.click();

		await waitForSlashMenuClosed();

		await vi.waitFor(() => {
			const htmlBlock = editor.getJSON().content?.find((node) => node.type === "htmlBlock");
			expect(htmlBlock).toBeDefined();
			expect(htmlBlock?.attrs).toMatchObject({ html: "", css: "", js: "", isolated: true });
		});
	});

	it("inserts bullet list via slash command", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const items = getSlashMenuItems(menu);
		const bulletBtn = items.find((btn) => itemTitle(btn) === "Bullet List");
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
		const numberedBtn = items.find((btn) => itemTitle(btn) === "Numbered List");
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
				const titles = getItemTitles(menu!);
				expect(titles.length).toBeGreaterThanOrEqual(1);
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
		const titles = getItemTitles(menu);

		expect(titles).toContain("Image");
		expect(titles).toContain("Section");
	});

	it("matches a short query only against the starts of names", async () => {
		const { editor, pm } = await renderEditor();
		await focusEditor(pm);
		editor.commands.insertContent("/");
		await waitForSlashMenu();

		await userEvent.keyboard("di");

		await vi.waitFor(
			() => {
				const menu = getSlashMenu();
				expect(menu).toBeTruthy();
				expect(getItemTitles(menu!)).toEqual(["Divider"]);
			},
			{ timeout: 3000 },
		);
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
				const titles = getItemTitles(menu!);
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
		const titles = getItemTitles(menu);

		expect(titles).toContain("YouTube Video");
	});

	it("renders plugin block commands with a custom category override", async () => {
		// A plugin block that opts into the "Sections" category instead of the
		// default "Embeds" is listed under that category's heading.
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
		const titles = getItemTitles(menu);

		expect(titles).toContain("Hero");
		expect(menu.querySelector('[role="group"][aria-label="Sections"]')?.textContent).toContain(
			"Hero",
		);
	});

	it("moves the highlight in the order the menu lists commands", async () => {
		// A plugin block in a built-in category is listed with that category's
		// commands, so the arrow keys must reach it there too.
		const { editor, pm } = await renderEditor({
			pluginBlocks: [
				{ pluginId: "video-plugin", type: "video", label: "Video", category: "Media" },
			],
		});
		await focusEditor(pm);
		editor.commands.insertContent("/");

		const menu = await waitForSlashMenu();
		const listed = getSlashMenuItems(menu).map((item) => Number(item.dataset.index));

		expect(listed).toEqual(listed.map((_, position) => position));
		expect(menu.querySelector('[role="group"][aria-label="Media"]')?.textContent).toContain(
			"Video",
		);
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
		const titles = getItemTitles(menu);

		expect(titles).toContain("Vimeo");
		expect(menu.querySelector('[role="group"][aria-label="Embeds"]')?.textContent).toContain(
			"Vimeo",
		);
	});
});
