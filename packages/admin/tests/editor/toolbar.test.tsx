import type { Editor } from "@tiptap/core";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import type { MediaItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Mocks — heavy components that need network / Astro context
// ---------------------------------------------------------------------------

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({
		open,
		onOpenChange,
		onSelect,
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSelect: (item: MediaItem) => void;
	}) =>
		open ? (
			<div role="dialog" aria-label="Test image picker">
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: "image-1",
							filename: "diagram.png",
							mimeType: "image/png",
							url: "/diagram.png",
							size: 1024,
							alt: "Architecture diagram",
							createdAt: "2026-08-16T00:00:00.000Z",
						})
					}
				>
					Choose test image
				</button>
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: "",
							filename: "remote.jpg",
							mimeType: "image/jpeg",
							url: "https://media.example/remote.jpg",
							provider: "external-url",
							size: 0,
							createdAt: "2026-08-16T00:00:00.000Z",
						})
					}
				>
					Choose external image
				</button>
				<button type="button" onClick={() => onOpenChange(false)}>
					Cancel image picker
				</button>
			</div>
		) : null,
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
		addCommands() {
			return {
				setImage:
					(options: Record<string, unknown>) =>
					({ commands }) =>
						commands.insertContent({ type: this.name, attrs: options }),
			};
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

const defaultValue = [
	{
		_type: "block" as const,
		_key: "1",
		style: "normal" as const,
		children: [{ _type: "span" as const, _key: "s1", text: "Hello world" }],
	},
];

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editorInstance: Editor | null = null;
	const onEditorReady = (editor: Editor) => {
		editorInstance = editor;
	};

	const screen = await render(
		<PortableTextEditor value={defaultValue} onEditorReady={onEditorReady} {...props} />,
	);

	// Wait for TipTap to initialize
	await vi.waitFor(
		() => {
			expect(document.querySelector(".ProseMirror")).toBeTruthy();
		},
		{ timeout: 3000 },
	);

	return { screen, editor: editorInstance! };
}

/** Focus the ProseMirror editor and select all text */
async function focusAndSelectAll(screen: Awaited<ReturnType<typeof render>>) {
	const prosemirror = screen.container.querySelector(".ProseMirror") as HTMLElement;
	prosemirror.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(prosemirror), { timeout: 1000 });
	// Use Control on Linux CI, Meta on macOS
	const mod = navigator.platform.includes("Mac") ? "{Meta>}" : "{Control>}";
	const modUp = navigator.platform.includes("Mac") ? "{/Meta}" : "{/Control}";
	await userEvent.keyboard(`${mod}{a}${modUp}`);
}

/**
 * Returns a locator scoped to the editor toolbar.
 *
 * The bubble menu (which appears when text is selected) renders buttons with
 * the same accessible names as some toolbar buttons (Bold, Italic, Underline,
 * Strikethrough). An unscoped `getByRole("button", { name: "Bold" })` after
 * selecting text races with the bubble menu and produces a strict-mode
 * violation in CI. Scoping to the toolbar via its aria-label avoids the race.
 */
function getToolbarButton(screen: Awaited<ReturnType<typeof render>>, name: string) {
	return screen.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name });
}

function expectVisibleActiveState(element: HTMLElement) {
	expect(element.classList.contains("bg-kumo-interact/50")).toBe(true);
	expect(element.classList.contains("hover:bg-kumo-interact/50")).toBe(true);
}

function expectNoVisibleActiveState(element: HTMLElement) {
	expect(element.classList.contains("bg-kumo-interact/50")).toBe(false);
}

function getTextPosition(editor: Editor, text: string): number {
	let position: number | undefined;
	editor.state.doc.descendants((node, pos) => {
		if (position !== undefined) return false;
		if (node.isTextblock && node.textContent.includes(text)) {
			position = pos + 1;
			return false;
		}
		return true;
	});
	if (position === undefined) throw new Error(`Could not find text: ${text}`);
	return position;
}

function expectAlignmentState(
	screen: Awaited<ReturnType<typeof render>>,
	active: "left" | "center" | "right" | null,
) {
	const buttons = {
		left: getToolbarButton(screen, "Align Left").element(),
		center: getToolbarButton(screen, "Align Center").element(),
		right: getToolbarButton(screen, "Align Right").element(),
	};

	for (const [alignment, button] of Object.entries(buttons)) {
		expect(button.getAttribute("aria-pressed")).toBe(String(alignment === active));
	}
}

function expectMixedTableAlignmentState(
	screen: Awaited<ReturnType<typeof render>>,
	mixed: Array<"left" | "center" | "right">,
) {
	for (const alignment of ["left", "center", "right"] as const) {
		const label = `Align ${alignment[0]!.toUpperCase()}${alignment.slice(1)}`;
		expect(getToolbarButton(screen, label).element().getAttribute("aria-pressed")).toBe(
			mixed.includes(alignment) ? "mixed" : "false",
		);
	}
}

async function getHeadingMenuItem(
	screen: Awaited<ReturnType<typeof render>>,
	name: "Heading 1" | "Heading 2" | "Heading 3" | "Heading 4" | "Heading 5" | "Heading 6",
) {
	const trigger = getToolbarButton(screen, "Headings");
	trigger.element().click();
	const item = screen.getByRole("menuitem", { name });
	await expect.element(item).toBeVisible();
	return { trigger, item };
}

// =============================================================================
// 1. Toolbar Presence and Structure
// =============================================================================

describe("Toolbar Presence and Structure", () => {
	it("has role='toolbar' with correct aria-label", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar");
		await expect.element(toolbar).toHaveAttribute("aria-label", "Text formatting");
	});

	it("centers controls when they fit and preserves horizontal overflow", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();

		expect(toolbar.className).toContain("overflow-x-auto");
		expect(getComputedStyle(toolbar).justifyContent).toBe("safe center");
	});

	it("has all formatting buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Bold" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Italic" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Underline" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Strikethrough" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Inline Code" })).toBeVisible();
	});

	it("collapses the supported heading levels into one menu", async () => {
		const { screen } = await renderEditor();
		const trigger = getToolbarButton(screen, "Headings");
		await expect.element(trigger).toBeVisible();
		await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");

		trigger.element().click();
		await expect.element(screen.getByRole("menuitem", { name: "Heading 1" })).toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Heading 2" })).toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Heading 3" })).toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Heading 4" })).toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Heading 5" })).toBeVisible();
		await expect.element(screen.getByRole("menuitem", { name: "Heading 6" })).toBeVisible();
		expect(
			screen
				.getByRole("menuitem", { name: "Heading 1" })
				.element()
				.hasAttribute("data-emdash-heading-item"),
		).toBe(true);

		const headingLabels = Array.from(
			document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
			(item) => item.textContent?.trim(),
		);
		expect(headingLabels).toEqual(
			expect.arrayContaining([
				"Heading 1",
				"Heading 2",
				"Heading 3",
				"Heading 4",
				"Heading 5",
				"Heading 6",
			]),
		);
	});

	it("has all list buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Bullet List" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Numbered List" })).toBeVisible();
	});

	it("has all block buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Quote" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Code Block" })).toBeVisible();
	});

	it("has all alignment buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Align Left" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Align Center" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Align Right" })).toBeVisible();
	});

	it("exposes the permanent Table control and keeps other extended actions in the block menu", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		await expect.element(screen.getByRole("button", { name: "Insert Link" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Insert Image" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Insert HTML" })).toBeVisible();
		const table = screen.getByRole("button", { name: "Table" });
		await expect.element(table).toBeVisible();
		await expect.element(table).toHaveAttribute("aria-keyshortcuts", "Alt+F10");
		await userEvent.click(table);
		await expect.element(table).toHaveAttribute("aria-expanded", "true");
		const insert = screen.getByRole("menuitem", { name: "Insert table" });
		await expect.element(insert).toBeVisible();
		insert.element().click();
		await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();
		await expect.element(table).toHaveAttribute("aria-expanded", "false");
		expect(toolbar.querySelector('[aria-label="Insert Horizontal Rule"]')).toBeNull();
	});

	it("shows the complete grouped Table menu inside a table", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		getToolbarButton(screen, "Table").element().click();
		const menuLocator = screen.getByRole("menu");
		await expect.element(menuLocator).toBeVisible();
		const menu = menuLocator.element();

		for (const group of [
			"Selection",
			"Rows",
			"Columns",
			"Headers",
			"Cells",
			"Widths",
			"Document",
			"Table",
		]) {
			expect(menu.textContent).toContain(group);
		}
		const items = Array.from(
			menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
			(item) => item.textContent?.trim(),
		);
		expect(items).toEqual([
			"Select row",
			"Select column",
			"Select table",
			"Add row above",
			"Add row below",
			"Delete row",
			"Add column before",
			"Add column after",
			"Delete column",
			"Toggle header row",
			"Toggle header column",
			"Merge selected cells",
			"Split merged cell",
			"Decrease column width",
			"Increase column width",
			"Distribute columns evenly",
			"Reset column widths",
			"Insert paragraph before",
			"Insert paragraph after",
			"Delete table",
		]);
	});

	it("focuses the permanent Table trigger with Alt+F10 without changing selection", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		editor.view.focus();
		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		const before = editor.state.selection.toJSON();

		await userEvent.keyboard("{Alt>}{F10}{/Alt}");

		await vi.waitFor(() => expect(getToolbarButton(screen, "Table").element()).toHaveFocus());
		expect(editor.state.selection.toJSON()).toEqual(before);
	});

	it("returns from the closed Alt+F10 Table trigger with Escape", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		const before = editor.state.selection.toJSON();
		await userEvent.keyboard("{Alt>}{F10}{/Alt}");
		await vi.waitFor(() => expect(getToolbarButton(screen, "Table").element()).toHaveFocus());
		await userEvent.keyboard("{Escape}");
		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		expect(editor.state.selection.toJSON()).toEqual(before);

		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		const moved = editor.state.selection.toJSON();
		getToolbarButton(screen, "Table").element().focus();
		await userEvent.keyboard("{Escape}");
		expect(editor.state.selection.toJSON()).toEqual(moved);

		editor.view.focus();
		await userEvent.keyboard("{Alt>}{F10}{/Alt}");
		await vi.waitFor(() => expect(getToolbarButton(screen, "Table").element()).toHaveFocus());
		editor.view.focus();
		editor.commands.setTextSelection(4);
		const afterAbandoning = editor.state.selection.toJSON();
		getToolbarButton(screen, "Table").element().focus();
		await userEvent.keyboard("{Escape}");
		expect(editor.state.selection.toJSON()).toEqual(afterAbandoning);
	});

	it("does not consume Alt+F10 when the minimal editor has no Table control", async () => {
		const { editor } = await renderEditor({ minimal: true });
		const pm = editor.view.dom;
		pm.focus();
		const event = new KeyboardEvent("keydown", {
			altKey: true,
			key: "F10",
			bubbles: true,
			cancelable: true,
		});
		pm.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(pm);
	});

	it("restores the editor selection when the Table menu closes with Escape", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		const before = editor.state.selection.toJSON();
		await userEvent.keyboard("{Alt>}{F10}{/Alt}");
		await vi.waitFor(() => expect(getToolbarButton(screen, "Table").element()).toHaveFocus());
		await userEvent.keyboard("{Enter}");
		await expect.element(screen.getByRole("menu")).toBeVisible();

		await userEvent.keyboard("{Escape}");

		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		expect(editor.state.selection.toJSON()).toEqual(before);
	});

	it("restores the editor bookmark when the toolbar picker is cancelled", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().setTextSelection(getTextPosition(editor, "Hello world")).run();
		const before = editor.state.selection.toJSON();
		getToolbarButton(screen, "Table").element().click();
		const insert = screen.getByRole("menuitem", { name: "Insert table" });
		await expect.element(insert).toBeVisible();
		insert.element().click();
		const grid = screen.getByRole("grid", { name: "Table size" });
		await expect.element(grid).toBeVisible();

		await userEvent.keyboard("{Escape}");

		await expect.element(grid).not.toBeInTheDocument();
		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		expect(editor.state.selection.toJSON()).toEqual(before);
	});

	it.each([
		["menu", "editor"],
		["menu", "outside"],
		["picker", "editor"],
		["picker", "outside"],
	])("preserves newer focus after closing the %s in the %s", async (kind, destination) => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().setTextSelection(getTextPosition(editor, "Hello world")).run();
		if (kind === "menu") editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
		const before = editor.state.selection.toJSON();
		getToolbarButton(screen, "Table").element().click();
		await expect.element(screen.getByRole("menu")).toBeVisible();
		if (kind === "picker") screen.getByRole("menuitem", { name: "Insert table" }).element().click();
		const popup = screen.getByRole(kind === "menu" ? "menu" : "dialog");
		await expect.element(popup).toBeVisible();
		const animation = popup.element().animate({ opacity: [1, 1] }, { duration: 1000 });
		animation.pause();
		await userEvent.keyboard("{Escape}");
		const target =
			destination === "editor"
				? editor.view.dom
				: screen.container.appendChild(document.createElement("input"));
		await userEvent.click(
			kind === "menu" && destination === "editor"
				? editor.view.dom.querySelectorAll("td")[1]!
				: target,
		);
		const moved = editor.state.selection.toJSON();
		if (destination === "editor") expect(moved).not.toEqual(before);
		animation.finish();
		await expect.element(popup).not.toBeInTheDocument();
		expect(target).toHaveFocus();
		expect(editor.state.selection.toJSON()).toEqual(moved);
	});

	it("does not steal focus when the toolbar picker is dismissed outside", async () => {
		const { screen } = await renderEditor();
		const outside = document.body.appendChild(document.createElement("button"));
		outside.textContent = "Outside";
		outside.style.cssText = "position:fixed;inset-block-start:0;inset-inline-end:0;z-index:10001";
		try {
			getToolbarButton(screen, "Table").element().click();
			const insert = screen.getByRole("menuitem", { name: "Insert table" });
			await expect.element(insert).toBeVisible();
			insert.element().click();
			await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();
			await userEvent.click(outside);
			await expect
				.element(screen.getByRole("grid", { name: "Table size" }))
				.not.toBeInTheDocument();
			expect(outside).toHaveFocus();
		} finally {
			outside.remove();
		}
	});

	it("inserts the chosen toolbar table with a trailing paragraph", async () => {
		const { screen, editor } = await renderEditor();
		getToolbarButton(screen, "Table").element().click();
		const insert = screen.getByRole("menuitem", { name: "Insert table" });
		await expect.element(insert).toBeVisible();
		insert.element().click();
		await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();

		screen.getByRole("gridcell", { name: "2 × 3 table" }).element().click();

		const table = editor.state.doc.content.content.find(
			(node) => node.type.spec.tableRole === "table",
		)!;
		expect(TableMap.get(table)).toMatchObject({ width: 3, height: 2 });
		expect(table.firstChild?.firstChild?.type.spec.tableRole).toBe("header_cell");
		expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
	});

	it("runs live Table actions and announces only successful changes", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		getToolbarButton(screen, "Table").element().click();
		const merge = screen.getByRole("menuitem", { name: "Merge selected cells" });
		await expect.element(merge).toBeDisabled();
		const addRow = screen.getByRole("menuitem", { name: "Add row below" });
		addRow.element().click();

		await vi.waitFor(() =>
			expect(
				TableMap.get(editor.state.doc.content.content.find((node) => node.type.name === "table")!),
			).toMatchObject({ height: 3 }),
		);
		await expect.element(screen.getByRole("status")).toHaveTextContent("Row added below");
	});

	it("announces the first rectangular selection after a structural result", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		getToolbarButton(screen, "Table").element().click();
		const addRow = screen.getByRole("menuitem", { name: "Add row below" });
		await expect.element(addRow).toBeVisible();
		addRow.element().click();
		await expect.element(screen.getByRole("status")).toHaveTextContent("Row added below");
		const cells: number[] = [];
		editor.state.doc.descendants((node, position) => {
			if (node.type.spec.tableRole === "cell") cells.push(position);
		});
		editor.view.dispatch(
			editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0]!, cells[3]!)),
		);
		await expect
			.element(screen.getByRole("status"))
			.toHaveTextContent("2 rows × 2 columns selected");
	});

	it("announces a newly inserted paragraph before the table", async () => {
		const { screen, editor } = await renderEditor();
		editor
			.chain()
			.focus()
			.selectAll()
			.insertTable({ rows: 1, cols: 1, withHeaderRow: false })
			.run();
		getToolbarButton(screen, "Table").element().click();
		const action = screen.getByRole("menuitem", { name: "Insert paragraph before" });
		await expect.element(action).toBeVisible();
		action.element().click();
		await expect
			.element(screen.getByRole("status"))
			.toHaveTextContent("Paragraph inserted before table");
	});

	it("shows partial header state as visibly and accessibly mixed", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		const first = editor.state.doc.firstChild!.firstChild!.firstChild!;
		editor.view.dispatch(
			editor.state.tr.setNodeMarkup(2, editor.schema.nodes.tableHeader, first.attrs),
		);
		getToolbarButton(screen, "Table").element().click();
		const header = screen.getByRole("menuitemcheckbox", { name: /Toggle header row/ });

		await expect.element(header).toHaveAttribute("aria-checked", "mixed");
		await expect.element(header).toHaveTextContent("Mixed");
	});

	it("renders the link editor outside the horizontally scrolling toolbar", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			const input = document.querySelector<HTMLInputElement>('input[placeholder="https://..."]');
			expect(input).toBeTruthy();
			expect(toolbar.contains(input)).toBe(false);
		});
	});

	it("provides an independent block inserter for coarse pointers", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const touchInsert = toolbar.querySelector<HTMLButtonElement>("[data-touch-block-insert]");

		expect(touchInsert).toBeTruthy();
		expect(touchInsert?.className).toContain("pointer-coarse:flex");
		expect(touchInsert?.getAttribute("aria-label")).toBe("Insert block after current block");
		expect(touchInsert?.tabIndex).toBe(0);
		touchInsert?.click();
		await vi.waitFor(() => {
			expect(document.querySelector("body > div [data-index]")).toBeTruthy();
		});
	});

	it("includes the coarse-pointer inserter in toolbar arrow navigation when visible", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const touchInsert = toolbar.querySelector<HTMLButtonElement>("[data-touch-block-insert]")!;
		const bold = screen.getByRole("button", { name: "Bold" });
		touchInsert.style.display = "flex";
		bold.element().focus();

		await userEvent.keyboard("{ArrowLeft}");

		await vi.waitFor(() => expect(document.activeElement).toBe(touchInsert));
	});

	it("has history buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Undo" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Redo" })).toBeVisible();
	});

	it("does not include a Spotlight Mode button", async () => {
		const { screen } = await renderEditor();
		expect(screen.getByRole("button", { name: "Spotlight Mode" }).query()).toBeNull();
	});

	it("gives every fixed-toolbar control visible pointer-hover feedback", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button")];

		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) {
			expect(button.classList.contains("hover:bg-kumo-interact/50")).toBe(true);
		}
	});

	it("does not reopen a toolbar picker after a read-only transition", async () => {
		const { screen } = await renderEditor();
		getToolbarButton(screen, "Table").element().click();
		const insert = screen.getByRole("menuitem", { name: "Insert table" });
		await expect.element(insert).toBeVisible();
		insert.element().click();
		await expect.element(screen.getByRole("grid", { name: "Table size" })).toBeVisible();

		await screen.rerender(<PortableTextEditor value={defaultValue} editable={false} />);
		await expect.element(screen.getByRole("grid", { name: "Table size" })).not.toBeInTheDocument();
		await screen.rerender(<PortableTextEditor value={defaultValue} />);
		await expect.element(screen.getByRole("grid", { name: "Table size" })).not.toBeInTheDocument();
	});

	it("shows Kumo tooltips on pointer hover and keyboard focus", async () => {
		const { screen } = await renderEditor();
		const bold = getToolbarButton(screen, "Bold");

		await userEvent.hover(bold.element());
		await expect.element(screen.getByText("Bold")).toBeVisible();

		await userEvent.hover(document.body);
		await vi.waitFor(() => expect(screen.getByText("Bold").query()).toBeNull());

		const headings = getToolbarButton(screen, "Headings");
		headings.element().focus();
		await expect.element(screen.getByText("Headings")).toBeVisible();
	});

	it("hides toolbar when minimal={true}", async () => {
		const { screen } = await renderEditor({ minimal: true });
		const toolbar = screen.container.querySelector('[role="toolbar"]');
		expect(toolbar).toBeNull();
	});
});

// =============================================================================
// Block insertion
// =============================================================================

describe("Block insertion", () => {
	it("leaves content unchanged until an image is selected from the toolbar picker", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus("end");
		const before = editor.getJSON();

		getToolbarButton(screen, "Insert Image").element().click();
		await screen.getByRole("button", { name: "Cancel image picker" }).click();
		expect(editor.getJSON()).toEqual(before);

		getToolbarButton(screen, "Insert Image").element().click();
		await screen.getByRole("button", { name: "Choose test image" }).click();
		await vi.waitFor(() => {
			const image = editor.getJSON().content?.find((node) => node.type === "image");
			expect(image?.attrs).toMatchObject({
				src: "/diagram.png",
				alt: "Architecture diagram",
				mediaId: "image-1",
				provider: "local",
			});
		});
	});

	it("stores a canonical provider when inserting an external URL", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus("end");

		getToolbarButton(screen, "Insert Image").element().click();
		await screen.getByRole("button", { name: "Choose external image" }).click();

		await vi.waitFor(() => {
			const image = editor.getJSON().content?.find((node) => node.type === "image");
			expect(image?.attrs).toMatchObject({
				src: "https://media.example/remote.jpg",
				mediaId: "",
				provider: "external",
			});
		});
	});

	it("inserts an empty HTML block from the toolbar", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus("end");

		getToolbarButton(screen, "Insert HTML").element().click();

		await vi.waitFor(() => {
			const htmlBlock = editor.getJSON().content?.find((node) => node.type === "htmlBlock");
			expect(htmlBlock?.attrs?.html).toBe("");
		});
	});
});

// =============================================================================
// 2. Formatting Button Toggle States
// =============================================================================

describe("Formatting Button Toggle States", () => {
	it("shows existing bold formatting and clears the state for mixed or plain selections", async () => {
		const { screen, editor } = await renderEditor({
			value: [
				{
					_type: "block",
					_key: "1",
					style: "normal",
					children: [
						{ _type: "span", _key: "s1", text: "Bold", marks: ["strong"] },
						{ _type: "span", _key: "s2", text: " plain" },
					],
				},
			],
		});
		const bold = getToolbarButton(screen, "Bold").element();

		editor.chain().focus().setTextSelection({ from: 1, to: 5 }).run();
		await vi.waitFor(() => {
			expect(bold.getAttribute("aria-pressed")).toBe("true");
			expectVisibleActiveState(bold);
		});

		editor.chain().focus().setTextSelection({ from: 1, to: 11 }).run();
		await vi.waitFor(() => {
			expect(bold.getAttribute("aria-pressed")).toBe("false");
			expectNoVisibleActiveState(bold);
		});

		editor.chain().focus().setTextSelection({ from: 5, to: 11 }).run();
		await vi.waitFor(() => {
			expect(bold.getAttribute("aria-pressed")).toBe("false");
			expectNoVisibleActiveState(bold);
		});
	});

	it("Bold: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getToolbarButton(screen, "Bold");
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Italic: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getToolbarButton(screen, "Italic");
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Underline: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getToolbarButton(screen, "Underline");
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Strikethrough: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getToolbarButton(screen, "Strikethrough");
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Inline Code: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getToolbarButton(screen, "Inline Code");
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Heading 1: click changes to h1 without exposing toggle semantics", async () => {
		const { screen, editor } = await renderEditor();
		// Focus editor and place cursor (block commands need cursor in a paragraph)
		editor.commands.focus();

		const { trigger, item } = await getHeadingMenuItem(screen, "Heading 1");
		expect(trigger.element().hasAttribute("aria-pressed")).toBe(false);
		await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
		item.element().click();

		await vi.waitFor(() => {
			expect(trigger.element().hasAttribute("aria-pressed")).toBe(false);
			expect(editor.isActive("heading", { level: 1 })).toBe(true);
			expectVisibleActiveState(trigger.element());
		});
	});

	it("Heading 2: click changes to h2", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const { trigger, item } = await getHeadingMenuItem(screen, "Heading 2");
		item.element().click();

		await vi.waitFor(() => {
			expect(trigger.element().hasAttribute("aria-pressed")).toBe(false);
			expect(editor.isActive("heading", { level: 2 })).toBe(true);
		});
	});

	it("Heading 3: click changes to h3", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const { trigger, item } = await getHeadingMenuItem(screen, "Heading 3");
		item.element().click();

		await vi.waitFor(() => {
			expect(trigger.element().hasAttribute("aria-pressed")).toBe(false);
			expect(editor.isActive("heading", { level: 3 })).toBe(true);
		});
	});

	it("Heading 6: click changes to h6", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const { trigger, item } = await getHeadingMenuItem(screen, "Heading 6");
		item.element().click();

		await vi.waitFor(() => {
			expect(trigger.element().hasAttribute("aria-pressed")).toBe(false);
			expect(editor.isActive("heading", { level: 6 })).toBe(true);
		});
	});

	it("Bullet List: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Bullet List" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Numbered List: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Numbered List" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("continues or restarts the selected numbered-list segment in RTL", async () => {
		const previousDir = document.documentElement.dir;
		document.documentElement.dir = "rtl";
		try {
			const { screen, editor } = await renderEditor({
				value: [
					{
						_type: "block",
						_key: "one",
						style: "normal",
						listItem: "number",
						level: 1,
						listId: "first",
						listStart: 1,
						children: [{ _type: "span", _key: "s1", text: "One" }],
					},
					{
						_type: "block",
						_key: "between",
						style: "normal",
						children: [{ _type: "span", _key: "s2", text: "Between" }],
					},
					{
						_type: "block",
						_key: "independent",
						style: "normal",
						listItem: "number",
						level: 1,
						listId: "second",
						listStart: 1,
						children: [{ _type: "span", _key: "s3", text: "Independent" }],
					},
				],
			});
			editor.commands.setTextSelection(getTextPosition(editor, "Independent"));

			const continueButton = getToolbarButton(screen, "Continue numbering");
			const restartButton = getToolbarButton(screen, "Restart numbering");
			await expect.element(continueButton).toBeVisible();
			await expect.element(restartButton).toBeVisible();
			expect(continueButton.element().hasAttribute("disabled")).toBe(false);
			expect(restartButton.element().hasAttribute("disabled")).toBe(false);

			continueButton.element().click();
			await vi.waitFor(() => {
				const starts: number[] = [];
				editor.state.doc.descendants((node) => {
					if (node.type.name === "orderedList") starts.push(node.attrs.start);
				});
				expect(starts).toEqual([1, 2]);
				expect(continueButton.element().hasAttribute("disabled")).toBe(true);
			});
		} finally {
			document.documentElement.dir = previousDir;
		}
	});

	it("Quote: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Quote" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Code Block: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Code Block" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Toggle off: clicking Bold twice returns aria-pressed to false", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getToolbarButton(screen, "Bold");

		// First click: on
		btn.element().click();
		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});

		// Second click: off
		btn.element().click();
		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("false");
		});
	});
});

// =============================================================================
// 3. Text Alignment
// =============================================================================

describe("Text Alignment", () => {
	it("tracks default and explicit alignment whenever the cursor changes paragraphs", async () => {
		const { screen, editor } = await renderEditor({
			value: [
				{
					_type: "block",
					_key: "1",
					style: "normal",
					children: [{ _type: "span", _key: "s1", text: "Default left" }],
				},
				{
					_type: "block",
					_key: "2",
					style: "normal",
					textAlign: "center",
					children: [{ _type: "span", _key: "s2", text: "Centered" }],
				},
				{
					_type: "block",
					_key: "3",
					style: "normal",
					textAlign: "right",
					children: [{ _type: "span", _key: "s3", text: "Right aligned" }],
				},
			],
		});

		for (const [text, alignment] of [
			["Default left", "left"],
			["Centered", "center"],
			["Right aligned", "right"],
			["Default left", "left"],
		] as const) {
			editor.chain().focus().setTextSelection(getTextPosition(editor, text)).run();
			await vi.waitFor(() => expectAlignmentState(screen, alignment));
		}
	});

	it("treats unannotated headings, list paragraphs, and newly split empty blocks as left aligned", async () => {
		const { screen, editor } = await renderEditor({
			value: [
				{
					_type: "block",
					_key: "1",
					style: "h2",
					children: [{ _type: "span", _key: "s1", text: "A heading" }],
				},
				{
					_type: "block",
					_key: "2",
					style: "normal",
					listItem: "bullet",
					level: 1,
					children: [{ _type: "span", _key: "s2", text: "A list item" }],
				},
			],
		});

		for (const text of ["A heading", "A list item"]) {
			editor.chain().focus().setTextSelection(getTextPosition(editor, text)).run();
			await vi.waitFor(() => expectAlignmentState(screen, "left"));
		}

		const listPosition = getTextPosition(editor, "A list item") + "A list item".length;
		editor.chain().focus().setTextSelection(listPosition).splitBlock().run();
		await vi.waitFor(() => expectAlignmentState(screen, "left"));
	});

	it("reports a shared alignment for uniform multi-block selections and none for mixed selections", async () => {
		const { screen, editor } = await renderEditor({
			value: [
				{
					_type: "block",
					_key: "1",
					style: "normal",
					children: [{ _type: "span", _key: "s1", text: "Left one" }],
				},
				{
					_type: "block",
					_key: "2",
					style: "normal",
					children: [{ _type: "span", _key: "s2", text: "Left two" }],
				},
				{
					_type: "block",
					_key: "3",
					style: "normal",
					textAlign: "center",
					children: [{ _type: "span", _key: "s3", text: "Center three" }],
				},
			],
		});

		editor
			.chain()
			.focus()
			.setTextSelection({
				from: getTextPosition(editor, "Left one"),
				to: getTextPosition(editor, "Left two") + "Left two".length,
			})
			.run();
		await vi.waitFor(() => expectAlignmentState(screen, "left"));

		editor
			.chain()
			.focus()
			.setTextSelection({
				from: getTextPosition(editor, "Left two"),
				to: getTextPosition(editor, "Center three") + "Center three".length,
			})
			.run();
		await vi.waitFor(() => expectAlignmentState(screen, null));
	});

	it("updates an entire mixed selection and follows alignment undo and redo history", async () => {
		const { screen, editor } = await renderEditor({
			value: [
				{
					_type: "block",
					_key: "1",
					style: "normal",
					children: [{ _type: "span", _key: "s1", text: "Default block" }],
				},
				{
					_type: "block",
					_key: "2",
					style: "normal",
					textAlign: "center",
					children: [{ _type: "span", _key: "s2", text: "Centered block" }],
				},
			],
		});
		editor
			.chain()
			.focus()
			.setTextSelection({
				from: getTextPosition(editor, "Default block"),
				to: getTextPosition(editor, "Centered block") + "Centered block".length,
			})
			.run();
		await vi.waitFor(() => expectAlignmentState(screen, null));

		getToolbarButton(screen, "Align Right").element().click();
		await vi.waitFor(() => expectAlignmentState(screen, "right"));

		editor.commands.undo();
		await vi.waitFor(() => expectAlignmentState(screen, null));

		editor.commands.redo();
		await vi.waitFor(() => expectAlignmentState(screen, "right"));

		getToolbarButton(screen, "Align Left").element().click();
		await vi.waitFor(() => expectAlignmentState(screen, "left"));
	});

	it("shows no alignment for a selection containing no alignable text block", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().setTextSelection(1).toggleCodeBlock().run();

		await vi.waitFor(() => expectAlignmentState(screen, null));
	});

	it("resolves uniform and mixed table cell selections from their selected ranges", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();

		const cellPositions: number[] = [];
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === "tableCell") cellPositions.push(pos);
		});
		expect(cellPositions).toHaveLength(4);

		editor
			.chain()
			.focus()
			.setTextSelection(cellPositions[0]! + 2)
			.setCellAttribute("textAlign", "center")
			.run();
		editor.view.dispatch(
			editor.state.tr.setSelection(
				CellSelection.create(editor.state.doc, cellPositions[0]!, cellPositions[1]!),
			),
		);
		await vi.waitFor(() => expectMixedTableAlignmentState(screen, ["left", "center"]));

		editor.view.dispatch(
			editor.state.tr.setSelection(
				CellSelection.create(editor.state.doc, cellPositions[2]!, cellPositions[3]!),
			),
		);
		await vi.waitFor(() => expectAlignmentState(screen, "left"));
	});

	it("stores table alignment on cells and disables lossy block actions", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		const cellPositions: number[] = [];
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === "tableCell") cellPositions.push(pos);
		});
		editor
			.chain()
			.focus()
			.setTextSelection(cellPositions[0]! + 2)
			.run();

		getToolbarButton(screen, "Align Right").element().click();

		await vi.waitFor(() => {
			const cell = editor.state.doc.nodeAt(cellPositions[0]!);
			expect(cell?.attrs.textAlign).toBe("right");
			expect(cell?.firstChild?.attrs.textAlign).not.toBe("right");
		});
		for (const label of [
			"Bullet List",
			"Numbered List",
			"Quote",
			"Code Block",
			"Insert Image",
			"Insert HTML",
		]) {
			await expect.element(getToolbarButton(screen, label)).toBeDisabled();
		}
		await expect.element(screen.getByRole("button", { name: "Headings" })).toBeDisabled();
	});

	it("updates every cell when the first selected cell already has the requested alignment", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		const cellPositions: number[] = [];
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === "tableCell") cellPositions.push(pos);
		});
		const transaction = editor.state.tr;
		for (const [index, textAlign] of ["left", "right", "center", null].entries()) {
			const position = cellPositions[index]!;
			const cell = transaction.doc.nodeAt(position)!;
			transaction.setNodeMarkup(position, undefined, { ...cell.attrs, textAlign });
		}
		editor.view.dispatch(transaction);
		editor.view.dispatch(
			editor.state.tr.setSelection(
				CellSelection.create(editor.state.doc, cellPositions[0]!, cellPositions[1]!),
			),
		);
		await vi.waitFor(() => expectMixedTableAlignmentState(screen, ["left", "right"]));
		let documentTransactions = 0;
		editor.on("transaction", ({ transaction: change }) => {
			if (change.docChanged) documentTransactions++;
		});

		getToolbarButton(screen, "Align Left").element().click();

		await vi.waitFor(() => expectAlignmentState(screen, "left"));
		expect(
			cellPositions.map((position) => editor.state.doc.nodeAt(position)?.attrs.textAlign),
		).toEqual(["left", "left", "center", null]);
		expect(documentTransactions).toBe(1);

		expect(editor.commands.undo()).toBe(true);
		await vi.waitFor(() => expectMixedTableAlignmentState(screen, ["left", "right"]));
		expect(
			cellPositions.map((position) => editor.state.doc.nodeAt(position)?.attrs.textAlign),
		).toEqual(["left", "right", "center", null]);
	});

	it("disables cell alignment for a whole-table node selection", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		let tablePosition = -1;
		editor.state.doc.descendants((node, position) => {
			if (node.type.name === "table" && tablePosition === -1) tablePosition = position;
		});
		expect(tablePosition).toBeGreaterThanOrEqual(0);
		editor.view.dispatch(
			editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, tablePosition)),
		);
		const before = editor.getJSON();

		for (const label of ["Align Left", "Align Center", "Align Right"]) {
			const button = getToolbarButton(screen, label);
			await expect.element(button).toBeDisabled();
			expect(button.element().getAttribute("aria-pressed")).toBe("false");
			button.element().click();
		}
		expect(editor.getJSON()).toEqual(before);
	});

	it("disables lossy block and alignment actions when select-all includes a table", async () => {
		const { screen, editor } = await renderEditor();
		editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
		editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
		const before = editor.getJSON();

		for (const label of [
			"Bullet List",
			"Numbered List",
			"Quote",
			"Code Block",
			"Insert Image",
			"Insert HTML",
			"Align Left",
			"Align Center",
			"Align Right",
		]) {
			const button = getToolbarButton(screen, label);
			await expect.element(button).toBeDisabled();
			button.element().click();
		}
		await expect.element(screen.getByRole("button", { name: "Headings" })).toBeDisabled();
		editor.view.focus();
		const mod = navigator.platform.includes("Mac") ? "{Meta>}" : "{Control>}";
		const modUp = navigator.platform.includes("Mac") ? "{/Meta}" : "{/Control}";
		for (const shortcut of ["8", "b", "e"]) {
			await userEvent.keyboard(`${mod}{Shift>}${shortcut}{/Shift}${modUp}`);
			expect(editor.getJSON()).toEqual(before);
		}
		for (const shortcut of ["2", "c"]) {
			await userEvent.keyboard(`${mod}{Alt>}${shortcut}{/Alt}${modUp}`);
			expect(editor.getJSON()).toEqual(before);
		}
		expect(editor.getJSON()).toEqual(before);
		expect(editor.getJSON().content?.some((node) => node.type === "table")).toBe(true);
	});

	it.each(["forward", "backward"] as const)(
		"disables alignment for a %s selection crossing a table boundary",
		async (direction) => {
			const { screen, editor } = await renderEditor();
			editor.commands.setContent({
				type: "doc",
				content: [
					{
						type: "table",
						content: [
							{
								type: "tableRow",
								content: [
									{
										type: "tableCell",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "Cell" }],
											},
										],
									},
								],
							},
						],
					},
					{
						type: "paragraph",
						content: [{ type: "text", text: "After" }],
					},
				],
			});
			const cell = getTextPosition(editor, "Cell");
			const after = getTextPosition(editor, "After") + "After".length;
			editor.view.dispatch(
				editor.state.tr.setSelection(
					TextSelection.create(
						editor.state.doc,
						direction === "forward" ? cell : after,
						direction === "forward" ? after : cell,
					),
				),
			);

			for (const label of ["Align Left", "Align Center", "Align Right"]) {
				await expect.element(getToolbarButton(screen, label)).toBeDisabled();
			}
		},
	);

	it("uses the writing direction for unannotated text without masking explicit or unsupported alignment", async () => {
		const { screen, editor } = await renderEditor({
			value: [
				{
					_type: "block",
					_key: "1",
					style: "normal",
					children: [{ _type: "span", _key: "s1", text: "مرحبا بالعالم" }],
				},
				{
					_type: "block",
					_key: "2",
					style: "normal",
					textAlign: "left",
					children: [{ _type: "span", _key: "s2", text: "Explicit left" }],
				},
				{
					_type: "block",
					_key: "3",
					style: "normal",
					textAlign: "justify",
					children: [{ _type: "span", _key: "s3", text: "Justified" }],
				},
			],
		});
		expect(getComputedStyle(editor.view.dom).direction).toBe("rtl");

		editor.chain().focus().setTextSelection(getTextPosition(editor, "مرحبا بالعالم")).run();
		await vi.waitFor(() => expectAlignmentState(screen, "right"));

		editor.chain().focus().setTextSelection(getTextPosition(editor, "Explicit left")).run();
		await vi.waitFor(() => expectAlignmentState(screen, "left"));

		editor.chain().focus().setTextSelection(getTextPosition(editor, "Justified")).run();
		await vi.waitFor(() => expectAlignmentState(screen, null));
	});

	it("Align Center becomes pressed, Align Left becomes unpressed", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const alignLeft = screen.getByRole("button", { name: "Align Left" });
		const alignCenter = screen.getByRole("button", { name: "Align Center" });

		alignCenter.element().click();

		await vi.waitFor(() => {
			expect(alignCenter.element().getAttribute("aria-pressed")).toBe("true");
			expect(alignLeft.element().getAttribute("aria-pressed")).toBe("false");
		});
	});

	it("Align Right becomes pressed, others unpressed", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const alignLeft = screen.getByRole("button", { name: "Align Left" });
		const alignCenter = screen.getByRole("button", { name: "Align Center" });
		const alignRight = screen.getByRole("button", { name: "Align Right" });

		alignRight.element().click();

		await vi.waitFor(() => {
			expect(alignRight.element().getAttribute("aria-pressed")).toBe("true");
			expect(alignLeft.element().getAttribute("aria-pressed")).toBe("false");
			expect(alignCenter.element().getAttribute("aria-pressed")).toBe("false");
		});
	});

	it("Align Left becomes pressed after switching from another alignment", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const alignLeft = screen.getByRole("button", { name: "Align Left" });
		const alignRight = screen.getByRole("button", { name: "Align Right" });

		// First switch to right
		alignRight.element().click();
		await vi.waitFor(() => {
			expect(alignRight.element().getAttribute("aria-pressed")).toBe("true");
		});

		// Then switch back to left
		alignLeft.element().click();
		await vi.waitFor(() => {
			expect(alignLeft.element().getAttribute("aria-pressed")).toBe("true");
			expect(alignRight.element().getAttribute("aria-pressed")).toBe("false");
		});
	});
});

// =============================================================================
// 4. Undo/Redo
// =============================================================================

describe("Undo/Redo", () => {
	it("initially Undo and Redo are disabled", async () => {
		const { screen } = await renderEditor();

		const undo = screen.getByRole("button", { name: "Undo" });
		const redo = screen.getByRole("button", { name: "Redo" });

		await expect.element(undo).toBeDisabled();
		await expect.element(redo).toBeDisabled();
	});

	it("after making a change, Undo becomes enabled", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		// Make a change - toggle bold
		getToolbarButton(screen, "Bold").element().click();

		const undo = getToolbarButton(screen, "Undo");
		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
	});

	it("after undo, Redo becomes enabled", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		// Make a change
		getToolbarButton(screen, "Bold").element().click();

		const undo = getToolbarButton(screen, "Undo");
		const redo = getToolbarButton(screen, "Redo");

		// Wait for undo to be enabled, then click it
		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
		undo.element().click();

		await vi.waitFor(
			() => {
				expect(redo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
	});

	it("after redo, Undo is enabled and Redo is disabled", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		// Make a change
		getToolbarButton(screen, "Bold").element().click();

		const undo = getToolbarButton(screen, "Undo");
		const redo = getToolbarButton(screen, "Redo");

		// Undo
		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
		undo.element().click();

		// Redo
		await vi.waitFor(
			() => {
				expect(redo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
		redo.element().click();

		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
				expect(redo.element().disabled).toBe(true);
			},
			{ timeout: 3000 },
		);
	});
});

// =============================================================================
// 5. Link Insertion (Toolbar Popover)
// =============================================================================

describe("Link Insertion", () => {
	it("clicking Insert Link opens a popover with URL input", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const linkBtn = screen.getByRole("button", { name: "Insert Link" });
		linkBtn.element().click();

		await vi.waitFor(() => {
			const input = document.querySelector('input[type="url"]');
			expect(input).toBeTruthy();
		});
	});

	it("popover has Cancel and Apply buttons", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
		});
	});

	it("typing URL and clicking Apply sets the link", async () => {
		const { screen, editor } = await renderEditor();
		await focusAndSelectAll(screen);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(document.querySelector('input[type="url"]')).toBeTruthy();
		});

		const input = document.querySelector('input[type="url"]') as HTMLInputElement;
		// Focus input and type URL
		input.focus();
		// Use native input value setter to trigger React's onChange
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		nativeInputValueSetter.call(input, "https://example.com");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		screen.getByRole("button", { name: "Apply" }).element().click();

		await vi.waitFor(() => {
			expect(editor.isActive("link")).toBe(true);
			const link = getToolbarButton(screen, "Insert Link").element();
			expect(link.getAttribute("aria-pressed")).toBe("true");
			expectVisibleActiveState(link);
		});
	});

	it("clicking Cancel closes the popover", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(document.querySelector('input[type="url"]')).toBeTruthy();
		});

		screen.getByRole("button", { name: "Cancel" }).element().click();

		await vi.waitFor(() => {
			expect(document.querySelector('input[type="url"]')).toBeNull();
		});
	});

	it("Remove button appears when link already exists", async () => {
		const { screen, editor } = await renderEditor();
		await focusAndSelectAll(screen);

		// Set a link programmatically
		editor.chain().focus().setLink({ href: "https://example.com" }).run();

		await vi.waitFor(() => {
			expect(editor.isActive("link")).toBe(true);
		});

		// Re-select all to ensure cursor is in the link
		const mod = navigator.platform.includes("Mac") ? "{Meta>}" : "{Control>}";
		const modUp = navigator.platform.includes("Mac") ? "{/Meta}" : "{/Control}";
		await userEvent.keyboard(`${mod}{a}${modUp}`);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
		});
	});
});

// =============================================================================
// 7. WAI-ARIA Keyboard Navigation
// =============================================================================

describe("WAI-ARIA Keyboard Navigation", () => {
	it("ArrowRight from Bold moves focus to Italic", async () => {
		const { screen } = await renderEditor();

		const bold = screen.getByRole("button", { name: "Bold" });
		const italic = screen.getByRole("button", { name: "Italic" });

		// Focus the Bold button
		bold.element().focus();
		expect(document.activeElement).toBe(bold.element());

		// Press ArrowRight
		await userEvent.keyboard("{ArrowRight}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(italic.element());
		});
	});

	it("ArrowLeft from Italic moves focus to Bold", async () => {
		const { screen } = await renderEditor();

		const bold = screen.getByRole("button", { name: "Bold" });
		const italic = screen.getByRole("button", { name: "Italic" });

		// Focus the Italic button
		italic.element().focus();
		expect(document.activeElement).toBe(italic.element());

		// Press ArrowLeft
		await userEvent.keyboard("{ArrowLeft}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(bold.element());
		});
	});

	it("inverts horizontal arrow navigation in RTL", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const bold = screen.getByRole("button", { name: "Bold" });
		const italic = screen.getByRole("button", { name: "Italic" });
		toolbar.style.direction = "rtl";
		italic.element().focus();

		await userEvent.keyboard("{ArrowRight}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(bold.element());
		});
	});

	it("Home moves focus to first button", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const firstButton = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => !button.disabled && button.getClientRects().length > 0,
		)!;
		const alignCenter = screen.getByRole("button", { name: "Align Center" });

		// Focus a button in the middle
		alignCenter.element().focus();

		// Press Home
		await userEvent.keyboard("{Home}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(firstButton);
		});
	});

	it("End moves focus to last button", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].filter(
			(button) => !button.disabled && button.getClientRects().length > 0,
		);
		const bold = screen.getByRole("button", { name: "Bold" });

		// Focus the first button
		bold.element().focus();

		await userEvent.keyboard("{End}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(buttons.at(-1));
		});
	});

	it("ArrowRight wraps from last to first button", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].filter(
			(button) => !button.disabled && button.getClientRects().length > 0,
		);
		const firstButton = buttons[0]!;
		const lastButton = buttons.at(-1)!;

		// Focus the last button
		lastButton.focus();

		// Press ArrowRight - should wrap to first
		await userEvent.keyboard("{ArrowRight}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(firstButton);
		});
	});

	it("ArrowLeft wraps from first to last button", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar", { name: "Text formatting" }).element();
		const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].filter(
			(button) => !button.disabled && button.getClientRects().length > 0,
		);
		const firstButton = buttons[0]!;
		const lastButton = buttons.at(-1)!;

		// Focus the first button
		firstButton.focus();

		// Press ArrowLeft - should wrap to last
		await userEvent.keyboard("{ArrowLeft}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(lastButton);
		});
	});
});
